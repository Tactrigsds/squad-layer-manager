import { toAsyncGenerator, withAbortSignal } from '@/lib/async'
import * as MapUtils from '@/lib/map'
import { withAcquired } from '@/lib/nodejs-reentrant-mutexes'
import * as Obj from '@/lib/object'
import { assertNever } from '@/lib/type-guards'
import type * as CS from '@/models/context-shared'
import type * as LL from '@/models/layer-list.models'
import type * as SS from '@/models/server-state.models'
import * as SLL from '@/models/shared-layer-list'
import * as PresenceActions from '@/models/shared-layer-list/presence-actions'
import * as RBAC from '@/rbac.models.ts'
import * as C from '@/server/context'
import * as DB from '@/server/db'
import { baseLogger } from '@/server/logger.ts'
import orpcBase from '@/server/orpc-base'
import * as LayerQueue from '@/server/systems/layer-queue'
import * as Rbac from '@/server/systems/rbac'
import * as SquadServer from '@/server/systems/squad-server'
import * as WSSessionSys from '@/server/systems/ws-session.ts'
import * as Otel from '@opentelemetry/api'
import { Mutex } from 'async-mutex'
import * as Rx from 'rxjs'

export type SharedLayerListContext = {
	// right now this is just used for the layer queue context but when we implement a more general form of layer lists this may be the abstractionw we stick with
	sharedList: {
		session: SLL.EditSession
		update$: Rx.Subject<SLL.Update>
		sessionSeqId: SLL.SessionSequenceId

		// keeps track of what the expected state of the actual queue is
		queueSeqId: number

		mtx: Mutex

		presence: SLL.PresenceState
		itemLocks: SLL.ItemLocks
	}
}
const tracer = Otel.trace.getTracer('shared-layer-list')

export function getDefaultState(serverState: SS.ServerState): SharedLayerListContext['sharedList'] {
	const editSession: SLL.EditSession = SLL.createNewSession(Obj.deepClone(serverState.layerQueue))

	return {
		session: editSession,
		presence: new Map(),
		update$: new Rx.Subject<SLL.Update>(),
		sessionSeqId: serverState.layerQueueSeqId,
		queueSeqId: serverState.layerQueueSeqId,
		itemLocks: new Map(),
		mtx: new Mutex(),
	}
}

