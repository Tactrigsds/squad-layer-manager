// One ODSM session per filter entity, provisioned on demand. There are far more filters than anyone edits at
// once, so a session exists only while at least one client is watching it (plus a short grace period), and its
// unsaved draft dies with it.
import * as Orpc from '@orpc/server'
import { Mutex } from 'async-mutex'
import { z } from 'zod'

import * as Arr from '@/lib/array-utils'
import { IsolatedSubject } from '@/lib/isolated-subject'
import * as Obj from '@/lib/object-utils'
import * as ODSM from '@/lib/odsm'
import * as Rx from '@/lib/rxjs'
import { assertNever } from '@/lib/type-guards'
import type * as CS from '@/models/context-shared'
import * as FE from '@/models/filter-edit.models'
import * as F from '@/models/filter.models'
import * as ATTRS from '@/models/otel-attrs'
import type * as USR from '@/models/users.models'
import * as RBAC from '@/rbac.models'
import type * as C from '@/server/context'
import * as Instr from '@/server/instrumentation'
import { initModule } from '@/server/logger'
import { getOrpcBase } from '@/server/orpc-base'
import * as CleanupSys from '@/systems/cleanup.server'
import * as FilterEntitySys from '@/systems/filter-entity.server'
import * as Rbac from '@/systems/rbac.server'
import * as UserPresenceSys from '@/systems/user-presence.server'

const module = initModule('filter-edit')
let log!: CS.Logger
const orpcBase = getOrpcBase(module)

// A session outlives its last watcher by this long, so a reload or a navigation between two filter pages
// doesn't throw away a draft the user is still working on.
const IDLE_TEARDOWN_DELAY = 30_000

type Session = {
	payload: FE.Ctx.Payload
	watchers: number
	idleTimer?: ReturnType<typeof setTimeout>
	sub: Rx.Subscription
}

const sessions = new Map<F.FilterEntityId, Session>()

// takes a reference to the filter's session, creating it if this is the first one. Returns null when the
// filter doesn't exist, which is the only way provisioning fails.
function acquire(filterId: F.FilterEntityId): Session | null {
	const existing = sessions.get(filterId)
	if (existing) {
		if (existing.idleTimer) {
			clearTimeout(existing.idleTimer)
			existing.idleTimer = undefined
		}
		existing.watchers++
		return existing
	}

	const entity = FilterEntitySys.state.filters.get(filterId)
	if (!entity) return null

	const payload: FE.Ctx.Payload = {
		filterId,
		session: ODSM.Server.initSession(FE.initState(entity)),
		op$: new IsolatedSubject<ODSM.Server.Dispatched<FE.Op, FE.Rejection>>(),
		dispatchMtx: new Mutex(),
	}
	// nobody is left to commit the draft, and the next editor would inherit edits they never made
	const sub = UserPresenceSys.editingFilterAbandoned$(filterId).subscribe(() => {
		void payload.dispatchMtx
			.runExclusive(() => applyAndBroadcast(payload, [{ code: 'discard-abandoned-edits', opId: FE.createOpId() }]))
			.catch((error) => log.error(error, 'failed to discard abandoned filter edits'))
	})
	const session: Session = { payload, watchers: 1, sub }
	sessions.set(filterId, session)
	log.info({ [ATTRS.Filter.ID]: filterId }, 'provisioned filter edit session %s', filterId)
	return session
}

function release(filterId: F.FilterEntityId) {
	const session = sessions.get(filterId)
	if (!session) return
	session.watchers--
	if (session.watchers > 0) return
	session.idleTimer = setTimeout(() => destroy(filterId), IDLE_TEARDOWN_DELAY)
}

function destroy(filterId: F.FilterEntityId) {
	const session = sessions.get(filterId)
	if (!session) return
	sessions.delete(filterId)
	if (session.idleTimer) clearTimeout(session.idleTimer)
	session.sub.unsubscribe()
	session.payload.op$.complete()
	log.info({ [ATTRS.Filter.ID]: filterId }, 'tore down filter edit session %s', filterId)
}

