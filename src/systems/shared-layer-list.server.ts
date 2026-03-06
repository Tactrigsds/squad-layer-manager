import { toAsyncGenerator, withAbortSignal } from '@/lib/async'
import { withAcquired } from '@/lib/nodejs-reentrant-mutexes'
import * as Obj from '@/lib/object'
import * as RbSyncState from '@/lib/rollback-synced-state'
import { assertNever } from '@/lib/type-guards'
import * as CS from '@/models/context-shared'
import * as LL from '@/models/layer-list.models'
import type * as SS from '@/models/server-state.models'
import * as SLL from '@/models/shared-layer-list'
import * as UPActions from '@/models/user-presence/actions'
import * as RBAC from '@/rbac.models.ts'
import * as C from '@/server/context'
import * as DB from '@/server/db'
import { initModule } from '@/server/logger'
import { getOrpcBase } from '@/server/orpc-base'
import * as LayerQueue from '@/systems/layer-queue.server'
import * as Rbac from '@/systems/rbac.server'
import * as SquadServer from '@/systems/squad-server.server'
import * as UserPresence from '@/systems/user-presence.server'
import * as WSSessionSys from '@/systems/ws-session.server'
import * as Otel from '@opentelemetry/api'
import { Mutex } from 'async-mutex'
import * as Rx from 'rxjs'

export type SharedLayerListContext = {
	// right now this is just used for the layer queue context but when we implement a more general form of layer lists this may be the abstractionw we stick with
	sharedList: {
		session: RbSyncState.Server.Session<SLL.Operation, SLL.EditSession>
		update$: Rx.Subject<SLL.Update>
		sessionSeqId: SLL.SessionSequenceId

		// keeps track of what the expected state of the actual queue is
		queueSeqId: number

		mtx: Mutex

		itemLocks: SLL.ItemLocks
	}
}
const module = initModule('shared-layer-list')
let log!: CS.Logger
const orpcBase = getOrpcBase(module)

const sllServerReducer: RbSyncState.Reducer<SLL.Operation, SLL.EditSession> = (state, ops) => {
	const batchMutations = SLL.applyOperations(state, ops)
	state.mutations = SLL.mergeMutations(state.mutations, batchMutations)
	return state
}

export function applySessionOps(ctx: C.SharedLayerList, ops: SLL.Operation[]) {
	if (ops.length === 0) return
	ctx.sharedList.session = RbSyncState.Server.applyOps(ctx.sharedList.session, ops, sllServerReducer)
}

export function getDefaultState(serverState: SS.ServerState): SharedLayerListContext['sharedList'] {
	const editSession: SLL.EditSession = SLL.createNewSession(Obj.deepClone(serverState.layerQueue))

	return {
		session: RbSyncState.Server.initSession(editSession),
		update$: new Rx.Subject<SLL.Update>(),
		sessionSeqId: serverState.layerQueueSeqId,
		queueSeqId: serverState.layerQueueSeqId,
		itemLocks: new Map(),
		mtx: new Mutex(),
	}
}