export function setupInstance(ctx: CS.Log & C.Db & C.LayerQueue & C.SharedLayerList & C.ServerSliceCleanup) {
	const editSession = ctx.sharedList.session
	const presence = ctx.sharedList.presence
	const serverId = ctx.serverId

	void sendUpdate(ctx, { code: 'init', session: editSession, presence, sessionSeqId: 1 })
	ctx.cleanup.push(ctx.layerQueue.update$.subscribe(withAcquired(() => ctx.sharedList.mtx, async ([update, _ctx]) => {
		const ctx = SquadServer.resolveSliceCtx(_ctx, _ctx.serverId)
		if (update.state.layerQueueSeqId === ctx.sharedList.queueSeqId) return

		const session = ctx.sharedList.session
		const sessionSeqId = ctx.sharedList.sessionSeqId

		SLL.applyListUpdate(session, update.state.layerQueue)
		SLL.endAllEditing(ctx.sharedList.presence)
		ctx.sharedList.sessionSeqId++
		ctx.sharedList.queueSeqId = update.state.layerQueueSeqId
		ctx.sharedList.itemLocks = new Map()
		// all clients that receive list-updated will update themselves
		PresenceActions.applyToAll(ctx.sharedList.presence, ctx.sharedList.session, PresenceActions.editSessionChanged)
		void sendUpdate(ctx, {
			code: 'list-updated',
			list: ctx.sharedList.session.list,
			sessionSeqId,
			newSessionSeqId: ctx.sharedList.sessionSeqId,
		})
	})))

	// -------- take editing user out of editing slot on disconnect --------
	ctx.cleanup.push(
		WSSessionSys.disconnect$.pipe(
			// just add a flat delay for disconnects to give the user time to reconnect in a differen session
			Rx.delay(PresenceActions.DISCONNECT_TIMEOUT),
			Rx.map(ctx => SquadServer.resolveSliceCtx(ctx, serverId)),
			C.durableSub('shared-layer-list:handle-user-disconnect', { ctx, tracer, mutexes: ctx => ctx.sharedList.mtx }, async (ctx) => {
				dispatchPresenceAction(ctx, PresenceActions.disconnectedTimeout)
				cleanupActivityLocks(ctx, ctx.wsClientId)
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
					session: ctx.sharedList.session!,
					presence: ctx.sharedList.presence,
					sessionSeqId: ctx.sharedList.sessionSeqId,
				}
				const updateForClient$ = ctx.sharedList.update$.pipe(
					// if we don't do this then the orpcWs breaks
					Rx.observeOn(Rx.asyncScheduler),
					Rx.filter(update => update.code !== 'update-presence' || update.fromServer || update.wsClientId !== context.wsClientId),
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
			if (input.code === 'update-presence') return handlePresenceUpdate(sliceCtx, input)
			return await handleSllStateUpdate(sliceCtx, input)
		}),
}

const handleSllStateUpdate = C.spanOp(
	'shared-layer-list:handle-sll-state-update',
	{ tracer, mutexes: (ctx) => ctx.sharedList.mtx },
	async (ctx: C.OrpcBase & C.ServerSlice, input: Exclude<SLL.ClientUpdate, { code: 'update-presence' }>) => {
		ctx.log.info('Processing update %o for %s', input, ctx.serverId)

		const authRes = await Rbac.tryDenyPermissionsForUser(ctx, RBAC.perm('queue:write'))
		if (authRes) return authRes
		const editSession = ctx.sharedList.session
		if (input.sessionSeqId !== ctx.sharedList.sessionSeqId) {
			const msg = `Outdated session seq id ${input.sessionSeqId} for ${ctx.serverId} (expected ${ctx.sharedList.sessionSeqId})`
			ctx.log.warn(msg)
			return {
				code: 'err:outdated-session-id' as const,
				msg,
			}
		}

		switch (input.code) {
			case 'op': {
				if (editSession.ops.length < input.expectedIndex) throw new Error('Invalid index')
				SLL.applyOperations(editSession, [input.op])
				ctx.log.info('Applied operation %o:%s', input.op, input.op.opId)
				void sendUpdate(ctx, input)
				break
			}

			case 'commit': {
				void DB.runTransaction(ctx, async (ctx) => {
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
						input: { layerQueue: ctx.sharedList.session.list, layerQueueSeqId: serverState.layerQueueSeqId },
					})
					if (res.code === 'ok') {
						serverState = res.update
						SLL.applyListUpdate(ctx.sharedList.session, serverState.layerQueue)
						ctx.sharedList.queueSeqId = serverState.layerQueueSeqId
						ctx.sharedList.sessionSeqId++
						ctx.sharedList.itemLocks = new Map()
						PresenceActions.applyToAll(ctx.sharedList.presence, ctx.sharedList.session, PresenceActions.editSessionChanged)
						void sendUpdate(ctx, {
							code: 'commit-completed',
							list: ctx.sharedList.session.list,
							committer: ctx.user,
							sessionSeqId: sessionSeqId,
							newSessionSeqId: ctx.sharedList.sessionSeqId,
							initiator: ctx.user.username,
						})
						SLL.endAllEditing(ctx.sharedList.presence)
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
				break
			}

			case 'reset': {
				const serverState = await SquadServer.getServerState(ctx)
				SLL.applyListUpdate(ctx.sharedList.session, serverState.layerQueue)
				const sessionSeqId = ctx.sharedList.sessionSeqId
				ctx.sharedList.sessionSeqId++
				ctx.sharedList.itemLocks = new Map()

				// all clients that receive reset-completed will update themselves
				PresenceActions.applyToAll(ctx.sharedList.presence, ctx.sharedList.session, PresenceActions.editSessionChanged)
				void sendUpdate(ctx, {
					code: 'reset-completed',
					list: ctx.sharedList.session.list,
					sessionSeqId,
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

function handlePresenceUpdate(
	ctx: C.SharedLayerList & CS.Log & C.User & C.WSSession,
	update: Extract<SLL.ClientUpdate, { code: 'update-presence' }>,
) {
	if (update.wsClientId !== ctx.wsClientId) {
		ctx.log.warn('Received presence update from another client: %s, expected: %s', update.wsClientId, ctx.wsClientId)
		return
	}
	if (update.userId !== ctx.user.discordId) {
		ctx.log.warn('Received presence update from another user: %s, expected: %s', update.userId, ctx.user.discordId)
		return
	}
	if (update.changes.lastSeen && update.changes.lastSeen > Date.now()) {
		ctx.log.warn('Received presence update with invalid lastSeen: %s', update.changes.lastSeen)
		return
	}

	const prevActivity = ctx.sharedList.presence.get(update.wsClientId)?.activityState
	const lockMutations: Map<LL.ItemId, string | null> = new Map()
	if (
		prevActivity && (update.changes === null || update.changes.activityState === null)
	) {
		const itemIds = MapUtils.revLookupAll(ctx.sharedList.itemLocks, update.wsClientId)
		for (const itemId of itemIds) {
			lockMutations.set(itemId, null)
		}
	} else if (update.changes?.activityState) {
		const existingItemIds = MapUtils.revLookupAll(ctx.sharedList.itemLocks, update.wsClientId)
		for (const itemId of existingItemIds) {
			lockMutations.set(itemId, null)
		}

		const itemIds = SLL.itemsToLockForActivity(ctx.sharedList.session.list, update.changes.activityState)
		if (itemIds.length > 0) {
			if (SLL.anyLocksInaccessible(ctx.sharedList.itemLocks, itemIds, ctx.wsClientId)) {
				return { code: 'err:locked' as const, msg: 'Failed to acquire all locks' }
			}
			for (const itemId of itemIds) {
				lockMutations.set(itemId, ctx.wsClientId)
			}
		}
	}

	if (lockMutations.size > 0) {
		for (const [itemId, wsClientId] of lockMutations.entries()) {
			if (wsClientId === null) ctx.sharedList.itemLocks.delete(itemId)
			else ctx.sharedList.itemLocks.set(itemId, wsClientId)
		}
		void sendUpdate(ctx, { code: 'locks-modified', mutations: Array.from(lockMutations.entries()) })
	}
	let clientPresence = ctx.sharedList.presence.get(update.wsClientId)
	if (!clientPresence) {
		clientPresence = SLL.getClientPresenceDefaults(update.userId)
		ctx.sharedList.presence.set(update.wsClientId, clientPresence)
	}
	const modified = SLL.updateClientPresence(clientPresence, update.changes)
	if (modified) void sendUpdate(ctx, { ...update, changes: update.changes })
}

function cleanupActivityLocks(ctx: C.SharedLayerList, wsClientId: string) {
	const itemIds = MapUtils.revLookupAll(ctx.sharedList.itemLocks, wsClientId)
	if (itemIds.length > 0) {
		MapUtils.bulkDelete(ctx.sharedList.itemLocks, ...itemIds)
		void sendUpdate(ctx, { code: 'locks-modified', mutations: itemIds.map(id => [id, null]) })
	}
}

// send a shared layer list update on unlock with fresh references
export async function sendUpdate(ctx: C.SharedLayerList, update: SLL.Update) {
	update = Obj.deepClone(update)
	ctx.sharedList.update$.next(update)
}

function getBaseCtx() {
	return C.initMutexStore({ log: baseLogger })
}

function dispatchPresenceAction(ctx: C.SharedLayerList & C.User & C.WSSession, action: PresenceActions.Action) {
	let currentPresence = ctx.sharedList.presence.get(ctx.wsClientId)
	const actionInput: PresenceActions.ActionInput = {
		hasEdits: SLL.checkUserHasEdits(ctx.sharedList.session, ctx.user.discordId),
		prev: currentPresence,
	}
	if (!currentPresence) {
		currentPresence = SLL.getClientPresenceDefaults(ctx.user.discordId)
		ctx.sharedList.presence.set(ctx.wsClientId, currentPresence)
	}
	const update = action(actionInput)
	SLL.updateClientPresence(currentPresence, update)
	void sendUpdate(ctx, {
		code: 'update-presence',
		wsClientId: ctx.wsClientId,
		userId: ctx.user.discordId,
		changes: action(actionInput),
		fromServer: true,
	})
}

export function setup() {
	const ctx = getBaseCtx()
	Rx.interval(SLL.DISPLAYED_AWAY_PRESENCE_WINDOW * 2).pipe(
		Rx.map(() => getBaseCtx()),
		C.durableSub('shared-layer-list:clean-presence', { tracer, ctx }, async (ctx) => {
			let numCleaned = 0
			for (const slice of SquadServer.globalState.slices.values()) {
				const presenceState = slice.sharedList.presence
				for (const [wsClientId, presence] of Array.from(presenceState.entries())) {
					// we don't want to remove presence instances that still might have an away indicator
					const pastDisconnectTimeout = (Date.now() - presence.lastSeen) > SLL.DISPLAYED_AWAY_PRESENCE_WINDOW
					if (!WSSessionSys.wsSessions.has(wsClientId) && pastDisconnectTimeout) {
						presenceState.delete(wsClientId)
						numCleaned++
					}
				}
			}

			ctx.log.info(`Cleaned ${numCleaned} stale presence sessions`)
			// no need to send these deletions to the client. would be flabbergasted if a client stayed idle with no other sources of resets for it to matter
		}),
	).subscribe()
}
