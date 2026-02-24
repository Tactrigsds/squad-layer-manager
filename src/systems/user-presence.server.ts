import { toAsyncGenerator, withAbortSignal } from '@/lib/async'
import * as MapUtils from '@/lib/map'
import * as Obj from '@/lib/object'
import * as CS from '@/models/context-shared'
import * as SLL from '@/models/shared-layer-list'
import * as UP from '@/models/user-presence'
import * as UPActions from '@/models/user-presence/actions'
import * as C from '@/server/context'
import { initModule } from '@/server/logger'
import { getOrpcBase } from '@/server/orpc-base'
import * as SharedLayerList from '@/systems/shared-layer-list.server'
import * as SquadServer from '@/systems/squad-server.server'
import * as WSSessionSys from '@/systems/ws-session.server'
import * as Rx from 'rxjs'

export type UserPresenceContext = {
	userPresence: {
		presence: UP.PresenceState
		update$: Rx.Subject<UP.PresenceBroadcast>
	}
}

export function getDefaultState(): UserPresenceContext['userPresence'] {
	return {
		presence: new Map(),
		update$: new Rx.Subject<UP.PresenceBroadcast>(),
	}
}

const module = initModule('user-presence')
let log!: CS.Logger
const orpcBase = getOrpcBase(module)

export function handlePresenceUpdate(
	ctx: C.SharedLayerList & C.UserPresence & C.User & C.WSSession,
	update: UP.PresenceUpdate,
) {
	if (update.wsClientId !== ctx.wsClientId) {
		log.warn('Received presence update from another client: %s, expected: %s', update.wsClientId, ctx.wsClientId)
		return
	}
	if (update.userId !== ctx.user.discordId) {
		log.warn('Received presence update from another user: %s, expected: %s', update.userId, ctx.user.discordId)
		return
	}
	const now = Date.now()
	if (update.changes.lastSeen && update.changes.lastSeen > now) {
		log.warn('Received presence update with invalid lastSeen: %s, patching to %s', update.changes.lastSeen, now)
		update.changes.lastSeen = now
	}

	const prevActivity = ctx.userPresence.presence.get(update.wsClientId)?.activityState
	const lockMutations: Map<string, string | null> = new Map()
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

		const itemIds = UP.itemsToLockForActivity(ctx.sharedList.session.list, update.changes.activityState)
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
		void SharedLayerList.sendUpdate(ctx, { code: 'locks-modified', mutations: Array.from(lockMutations.entries()) })
	}
	let clientPresence = ctx.userPresence.presence.get(update.wsClientId)
	if (!clientPresence) {
		clientPresence = UPActions.getClientPresenceDefaults(update.userId)
		ctx.userPresence.presence.set(update.wsClientId, clientPresence)
	}
	const modified = UP.updateClientPresence(clientPresence, update.changes)
	if (modified) {
		sendPresenceUpdate(ctx, {
			code: 'update',
			wsClientId: update.wsClientId,
			userId: update.userId,
			changes: update.changes,
		})
	}
}

export function cleanupActivityLocks(ctx: C.SharedLayerList, wsClientId: string) {
	const itemIds = MapUtils.revLookupAll(ctx.sharedList.itemLocks, wsClientId)
	if (itemIds.length > 0) {
		MapUtils.bulkDelete(ctx.sharedList.itemLocks, ...itemIds)
		void SharedLayerList.sendUpdate(ctx, { code: 'locks-modified', mutations: itemIds.map(id => [id, null]) })
	}
}

export function dispatchPresenceAction(ctx: C.SharedLayerList & C.UserPresence & C.User & C.WSSession, action: UPActions.Action) {
	let currentPresence = ctx.userPresence.presence.get(ctx.wsClientId)
	const actionInput: UPActions.ActionInput = {
		hasEdits: SLL.hasMutations(ctx.sharedList.session, ctx.user.discordId),
		prev: currentPresence,
	}
	if (!currentPresence) {
		currentPresence = UPActions.getClientPresenceDefaults(ctx.user.discordId)
		ctx.userPresence.presence.set(ctx.wsClientId, currentPresence)
	}
	const update = action(actionInput)
	UP.updateClientPresence(currentPresence, update)
	const extraOps = SLL.getOpsForActivityStateUpdate(
		ctx.sharedList.session,
		ctx.userPresence.presence,
		ctx.wsClientId,
		ctx.user.discordId,
		update,
	)
	if (extraOps) {
		SLL.applyOperations(ctx.sharedList.session, extraOps)
		void SharedLayerList.sendUpdate(ctx, {
			code: 'update-presence',
			wsClientId: ctx.wsClientId,
			userId: ctx.user.discordId,
			changes: update,
			fromServer: true,
			sideEffectOps: extraOps,
		})
	}
	sendPresenceUpdate(ctx, {
		code: 'update',
		wsClientId: ctx.wsClientId,
		userId: ctx.user.discordId,
		changes: update,
	})
}

export function sendPresenceUpdate(ctx: C.UserPresence, update: UP.PresenceBroadcast) {
	update = Obj.deepClone(update)
	ctx.userPresence.update$.next(update)
}

export const orpcRouter = {
	watchUpdates: orpcBase.handler(async function*({ context, signal }) {
		const updateForServer$ = SquadServer.selectedServerCtx$(context).pipe(
			Rx.switchMap(ctx => {
				const initial: UP.PresenceBroadcast = {
					code: 'init',
					presence: ctx.userPresence.presence,
				}
				const updates$ = ctx.userPresence.update$.pipe(
					Rx.observeOn(Rx.asyncScheduler),
				)
				return updates$.pipe(Rx.startWith(initial))
			}),
			withAbortSignal(signal!),
		)
		yield* toAsyncGenerator(updateForServer$)
	}),

	updatePresence: orpcBase
		.input(UP.PresenceUpdateSchema)
		.handler(async ({ context: _ctx, input }) => {
			const sliceCtx = SquadServer.resolveWsClientSliceCtx(_ctx)
			return handlePresenceUpdate(sliceCtx, input)
		}),
}

function getBaseCtx() {
	return C.initMutexStore(CS.init())
}

export function setup() {
	log = module.getLogger()

	Rx.interval(UP.DISPLAYED_AWAY_PRESENCE_WINDOW * 2).pipe(
		Rx.map(() => getBaseCtx()),
		C.durableSub('user-presence:clean-presence', { module }, async (ctx) => {
			let numCleaned = 0
			for (const slice of SquadServer.globalState.slices.values()) {
				const presenceState = slice.userPresence.presence
				for (const [wsClientId, presence] of Array.from(presenceState.entries())) {
					// we don't want to remove presence instances that still might have an away indicator
					const pastDisconnectTimeout = presence.lastSeen === null || (Date.now() - presence.lastSeen) > UP.DISPLAYED_AWAY_PRESENCE_WINDOW
					if (!WSSessionSys.wsSessions.has(wsClientId) && pastDisconnectTimeout && !slice.sharedList.session.editors.has(presence.userId)) {
						presenceState.delete(wsClientId)
						numCleaned++
					}
				}
			}

			log.info(`Cleaned ${numCleaned} stale presence sessions`)
			// no need to send these deletions to the client
		}),
	).subscribe()
}