export function setupInstance(ctx: C.Db & C.LayerQueue & C.SharedLayerList & C.UserPresence & C.ServerSliceCleanup) {
	const serverId = ctx.serverId

	void sendUpdate(ctx, { code: 'init', session: ctx.sharedList.session.state, sessionSeqId: 1 })
	ctx.cleanup.push(ctx.layerQueue.update$.subscribe(withAcquired(() => ctx.sharedList.mtx, async ([update, _ctx]) => {
		const ctx = SquadServer.resolveSliceCtx(_ctx, _ctx.serverId)
		if (update.state.layerQueueSeqId === ctx.sharedList.queueSeqId) return

		const prevSessionSeqId = ctx.sharedList.sessionSeqId

		const prevOps = ctx.sharedList.session.ops
		const newSession = SLL.createNewSession(update.state.layerQueue)
		ctx.sharedList.session = RbSyncState.Server.initSession(newSession)
		SLL.endAllEditing(ctx.userPresence.presence, newSession)
		ctx.sharedList.sessionSeqId++
		ctx.sharedList.queueSeqId = update.state.layerQueueSeqId
		ctx.sharedList.itemLocks = new Map()
		// all clients that receive session-updated will update themselves
		UPActions.applyToAll(ctx.userPresence.presence, prevOps, UPActions.editSessionChanged)
		void sendUpdate(ctx, {
			code: 'list-updated',
			list: newSession.list,
			sessionSeqId: prevSessionSeqId,
			newSessionSeqId: ctx.sharedList.sessionSeqId,
		})
	})))

	// -------- take editing user out of editing slot on disconnect --------
	ctx.cleanup.push(
		WSSessionSys.disconnect$.pipe(
			// just add a flat delay for disconnects to give the user time to reconnect in a differen session
			Rx.delay(UPActions.DISCONNECT_TIMEOUT),
			Rx.map(ctx => SquadServer.resolveSliceCtx(ctx, serverId)),
			C.durableSub('shared-layer-list:handle-user-disconnect', { module, mutexes: ctx => ctx.sharedList.mtx }, async (ctx) => {
				if (ctx.serverId !== serverId) return
				UserPresence.dispatchPresenceAction(ctx, UPActions.disconnectedTimeout)
				UserPresence.cleanupActivityLocks(ctx, ctx.wsClientId)
				C.setSpanStatus(Otel.SpanStatusCode.OK)
			}),
		).subscribe(),
	)
}

export const orpcRouter = {
	watchUpdates: orpcBase.handler(async function*({ context, signal }) {
		const updateForServer$ = SquadServer.selectedServerCtx$(context).pipe(
			Rx.switchMap(ctx => {
				const initial: SLL.Update = {
					code: 'init',
					session: ctx.sharedList.session.state,
					sessionSeqId: ctx.sharedList.sessionSeqId,
				}
				const updateForClient$ = ctx.sharedList.update$.pipe(
					// if we don't do this then the orpcWs breaks
					Rx.observeOn(Rx.asyncScheduler),
				)
				return updateForClient$.pipe(Rx.startWith(initial))
			}),
			withAbortSignal(signal!),
		)

		yield* toAsyncGenerator(updateForServer$)
	}),

	processUpdate: orpcBase
		.input(SLL.ClientUpdateSchema)
		.handler(async ({ context: _ctx, input }) => {
			const sliceCtx = SquadServer.resolveWsClientSliceCtx(_ctx)
			return await handleSllStateUpdate(sliceCtx, input)
		}),
}

const handleSllStateUpdate = C.spanOp(
	'handleSllStateUpdate',
	{ module, mutexes: (ctx) => ctx.sharedList.mtx },
	async (ctx: C.OrpcBase & C.ServerSlice, input: SLL.ClientUpdate) => {
		log.info('Processing update %o for %s', input, ctx.serverId)

		const authRes = await Rbac.tryDenyPermissionsForUser(ctx, RBAC.perm('queue:write'))
		if (authRes) return authRes
		if (input.sessionSeqId !== ctx.sharedList.sessionSeqId) {
			const msg = `Outdated session seq id ${input.sessionSeqId} for ${ctx.serverId} (expected ${ctx.sharedList.sessionSeqId})`
			log.warn(msg)
			return {
				code: 'err:outdated-session-id' as const,
				msg,
			}
		}

		switch (input.code) {
			case 'op': {
				ctx.sharedList.session = RbSyncState.Server.applyOps(ctx.sharedList.session, [input.op], sllServerReducer)
				log.info('Applied operation %o:%s', input.op, input.op.opId)
				if (
					input.op.op === 'finish-editing'
					&& (input.op.forceSave || ctx.sharedList.session.state.editors.size === 0 && SLL.hasMutations(ctx.sharedList.session.state))
				) {
					await commitChanges(ctx, input)
					return
				} else {
					void sendUpdate(ctx, input)
				}
				break
			}

			case 'commit': {
				await commitChanges(ctx, input)
				break
			}

			case 'reset': {
				const serverState = await SquadServer.getServerState(ctx)
				const prevOps = ctx.sharedList.session.ops
				const newSession = SLL.createNewSession(serverState.layerQueue)
				ctx.sharedList.session = RbSyncState.Server.initSession(newSession)
				const prevSessionSeqId = ctx.sharedList.sessionSeqId
				ctx.sharedList.sessionSeqId++
				ctx.sharedList.itemLocks = new Map()

				// all clients that receive reset-completed will update themselves
				UPActions.applyToAll(ctx.userPresence.presence, prevOps, UPActions.editSessionChanged)
				void sendUpdate(ctx, {
					code: 'reset-completed',
					list: newSession.list,
					sessionSeqId: prevSessionSeqId,
					newSessionSeqId: ctx.sharedList.sessionSeqId,
					initiator: ctx.user.username,
				})

				break
			}

			default:
				assertNever(input)
		}
	},
)

