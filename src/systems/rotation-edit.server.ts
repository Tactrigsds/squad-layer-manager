// One shared draft per rotation, provisioned while someone is watching it. The draft is the queue's own list session
// (SLL), so the rotation editor runs the queue's list editor and its ops unchanged. Only the item ops and the
// save/discard ops are accepted from clients; a save writes the rotation's items (see Rotation.updateRotation).
import * as Orpc from '@orpc/server'
import { Mutex } from 'async-mutex'

import { IsolatedSubject } from '@/lib/isolated-subject'
import * as Obj from '@/lib/object-utils'
import * as ODSM from '@/lib/odsm'
import * as Rx from '@/lib/rxjs'
import { z } from '@/lib/zod'
import type * as AppEvents from '@/models/app-events.models'
import type * as CS from '@/models/context-shared.models'
import type * as LL from '@/models/layer-list.models'
import * as ROT from '@/models/rotations.models'
import * as SLL from '@/models/shared-layer-list.models'
import type * as USR from '@/models/users.models'
import type * as C from '@/server/context'
import * as Instr from '@/server/instrumentation'
import { initModule } from '@/server/logger'
import { getOrpcBase } from '@/server/orpc-base'
import * as CleanupSys from '@/systems/cleanup.server'
import * as Rotation from '@/systems/rotation.server'
import * as UserPresence from '@/systems/user-presence.server'

const module = initModule('rotation-edit')
let log!: CS.Logger
const orpcBase = getOrpcBase(module)

// A session outlives its last watcher by this long, so a reload doesn't throw away a draft still being worked on.
const IDLE_TEARDOWN_DELAY = 30_000

const CLIENT_OPCODES = new Set<SLL.OpCode>([
	'add',
	'move',
	'swap-factions',
	'edit-layer',
	'add-tag',
	'remove-tag',
	'add-note',
	'edit-note',
	'delete-note',
	'clone',
	'configure-vote',
	'delete',
	'clear',
	'save',
	'reset-to-saved',
	'revert',
])

type Payload = {
	rotationId: ROT.RotationId
	session: ODSM.Server.Session<SLL.Operation, SLL.State>
	op$: IsolatedSubject<ODSM.Server.Dispatched<SLL.Operation, SLL.Rejection>>
	dispatchMtx: Mutex
}

type Session = {
	payload: Payload
	watchers: number
	idleTimer?: ReturnType<typeof setTimeout>
	sub: Rx.Subscription
}

const sessions = new Map<ROT.RotationId, Session>()
const loading = new Map<ROT.RotationId, Promise<Session | null>>()

// the rotation's session, provisioned from the saved rotation if it has none. A session nothing attaches to is torn
// down like one whose last watcher left.
function getOrLoad(ctx: C.Db, rotationId: ROT.RotationId): Promise<Session | null> {
	const existing = sessions.get(rotationId)
	if (existing) return Promise.resolve(existing)
	let load = loading.get(rotationId)
	if (!load) {
		load = provision(ctx, rotationId).finally(() => loading.delete(rotationId))
		loading.set(rotationId, load)
	}
	return load
}

function attach(session: Session) {
	if (session.idleTimer) {
		clearTimeout(session.idleTimer)
		session.idleTimer = undefined
	}
	session.watchers++
}

async function provision(ctx: C.Db, rotationId: ROT.RotationId): Promise<Session | null> {
	const rotation = Rotation.getRotation(ctx, rotationId)
	if (!rotation) return null
	const payload: Payload = {
		rotationId,
		session: ODSM.Server.initSession(SLL.createNewState(rotation.items, [], { generateWhenEmpty: false })),
		op$: new IsolatedSubject(),
		dispatchMtx: new Mutex(),
	}
	// nobody is left to commit the draft, and the next editor would inherit edits they never made
	const sub = UserPresence.editingRotationAbandoned$(rotationId).subscribe(() => {
		void payload.dispatchMtx
			.runExclusive(() => applyAndBroadcast(payload, [{ op: 'discard-abandoned-queue-edits', opId: SLL.createOpId() }]))
			.catch((error) => log.error(error, 'failed to discard abandoned rotation edits'))
	})
	const session: Session = { payload, watchers: 0, sub }
	session.idleTimer = setTimeout(() => destroy(rotationId), IDLE_TEARDOWN_DELAY)
	sessions.set(rotationId, session)
	log.info('provisioned rotation edit session %s', rotationId)
	return session
}