export const orpcRouter = {
	// Subscribing is what provisions the session, so the route loader can warm one by opening this stream
	// early; the last unsubscribe (plus the grace period) is what tears it down again.
	watchUpdates: orpcBase
		.meta({ logLevel: 'trace' })
		.input(F.FilterEntityIdSchema)
		.handler(async function* ({ context, signal, input: filterId }) {
			const update$ = Rx.defer(() => {
				const session = acquire(filterId)
				if (!session) {
					return Rx.throwError(() => new Orpc.ORPCError('NOT_FOUND', { message: `filter ${filterId} does not exist` }))
				}
				const init: FE.Update = {
					code: 'init',
					state: Obj.deepClone(session.payload.session.state),
					ops: Obj.deepClone(session.payload.session.ops),
				}
				return session.payload.op$.pipe(
					Rx.map((dispatched) => ODSM.Server.toClientUpdate(dispatched, context.wsClientId)),
					Rx.filter((update): update is NonNullable<typeof update> => update !== null),
					Rx.startWith(init),
					Rx.finalize(() => release(filterId)),
				)
			}).pipe(Rx.Ext.withAbortSignal(signal!))
			yield* Rx.Ext.toAsyncGenerator(update$)
		}),

	dispatchOps: orpcBase
		.meta({ type: 'mutation', logLevel: 'debug' })
		.input(z.object({ filterId: F.FilterEntityIdSchema, ops: z.array(FE.OpSchema) }))
		.handler(async ({ context: ctx, input }) => {
			const session = sessions.get(input.filterId)
			// the client dispatches against a session it is watching, so there is nothing sensible to apply to
			if (!session) return { code: 'err:no-session' as const }

			const denyRes = await Rbac.tryDenyPermissionsForUser(ctx, RBAC.getWritePermReqForFilterEntity(input.filterId))
			if (denyRes) return denyRes

			for (const op of input.ops) {
				if (!Arr.includesEnum(FE.CLIENT_OP_CODE.options, op.code)) {
					return { code: 'err:invalid-op:non-client' as const, msg: 'Tried to use non-client op code: ' + op.code }
				}
				if (!('userId' in op) || op.userId !== ctx.user.discordId) {
					return { code: 'err:invalid-op:different-user' as const, msg: 'Tried to dispatch a filter op as another user' }
				}
			}

			return await dispatchOps({ ...ctx, filterEdit: session.payload }, input.ops, { sourceWsClientId: ctx.wsClientId })
		}),
}

type DispatchCtx = FE.Ctx & C.Db & USR.Ctx.Id & CS.AbortSignal

// applies a batch to the authoritative session and routes the outcome to the watching clients. A rejected
// batch moved nothing, and only the originator hears about it (see ODSM.Server.toClientUpdate).
function applyAndBroadcast(payload: FE.Ctx.Payload, ops: FE.Op[], opts?: { sourceWsClientId?: string }) {
	const applied = ODSM.Server.applyOps(payload.session, ops, FE.reducer)
	payload.session = applied.session
	if (applied.rejected) {
		payload.op$.next({ ops, ...opts, rejection: applied.error.data as FE.Rejection })
	} else {
		payload.op$.next({ ops, ...opts })
	}
	return applied
}

const dispatchOps = Instr.spanOp(
	'dispatchOps',
	{
		module,
		mutexes: (ctx: DispatchCtx) => ctx.filterEdit.dispatchMtx,
		attrs: (ctx: DispatchCtx, ops: FE.Op[]) => ({
			[ATTRS.Filter.ID]: ctx.filterEdit.filterId,
			[ATTRS.Filter.EDIT_OP_CODES]: ops.map((o) => o.code).join(','),
		}),
		extraText: (ctx: DispatchCtx, ops: FE.Op[]) => ops.map((o) => o.code).join(','),
	},
	async (ctx: DispatchCtx, ops: FE.Op[], opts?: { sourceWsClientId?: string }) => {
		const applied = applyAndBroadcast(ctx.filterEdit, ops, opts)
		if (applied.rejected) {
			const rejection = applied.error.data as FE.Rejection
			if (rejection.code !== 'noop') log.warn({ [ATTRS.Filter.EDIT_OP_CODES]: rejection.op.code }, 'filter edit op skipped')
			return { code: 'err:rejected' as const, reason: rejection.code }
		}
		for (const se of applied.sideEffects) {
			const res = await handleSideEffect(ctx, se)
			if (res) return res
		}
		return { code: 'ok' as const }
	},
)

// only a failure the dispatching client has to hear about is returned; everything else is handled here
async function handleSideEffect(ctx: DispatchCtx, se: FE.SideEffect) {
	switch (se.code) {
		case 'op-outcome':
			return undefined
		case 'request-filter-save': {
			// the reducer already moved every replica's saved baseline, so a refused write leaves them
			// believing the save landed. The client blocks the cases it can see (an invalid tree is rejected by
			// the reducer, a reference cycle disables the button), and the next successful save reconciles the rest.
			const res = await FilterEntitySys.updateFilter(ctx, se.filterId, { ...se.meta, filter: se.filter as F.FilterNode })
			if (res.code !== 'ok') {
				log.error({ [ATTRS.Filter.ID]: se.filterId, [ATTRS.Filter.OUTCOME]: res.code }, 'shared filter draft failed to save')
				return res
			}
			UserPresenceSys.dispatchEndAllFilterEditing(se.filterId)
			return undefined
		}
		default:
			assertNever(se)
	}
}

export function setup() {
	log = module.getLogger()

	// a deleted filter has no draft to hold and nowhere to be present
	const mutationSub = FilterEntitySys.filterMutation$.subscribe(([, mutation]) => {
		if (mutation.type !== 'delete') return
		destroy(mutation.key)
		UserPresenceSys.dispatchFilterRemoved(mutation.key)
	})

	CleanupSys.register(() => {
		mutationSub.unsubscribe()
		for (const filterId of [...sessions.keys()]) destroy(filterId)
	})
}