async function commitChanges(
	ctx: C.Db & C.SharedLayerList & C.UserPresence & C.User & C.LayerQueue & C.SquadServer & C.Vote & C.MatchHistory & C.Rcon,
	input: SLL.ClientUpdate,
) {
	void sendUpdate(ctx, {
		code: 'commit-started',
	})
	await DB.runTransaction(ctx, async (ctx) => {
		let serverState = await SquadServer.getServerState(ctx)
		if (serverState.layerQueueSeqId !== ctx.sharedList.queueSeqId) {
			return {
				code: 'err:outdated-queue-id' as const,
				msg: `Outdated queue seq id ${serverState.layerQueueSeqId} for ${ctx.serverId} (expected ${ctx.sharedList.queueSeqId})`,
			}
		}
		if (ctx.sharedList.sessionSeqId !== input.sessionSeqId) {
			return {
				code: 'err:outdated-session-id' as const,
				msg: `Outdated session seq id ${ctx.sharedList.sessionSeqId} for ${ctx.serverId} (expected ${input.sessionSeqId})`,
			}
		}
		const sessionSeqId = input.sessionSeqId
		const res = await LayerQueue.updateQueue({
			ctx,
			input: { layerQueue: ctx.sharedList.session.state.list, layerQueueSeqId: serverState.layerQueueSeqId },
		})
		if (res.code === 'ok') {
			serverState = res.update
			const prevOps = ctx.sharedList.session.ops
			const newSession = SLL.createNewSession(serverState.layerQueue)
			ctx.sharedList.session = RbSyncState.Server.initSession(newSession)
			ctx.sharedList.queueSeqId = serverState.layerQueueSeqId
			ctx.sharedList.sessionSeqId++
			ctx.sharedList.itemLocks = new Map()
			UPActions.applyToAll(ctx.userPresence.presence, prevOps, UPActions.editSessionChanged)
			void sendUpdate(ctx, {
				code: 'commit-completed',
				list: newSession.list,
				committer: ctx.user,
				sessionSeqId: sessionSeqId,
				newSessionSeqId: ctx.sharedList.sessionSeqId,
				initiator: ctx.user.username,
			})
			SLL.endAllEditing(ctx.userPresence.presence, newSession)
		} else {
			void sendUpdate(ctx, {
				code: 'commit-rejected',
				msg: res.msg,
				reason: res.code,
				committer: ctx.user,
				sessionSeqId: sessionSeqId,
			})
		}
	})
}

// send a shared layer list update on unlock with fresh references
export async function sendUpdate(ctx: C.SharedLayerList, update: SLL.Update) {
	update = Obj.deepClone(update)
	ctx.sharedList.update$.next(update)
}

export function setup() {
	log = module.getLogger()
	UserPresence.setup()
}

// suppress unused import warnings — used transitively
void LL
void CS