function release(session: Session) {
	if (sessions.get(session.payload.rotationId) !== session) return
	session.watchers--
	if (session.watchers > 0) return
	session.idleTimer = setTimeout(() => destroy(session.payload.rotationId), IDLE_TEARDOWN_DELAY)
}

function destroy(rotationId: ROT.RotationId) {
	const session = sessions.get(rotationId)
	if (!session) return
	sessions.delete(rotationId)
	if (session.idleTimer) clearTimeout(session.idleTimer)
	session.sub.unsubscribe()
	session.payload.op$.complete()
	log.info('tore down rotation edit session %s', rotationId)
}

function applyAndBroadcast(payload: Payload, ops: SLL.Operation[], opts?: { sourceWsClientId?: string }) {
	const applied = ODSM.Server.applyOps(payload.session, ops, SLL.reducer)
	payload.session = applied.session
	if (applied.rejected) {
		payload.op$.next({ ops, ...opts, rejection: applied.error.data as SLL.Rejection })
	} else {
		payload.op$.next({ ops, ...opts })
	}
	return applied
}

type DispatchCtx = C.Db & USR.Ctx.Id & CS.AbortSignal & { rotationEdit: Payload }

const dispatchOp = Instr.spanOp(
	'dispatchOp',
	{
		module,
		mutexes: (ctx: DispatchCtx) => ctx.rotationEdit.dispatchMtx,
		extraText: (_ctx: DispatchCtx, op: SLL.Operation) => op.op,
	},
	async (ctx: DispatchCtx, op: SLL.Operation, opts?: { sourceWsClientId?: string }) => {
		const applied = applyAndBroadcast(ctx.rotationEdit, [op], opts)
		if (applied.rejected) {
			const rejection = applied.error.data as SLL.Rejection
			log.warn('rotation edit op %s rejected: %s', op.op, rejection.code)
			return { code: 'err:rejected' as const, reason: rejection.code }
		}
		const rotationId = ctx.rotationEdit.rotationId
		for (const se of applied.sideEffects) {
			if (se.code === 'request-list-save') {
				const res = Rotation.updateRotation(ctx, rotationId, { items: se.list }, { type: 'slm-user', userId: ctx.user.discordId })
				applyAndBroadcast(ctx.rotationEdit, [{ op: 'save-completed', opId: SLL.createOpId() }])
				if (res.code !== 'ok') {
					log.error('rotation %s draft failed to save: %s', rotationId, res.code)
					return res
				}
				UserPresence.dispatchEndAllRotationEditing(rotationId)
			} else if (se.code === 'edit-window-closed') {
				UserPresence.dispatchEndAllRotationEditing(rotationId)
			}
		}
		return { code: 'ok' as const }
	},
)

// A write from outside the editor, as a plugin makes one. While a draft is open, new items are saved through the draft so
// its editors see them, and a draft with unsaved edits refuses them rather than discard an admin's work.
export async function updateOutsideDraft(
	ctx: C.Db & CS.AbortSignal,
	rotationId: ROT.RotationId,
	patch: ROT.UpdatePatch,
	actor: AppEvents.Actor,
	source: LL.Source,
) {
	const { items, ...meta } = patch
	const session = items ? sessions.get(rotationId) : undefined
	if (!items || !session) return Rotation.updateRotation(ctx, rotationId, patch, actor)
	const payload = session.payload
	return await payload.dispatchMtx.runExclusive(async () => {
		const state = payload.session.state
		if (SLL.hasMutations(state)) return { code: 'err:unsaved-edits' as const }
		const opBase = { source, editWindowSeqId: state.editWindowSeqId }
		const applied = applyAndBroadcast(payload, [
			{
				op: 'add',
				opId: SLL.createOpId(),
				...opBase,
				items,
				index: { outerIndex: 0, innerIndex: null },
				clearItemIds: state.list.map((item) => item.itemId),
			},
			{ op: 'save', opId: SLL.createOpId(), ...opBase },
		])
		if (applied.rejected) return { code: 'err:rejected' as const, reason: (applied.error.data as SLL.Rejection).code }
		const save = applied.sideEffects.find((se) => se.code === 'request-list-save')
		const res = Rotation.updateRotation(ctx, rotationId, save ? { ...meta, items: save.list } : meta, actor)
		if (save) applyAndBroadcast(payload, [{ op: 'save-completed', opId: SLL.createOpId() }])
		UserPresence.dispatchEndAllRotationEditing(rotationId)
		return res
	})
}

export const orpcRouter = {
	// subscribing provisions the session; the last unsubscribe (plus the grace period) tears it down
	watchOps: orpcBase
		.meta({ logLevel: 'trace' })
		.input(z.object({ rotationId: ROT.RotationIdSchema }))
		.handler(async function* ({ context, signal, input }) {
			const update$ = Rx.defer(() => {
				// attaching and releasing both happen synchronously in this closure, so an unsubscribe while the session
				// loads never leaves it attached
				let attached: Session | null = null
				let closed = false
				const session$ = Rx.from(
					getOrLoad(context, input.rotationId).then((session) => {
						if (session && !closed) {
							attach(session)
							attached = session
						}
						return session
					}),
				)
				return session$.pipe(
					Rx.switchMap((session) => {
						if (!session) {
							return Rx.throwError(() => new Orpc.ORPCError('NOT_FOUND', { message: `rotation ${input.rotationId} does not exist` }))
						}
						const init: SLL.Update = {
							code: 'init',
							state: Obj.deepClone(session.payload.session.state),
							ops: Obj.deepClone(session.payload.session.ops),
						}
						return session.payload.op$.pipe(
							Rx.map((dispatched) => ODSM.Server.toClientUpdate(dispatched, context.wsClientId)),
							Rx.filter((update): update is NonNullable<typeof update> => update !== null),
							Rx.startWith(init),
							// if we don't do this then the orpcWs breaks
							Rx.observeOn(Rx.asyncScheduler),
						)
					}),
					Rx.finalize(() => {
						closed = true
						if (attached) release(attached)
					}),
				)
			}).pipe(Rx.Ext.withAbortSignal(signal!))
			yield* Rx.Ext.toAsyncGenerator(update$)
		}),

	dispatchOp: orpcBase
		.meta({ type: 'mutation' })
		.input(z.object({ rotationId: ROT.RotationIdSchema, op: SLL.OperationSchema }))
		.handler(async ({ context: ctx, input: { rotationId, op } }) => {
			const session = sessions.get(rotationId)
			if (!session) return { code: 'err:no-session' as const }
			if (!CLIENT_OPCODES.has(op.op)) return { code: 'err:invalid-op' as const, msg: `${op.op} cannot be applied to a rotation` }
			const userId = (op as { userId?: USR.UserId }).userId
			if (userId !== undefined && userId !== ctx.user.discordId) {
				return { code: 'err:invalid-user' as const, msg: `Invalid user ${userId} for operation ${op.op} (${op.opId})` }
			}
			// the op joins the shared draft here, so a save finishes, and sends save-completed, even if this request is gone
			return await dispatchOp({ ...ctx, signal: CleanupSys.shutdownSignal, rotationEdit: session.payload }, op, {
				sourceWsClientId: ctx.wsClientId,
			})
		}),
}

export function setup() {
	log = module.getLogger()
	// a deleted rotation has no draft to hold and nowhere to be present
	const mutationSub = Rotation.rotationMutation$.subscribe(([, mutation]) => {
		if (mutation.type !== 'delete') return
		destroy(mutation.key)
		UserPresence.dispatchRotationRemoved(mutation.key)
	})
	CleanupSys.register(() => {
		mutationSub.unsubscribe()
		for (const rotationId of [...sessions.keys()]) destroy(rotationId)
	})
}
