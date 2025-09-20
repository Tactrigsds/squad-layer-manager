import * as Schema from '$root/drizzle/schema.ts'
import { acquireReentrant, distinctDeepEquals, sleep, toAsyncGenerator, toCold, withAbortSignal } from '@/lib/async.ts'
import * as DH from '@/lib/display-helpers.ts'
import { superjsonify, unsuperjsonify } from '@/lib/drizzle'
import * as Obj from '@/lib/object'
import { assertNever } from '@/lib/type-guards.ts'
import { Parts } from '@/lib/types'
import { HumanTime } from '@/lib/zod.ts'
import * as Messages from '@/messages.ts'
import * as BAL from '@/models/balance-triggers.models.ts'
import * as CS from '@/models/context-shared'
import * as L from '@/models/layer'
import * as LL from '@/models/layer-list.models'
import * as LQY from '@/models/layer-queries.models.ts'
import * as MH from '@/models/match-history.models'
import * as SS from '@/models/server-state.models'
import * as SM from '@/models/squad.models.ts'
import * as USR from '@/models/users.models'
import * as V from '@/models/vote.models.ts'
import * as RBAC from '@/rbac.models.ts'
import { CONFIG } from '@/server/config.ts'
import * as C from '@/server/context'
import * as DB from '@/server/db.ts'
import { baseLogger } from '@/server/logger.ts'
import * as FilterEntity from '@/server/systems/filter-entity.ts'
import * as LayerQueriesServer from '@/server/systems/layer-queries.server.ts'
import * as MatchHistory from '@/server/systems/match-history.ts'
import * as Rbac from '@/server/systems/rbac.system.ts'
import * as SquadServer from '@/server/systems/squad-server'
import * as WSSessionSys from '@/server/systems/ws-session.ts'
import * as LayerQueries from '@/systems.shared/layer-queries.shared.ts'
import * as Otel from '@opentelemetry/api'
import { Mutex } from 'async-mutex'
import * as dateFns from 'date-fns'
import * as E from 'drizzle-orm/expressions'
import deepEqual from 'fast-deep-equal'
import * as Rx from 'rxjs'
import { z } from 'zod'
import { procedure, router } from '../trpc.server.ts'

export const serverStateUpdate$ = new Rx.ReplaySubject<[SS.LQServerStateUpdate, CS.Log & C.Db]>()
export const serverStateUpdateWithParts$ = serverStateUpdate$.pipe(
	Rx.concatMap(async ([update, ctx]) => includeLQServerUpdateParts(ctx, update)),
	Rx.shareReplay(1),
)

let voteEndTask: Rx.Subscription | null = null
let voteState: V.VoteState | null = null
let unexpectedNextLayerSet$!: Rx.BehaviorSubject<[CS.Log & C.Db, L.LayerId | null]>

let serverRolling = false

const voteStateUpdate$ = new Rx.Subject<[CS.Log & C.Db, V.VoteStateUpdate]>()

let userPresence: USR.UserPresenceState = {}
const userPresenceUpdate$ = new Rx.Subject<USR.UserPresenceStateUpdate & Parts<USR.UserPart>>()

let postRollEventsSub: Rx.Subscription | undefined

let autostartVoteSub: Rx.Subscription | undefined

const voteStateMtx = new Mutex()

const tracer = Otel.trace.getTracer('layer-queue')
export const setup = C.spanOp('layer-queue:setup', { tracer, eventLogLevel: 'info' }, async () => {
	const log = baseLogger
	const ctx = C.initLocks(DB.addPooledDb({ log }))
	ctx.log.info('setting up layer queue and server state')

	// -------- bring server up to date with configuration --------
	await DB.runTransaction(ctx, async (_ctx) => {
		using ctx = await acquireReentrant(_ctx, voteStateMtx)
		let [server] = await ctx.db().select().from(Schema.servers).where(E.eq(Schema.servers.id, CONFIG.serverId)).for('update')
		server = server ? (unsuperjsonify(Schema.servers, server) as typeof server) : server
		if (!server) {
			await ctx.db().insert(Schema.servers).values({
				id: CONFIG.serverId,
				displayName: CONFIG.serverDisplayName,
			})
			;[server] = await ctx.db().select().from(Schema.servers).where(E.eq(Schema.servers.id, CONFIG.serverId))
			server = server ? (unsuperjsonify(Schema.servers, server) as typeof server) : server
		}

		const initialServerState = SS.ServerStateSchema.parse(server)
		ctx.log.info('initial server state parsed')

		if (initialServerState.displayName !== CONFIG.serverDisplayName) {
			await ctx
				.db()
				.update(Schema.servers)
				.set({
					displayName: CONFIG.serverDisplayName,
				})
				.where(E.eq(Schema.servers.id, CONFIG.serverId))
			initialServerState.displayName = CONFIG.serverDisplayName
		}

		// -------- prune main pool filters when filter entities are deleted  --------
		let mainPoolFilterIds = initialServerState.settings.queue.mainPool.filters
		const filters = await ctx.db().select().from(Schema.filters).where(E.inArray(Schema.filters.id, mainPoolFilterIds)).for('update')
		mainPoolFilterIds = mainPoolFilterIds.filter(id => filters.some(filter => filter.id === id))
		initialServerState.settings.queue.mainPool.filters = mainPoolFilterIds

		serverStateUpdate$.next([{ state: initialServerState, source: { type: 'system', event: 'app-startup' } }, ctx])

		// -------- initialize vote state --------
		await syncVoteStateWithQueueStateInPlace(ctx, [], initialServerState.layerQueue)
		ctx.log.info('vote state initialized')
	})
	ctx.log.info('initial update complete')

	// -------- log vote state updates --------
	voteStateUpdate$.subscribe(([ctx, update]) => {
		ctx.log.info('Vote state updated : %s : %s : %s', update.source.type, update.source.event, update.state?.code ?? null)
	})

	// -------- set next layer on server when rcon is connected--------
	SquadServer.rcon.core.connected$.pipe(
		C.durableSub('layer-queue:set-next-layer-on-connected', { ctx, tracer, eventLogLevel: 'info' }, async (isConnected) => {
			if (!isConnected) return
			const oldServerState = await getServerState(ctx)
			const newServerState = Obj.deepClone(oldServerState)
			await syncNextLayerInPlace(ctx, newServerState)
			await syncVoteStateWithQueueStateInPlace(ctx, oldServerState.layerQueue, newServerState.layerQueue)
			C.setSpanStatus(Otel.SpanStatusCode.OK)
		}),
	).subscribe()

	serverStateUpdate$.subscribe(([state, ctx]) => {
		ctx.log.debug({ seqId: state.state.layerQueueSeqId }, 'pushing server state update')
	})

	// -------- schedule generic admin reminders --------
	Rx.interval(CONFIG.reminders.adminQueueReminderInterval).pipe(
		C.durableSub('layer-queue:queue-reminders', { ctx, tracer }, async () => {
			const serverState = await getServerState(ctx)
			const currentMatch = MatchHistory.getCurrentMatch()
			if (serverRolling || currentMatch.status === 'post-game') return
			if (
				LL.isParentVoteItem(serverState.layerQueue[0])
				&& voteState?.code === 'ready'
				&& serverState.lastRoll
				&& serverState.lastRoll.getTime() + CONFIG.reminders.startVoteReminderThreshold < Date.now()
			) {
				await SquadServer.warnAllAdmins(ctx, Messages.WARNS.queue.votePending)
			} else if (serverState.layerQueue.length === 0) {
				await SquadServer.warnAllAdmins(ctx, Messages.WARNS.queue.empty)
			}
		}),
	).subscribe()

	// -------- when SLM is not able to set a layer on the server, notify admins.
	unexpectedNextLayerSet$ = new Rx.BehaviorSubject<[CS.Log & C.Db, L.LayerId | null]>([ctx, null])
	unexpectedNextLayerSet$
		.pipe(
			Rx.switchMap(([ctx, unexpectedNextLayer]) => {
				if (unexpectedNextLayer) {
					return Rx.interval(HumanTime.parse('2m')).pipe(
						Rx.startWith(0),
						Rx.map(() => [ctx, unexpectedNextLayer] as [CS.Log & C.Db, L.LayerId]),
					)
				}
				return Rx.EMPTY
			}),
			C.durableSub('layer-queue:notify-unexpected-next-layer', { tracer, ctx }, async ([ctx, expectedNextLayerId]) => {
				const serverState = await getServerState(ctx)
				const expectedLayerName = DH.toFullLayerNameFromId(LL.getNextLayerId(serverState.layerQueue)!)
				const actualLayerName = DH.toFullLayerNameFromId(expectedNextLayerId)
				await SquadServer.warnAllAdmins(
					ctx,
					`Current next layer on the server is out-of-sync with queue. Got ${actualLayerName}, but expected ${expectedLayerName}`,
				)
			}),
		).subscribe()

	// -------- Interpret current/next layer updates from the game server for the purposes of syncing it with the queue  --------
	SquadServer.rcon.layersStatus
		.observe(ctx)
		.pipe(
			Rx.filter((statusRes) => statusRes.code === 'ok'),
			Rx.map((statusRes): LayerStatus => ({ currentLayer: statusRes.data.currentLayer, nextLayer: statusRes.data.nextLayer })),
			distinctDeepEquals(),
			Rx.scan((withPrev, status): LayerStatusWithPrev => [status, withPrev[0]], [null, null] as LayerStatusWithPrev),
			C.durableSub('layer-queue:check-layer-status-change', {
				ctx,
				tracer,
				root: true,
				attrs: ([status, prevStatus]) => ({ status, prevStatus }),
			}, async ([status, prevStatus]) => {
				if (!status) return
				await DB.runTransaction(ctx, (ctx) => processLayerStatusChange(ctx, status, prevStatus))
			}),
		)
		.subscribe()

	// -------- take editing user out of editing slot on disconnect --------
	WSSessionSys.disconnect$.pipe(
		C.durableSub('layer-queue:handle-user-disconnect', { ctx, tracer }, async (disconnectedCtx) => {
			if (userPresence.editState && userPresence.editState.wsClientId === disconnectedCtx.wsClientId) {
				delete userPresence.editState
				userPresenceUpdate$.next({ event: 'edit-end', state: userPresence, parts: { users: [] } })
			}
			C.setSpanStatus(Otel.SpanStatusCode.OK)
		}),
	).subscribe()

	// -------- trim pool filters when filter entities are deleted --------
	FilterEntity.filterMutation$
		.pipe(
			Rx.filter(([_, mut]) => mut.type === 'delete'),
			C.durableSub('layer-queue:handle-filter-delete', { ctx, tracer, taskScheduling: 'parallel' }, async ([ctx, mutation]) => {
				const updatedServerState = await DB.runTransaction(ctx, async (ctx) => {
					const serverState = await getServerState(ctx)
					const remainingFilterIds = serverState.settings.queue.mainPool.filters.filter(f => f !== mutation.key)
					if (remainingFilterIds.length === serverState.settings.queue.mainPool.filters.length) return null
					serverState.settings.queue.mainPool.filters = remainingFilterIds
					await ctx.db().update(Schema.servers).set({ settings: serverState.settings }).where(E.eq(Schema.servers.id, serverState.id))

					return serverState
				})

				if (!updatedServerState) return

				serverStateUpdate$.next([{ state: updatedServerState, source: { type: 'system', event: 'filter-delete' } }, ctx])
			}),
		).subscribe()
})

// -------- status change logic --------
type LayerStatus = { currentLayer: L.UnvalidatedLayer; nextLayer: L.UnvalidatedLayer | null }
type LayerStatusWithPrev = [LayerStatus | null, LayerStatus | null]

/**
 * Determines how to respond to the current layer potentially having been set on the gameserver.
 * noop in most cases but  if we don't have at least one player in the server then we may have to act here instead
 */
function checkForCurrentLayerChangeActions(
	status: LayerStatus,
	prevStatus: LayerStatus | null,
	lqServerState: SS.LQServerState,
	serverInfo: Pick<SM.ServerInfo, 'playerCount'>,
) {
	if (prevStatus != null && !deepEqual(status.currentLayer, prevStatus.currentLayer)) {
		if (serverInfo.playerCount > 0) return { code: 'current-layer-changed-with-players:set-server-rolling' as const }
		const lqNextLayerId = LL.getNextLayerId(lqServerState.layerQueue)

		const code = 'current-layer-changed-with-no-players:handle-new-game' as const
		if (lqNextLayerId && L.areLayersCompatible(status.currentLayer, lqNextLayerId)) {
			return { code, nextLayerLqItem: lqServerState.layerQueue[0] }
		}
		// if playerCount is zero then we can't rely on NEW_GAME being fired, so we need to push the match history here instead
		return { code }
	}
}

/**
 * Determines how to respond to the next layer potentially having been set on the gameserver, bringing it out of sync with the queue
 */
function checkForNextLayerStatusActions(
	status: LayerStatus,
	serverState: SS.LQServerState,
	serverRolling: boolean,
) {
	if (serverState.settings.updatesToSquadServerDisabled) return { code: 'sync-disabled:no-action' as const }

	// if server is rolling, then the layer queue will be updated when NEW_GAME is fired
	if (serverRolling) return { code: 'server-rolling:no-action' as const }

	if (status.nextLayer === null) return { code: 'null-layer-set:reset' as const }

	const lqNextLayerId = LL.getNextLayerId(serverState.layerQueue)
	if (!lqNextLayerId) return { code: 'no-next-layer-set:no-action' as const }
	if (L.areLayersCompatible(status.nextLayer, lqNextLayerId)) return { code: 'correct-layer-set:no-action' as const }
	return { code: 'unexpected-next-layer:reset' as const, expectedNextLayerId: lqNextLayerId }
}

export async function handleNewGame(ctx: C.Db & C.Locks, eventTime: Date) {
	const status = await Rx.firstValueFrom(
		SquadServer.rcon.layersStatus.observe(ctx, { ttl: 1_000 }).pipe(
			Rx.concatMap(v => v.code === 'ok' ? Rx.of(v.data) : Rx.EMPTY),
			Rx.retry(),
			Rx.takeUntil(Rx.of(1).pipe(Rx.delay(60_000))),
		),
	)
	const res = await DB.runTransaction(ctx, async (ctx) => {
		const serverState = await getServerState(ctx)
		const nextLqItem = serverState.layerQueue[0]

		let currentMatchLqItem: LL.LayerListItem | undefined
		const newServerState = Obj.deepClone(serverState)
		newServerState.lastRoll = new Date()
		if (nextLqItem && L.areLayersCompatible(nextLqItem.layerId, status.currentLayer.id)) {
			currentMatchLqItem = newServerState.layerQueue.shift()
		}

		await MatchHistory.addNewCurrentMatch(
			ctx,
			MH.getNewMatchHistoryEntry({
				layerId: status.currentLayer.id,
				startTime: eventTime,
				lqItem: currentMatchLqItem,
			}),
		)
		await syncNextLayerInPlace(ctx, newServerState, { skipDbWrite: true })
		await syncVoteStateWithQueueStateInPlace(ctx, serverState.layerQueue, newServerState.layerQueue)
		await updatelqServerState(ctx, newServerState, { type: 'system', event: 'server-roll' })
		return { code: 'ok' as const, newServerState, currentMatchLqItem }
	})

	if (res.code !== 'ok') return res
	const currentLayerItem = res.currentMatchLqItem

	// -------- schedule post-roll events --------
	postRollEventsSub?.unsubscribe()
	postRollEventsSub = new Rx.Subscription()

	// -------- schedule FRAAS auto fog-off --------
	if (currentLayerItem && currentLayerItem.layerId) {
		const currentLayer = L.toLayer(currentLayerItem.layerId)
		if (currentLayer.Gamemode === 'FRAAS') {
			postRollEventsSub.add(
				Rx.timer(CONFIG.fogOffDelay).subscribe(async () => {
					await SquadServer.rcon.setFogOfWar(ctx, 'off')
					void SquadServer.rcon.broadcast(ctx, Messages.BROADCASTS.fogOff)
				}),
			)
		}
	}

	// -------- schedule post-roll announcements --------
	const announcementTasks: (Rx.Observable<void>)[] = []
	announcementTasks.push(toCold(async () => {
		const historyState = MatchHistory.getPublicMatchHistoryState()
		const currentMatch = MatchHistory.getCurrentMatch()
		if (!currentMatch) return
		const mostRelevantEvent = BAL.getHighestPriorityTriggerEvent(MH.getActiveTriggerEvents(historyState))
		if (!mostRelevantEvent) return
		await SquadServer.warnAllAdmins(ctx, Messages.WARNS.balanceTrigger.showEvent(mostRelevantEvent, currentMatch, { isCurrent: true }))
	}))

	announcementTasks.push(toCold(async () => warnShowNext(ctx, 'all-admins')))

	announcementTasks.push(toCold(async () => {
		const serverState = await getServerState(ctx)
		if (serverState.layerQueue.length <= CONFIG.reminders.lowQueueWarningThreshold) {
			await SquadServer.warnAllAdmins(ctx, Messages.WARNS.queue.lowQueueItemCount(serverState.layerQueue.length))
		}
	}))

	const withWaits: Rx.Observable<unknown>[] = []
	withWaits.push(Rx.timer(CONFIG.reminders.postRollAnnouncementsTimeout))

	for (let i = 0; i < announcementTasks.length; i++) {
		withWaits.push(announcementTasks[i].pipe(Rx.catchError(() => Rx.EMPTY)))
		if (i !== announcementTasks.length - 1) {
			withWaits.push(Rx.timer(2000))
		}
	}

	postRollEventsSub.add(Rx.concat(Rx.from(withWaits)).subscribe())
}

async function processLayerStatusChange(_ctx: CS.Log & C.Db & C.Tx & C.Locks, status: LayerStatus, prevStatus: LayerStatus | null) {
	using ctx = await acquireReentrant(_ctx, voteStateMtx)
	const eventTime = new Date()
	const serverState = await getServerState(ctx)
	const serverInfoRes = await SquadServer.rcon.serverInfo.get(ctx, { ttl: 100 })
	if (serverInfoRes.value.code !== 'ok') return serverInfoRes.value
	const serverInfo = serverInfoRes.value.data
	const currentLayerAction = checkForCurrentLayerChangeActions(status, prevStatus, serverState, serverInfo)
	C.setSpanOpAttrs({ currentLayerAction })
	if (!currentLayerAction) return
	switch (currentLayerAction.code) {
		case 'current-layer-changed-with-players:set-server-rolling': {
			serverRolling = true
			break
		}
		case 'current-layer-changed-with-no-players:handle-new-game': {
			await handleNewGame(ctx, eventTime)
			break
		}
		default:
			assertNever(currentLayerAction)
	}

	const nextLayerAction = checkForNextLayerStatusActions(status, serverState, serverRolling)
	C.setSpanOpAttrs({ nextLayerAction })
	switch (nextLayerAction.code) {
		case 'sync-disabled:no-action':
		case 'server-rolling:no-action':
		case 'no-next-layer-set:no-action':
		case 'correct-layer-set:no-action':
			break
		case 'null-layer-set:reset':
		case 'unexpected-next-layer:reset': {
			const newServerState = Obj.deepClone(serverState)
			await syncNextLayerInPlace(ctx, newServerState)
			await syncVoteStateWithQueueStateInPlace(ctx, serverState.layerQueue, newServerState.layerQueue)
			if (status.nextLayer) unexpectedNextLayerSet$.next([getBaseCtx(), status.nextLayer?.id ?? null])
			break
		}
		default:
			assertNever(nextLayerAction)
	}
}

// -------- voting --------
//

async function syncVoteStateWithQueueStateInPlace(
	_ctx: CS.Log & C.Locks,
	oldQueue: LL.LayerList,
	newQueue: LL.LayerList,
) {
	if (deepEqual(oldQueue, newQueue)) return
	using ctx = await acquireReentrant(_ctx, voteStateMtx)
	let newVoteState: V.VoteState | undefined | null

	const oldQueueItem = oldQueue[0] as LL.LayerListItem | undefined
	const newQueueItem = newQueue[0]

	// check if we need to set 'ready'. we only want to do this if there's been a meaningul state change that means we have to initialize it or restart the autostart time. Also if we already have a .endingVoteState we don't want to overwrite that here
	const currentMatch = MatchHistory.getCurrentMatch()

	if (voteState?.code === 'in-progress') {
		if (newQueue.some(item => item.itemId === voteState!.itemId)) return

		// setting to null rather than calling clearVote indicates that a new "ready" vote state might be set instead
		newVoteState = null
	} else if (
		newQueueItem && LL.isParentVoteItem(newQueueItem) && !newQueueItem.endingVoteState
		&& (!oldQueueItem || newQueueItem.itemId !== oldQueueItem.itemId || !LL.isParentVoteItem(oldQueueItem))
		&& currentMatch.status !== 'post-game'
	) {
		let autostartTime: Date | undefined
		if (currentMatch.startTime && CONFIG.defaults.autoStartVoteDelay) {
			const startTime = dateFns.addMilliseconds(currentMatch.startTime, CONFIG.defaults.autoStartVoteDelay)
			if (dateFns.isFuture(startTime)) autostartTime = startTime
			else autostartTime = dateFns.addMinutes(new Date(), 5)
		}
		newVoteState = {
			code: 'ready',
			choices: newQueueItem.choices.map(choice => choice.layerId),
			itemId: newQueueItem.itemId,
			voterType: voteState?.voterType ?? 'public',
			autostartTime,
		}
	} else if (!newQueueItem || !LL.isParentVoteItem(newQueueItem)) {
		newVoteState = null
	}

	if (newVoteState || newVoteState === null) {
		const update: V.VoteStateUpdate = {
			state: newVoteState,
			source: { type: 'system', event: 'queue-change' },
		}

		voteEndTask?.unsubscribe()
		voteEndTask = null
		autostartVoteSub?.unsubscribe()
		autostartVoteSub = undefined
		if (newVoteState?.code === 'ready' && newVoteState.autostartTime && CONFIG.defaults.autoStartVoteDelay) {
			ctx.log.info('scheduling autostart vote to %s for %s', newVoteState.autostartTime.toISOString(), newVoteState.itemId)
			autostartVoteSub = Rx.of(1).pipe(Rx.delay(dateFns.differenceInMilliseconds(newVoteState.autostartTime, Date.now()))).subscribe(() => {
				startVote(C.initLocks(getBaseCtx()), { initiator: 'autostart' })
			})
		}
		voteState = newVoteState
		ctx.locks.releaseTasks.push(() => voteStateUpdate$.next([getBaseCtx(), update]))
	}
}

async function* watchUnexpectedNextLayer({ signal }: { signal?: AbortSignal }) {
	for await (const [_ctx, unexpectedLayerId] of toAsyncGenerator(unexpectedNextLayerSet$.pipe(withAbortSignal(signal!)))) {
		yield unexpectedLayerId
	}
}

async function* watchVoteStateUpdates({ ctx, signal }: { ctx: CS.Log & C.Db; signal?: AbortSignal }) {
	let initialState: (V.VoteState & Parts<USR.UserPart>) | null = null
	if (voteState) {
		const ids = getVoteStateDiscordIds(voteState)
		const users = await ctx.db().select().from(Schema.users).where(E.inArray(Schema.users.discordId, ids))
		initialState = { ...voteState, parts: { users } }
	}
	yield { code: 'initial-state' as const, state: initialState } satisfies V.VoteStateUpdateOrInitialWithParts
	for await (const [ctx, update] of toAsyncGenerator(voteStateUpdate$.pipe(withAbortSignal(signal!)))) {
		const withParts = await includeVoteStateUpdatePart(ctx, update)
		yield { code: 'update' as const, update: withParts } satisfies V.VoteStateUpdateOrInitialWithParts
	}
}

export const startVote = C.spanOp(
	'layer-queue:vote:start',
	{ tracer, eventLogLevel: 'info', attrs: (_, opts) => opts },
	async (
		_ctx: CS.Log & C.Db & Partial<C.User> & C.Locks,
		opts: V.StartVoteInput & { initiator: USR.GuiOrChatUserId | 'autostart' },
	) => {
		if (_ctx.user) {
			const denyRes = await Rbac.tryDenyPermissionsForUser(_ctx, _ctx.user.discordId, {
				check: 'all',
				permits: [RBAC.perm('vote:manage')],
			})
			if (denyRes) {
				return denyRes
			}
		}

		using ctx = await acquireReentrant(_ctx, voteStateMtx)
		const { value: statusRes } = await SquadServer.rcon.layersStatus.get(ctx, { ttl: 10_000 })
		if (statusRes.code !== 'ok') {
			return statusRes
		}
		const currentMatch = MatchHistory.getCurrentMatch()
		if (currentMatch.status === 'post-game') {
			return { code: 'err:vote-not-allowed' as const, msg: Messages.WARNS.vote.start.noVoteInPostGame }
		}

		const duration = opts.duration ?? CONFIG.defaults.voteDuration
		const res = await DB.runTransaction(ctx, async (ctx) => {
			const serverState = await getServerState(ctx)
			const newServerState = Obj.deepClone(serverState)
			const itemId = opts.itemId ?? newServerState.layerQueue[0]?.itemId
			if (!itemId) {
				return { code: 'err:item-not-found' as const, msg: Messages.WARNS.vote.start.itemNotFound }
			}

			const initiateVoteRes = V.canInitiateVote(itemId, newServerState.layerQueue, opts.voterType ?? 'public', voteState ?? undefined)

			const msgMap = {
				'err:item-not-found': Messages.WARNS.vote.start.itemNotFound,
				'err:invalid-item-type': Messages.WARNS.vote.start.invalidItemType,
				'err:editing-in-progress': Messages.WARNS.vote.start.editingInProgress,
				'err:public-vote-not-first': Messages.WARNS.vote.start.publicVoteNotFirst,
				'err:vote-in-progress': Messages.WARNS.vote.start.voteAlreadyInProgress,
				'ok': null,
			} satisfies Record<typeof initiateVoteRes['code'], string | null>

			if (initiateVoteRes.code !== 'ok') {
				return {
					code: initiateVoteRes.code,
					msg: msgMap[initiateVoteRes.code]!,
				}
			}

			clearEditing()

			const item = initiateVoteRes.item
			delete item.endingVoteState
			LL.setCorrectChosenLayerIdInPlace(item)
			await updatelqServerState(ctx, newServerState, { event: 'vote-start', type: 'system' })

			const updatedVoteState = {
				code: 'in-progress',
				deadline: Date.now() + duration,
				votes: {},
				initiator: opts.initiator,
				choices: item.choices.map(choice => choice.layerId),
				itemId: item.itemId,
				voterType: opts.voterType ?? 'public',
			} satisfies V.VoteState

			ctx.log.info('registering vote deadline')
			const update = {
				state: updatedVoteState,
				source: opts.initiator === 'autostart'
					? { type: 'system', event: 'automatic-start-vote' }
					: {
						type: 'manual',
						event: 'start-vote',
						user: opts.initiator,
					},
			} satisfies V.VoteStateUpdate

			autostartVoteSub?.unsubscribe()
			autostartVoteSub = undefined

			voteState = updatedVoteState
			ctx.locks.releaseTasks.push(() => voteStateUpdate$.next([getBaseCtx(), update]))
			registerVoteDeadlineAndReminder$(getBaseCtx())
			void broadcastVoteUpdate(
				ctx,
				Messages.BROADCASTS.vote.started(
					voteState,
					duration,
					item.displayProps ?? CONFIG.defaults.voteDisplayProps,
				),
			)

			return { code: 'ok' as const, voteStateUpdate: update }
		})

		return res
	},
)

export const handleVote = C.spanOp('layer-queue:vote:handle-vote', {
	tracer,
	attrs: (_, msg) => ({ messageId: msg.message, playerId: msg.playerId }),
}, (ctx: CS.Log & C.Db, msg: SM.ChatMessage) => {
	//
	const choiceIdx = parseInt(msg.message.trim())
	if (!voteState) {
		C.setSpanStatus(Otel.SpanStatusCode.ERROR, 'No vote in progress')
		return
	}
	if (voteState.voterType === 'public') {
		if (msg.chat !== 'ChatAll') {
			void SquadServer.rcon.warn(ctx, msg.playerId, Messages.WARNS.vote.wrongChat('AllChat'))
			return
		}
	}
	if (voteState.voterType === 'internal') {
		if (msg.chat !== 'ChatAdmin') {
			void SquadServer.rcon.warn(ctx, msg.playerId, Messages.WARNS.vote.wrongChat('AdminChat'))
			return
		}
	}
	if (choiceIdx <= 0 || choiceIdx > voteState.choices.length) {
		C.setSpanStatus(Otel.SpanStatusCode.ERROR, 'Invalid choice')
		void SquadServer.rcon.warn(ctx, msg.playerId, Messages.WARNS.vote.invalidChoice)
		return
	}
	if (voteState.code !== 'in-progress') {
		void SquadServer.rcon.warn(ctx, msg.playerId, Messages.WARNS.vote.noVoteInProgress)
		C.setSpanStatus(Otel.SpanStatusCode.ERROR, 'Vote not in progress')
		return
	}

	const choice = voteState.choices[choiceIdx - 1]
	voteState.votes[msg.playerId] = choice
	const update: V.VoteStateUpdate = {
		state: voteState,
		source: {
			type: 'manual',
			event: 'vote',
			user: { steamId: msg.playerId },
		},
	}

	voteStateUpdate$.next([ctx, update])
	void (async () => {
		const serverState = await getServerState(ctx)
		const voteItem = LL.resolveParentVoteItem(voteState.itemId, serverState.layerQueue)
		SquadServer.rcon.warn(
			ctx,
			msg.playerId,
			Messages.WARNS.vote.voteCast(choice, voteItem?.displayProps ?? CONFIG.defaults.voteDisplayProps),
		)
	})()
	C.setSpanStatus(Otel.SpanStatusCode.OK)
})

export const abortVote = C.spanOp(
	'layer-queue:vote:abort',
	{ tracer, eventLogLevel: 'info', attrs: (_, opts) => opts },
	async (_ctx: CS.Log & C.Db & C.Locks, opts: { aborter: USR.GuiOrChatUserId }) => {
		using ctx = await acquireReentrant(_ctx, voteStateMtx)
		return await DB.runTransaction(ctx, async (ctx) => {
			if (!voteState || voteState?.code !== 'in-progress') {
				return {
					code: 'err:no-vote-in-progress' as const,
					msg: 'No vote in progress',
				}
			}
			const serverState = await getServerState(ctx)
			const newVoteState: V.EndingVoteState = {
				code: 'ended:aborted',
				...Obj.selectProps(voteState, ['choices', 'itemId', 'voterType', 'votes', 'deadline']),
				aborter: opts.aborter,
			}

			const update: V.VoteStateUpdate = {
				state: null,
				source: {
					type: 'manual',
					user: opts.aborter,
					event: 'abort-vote',
				},
			}
			await broadcastVoteUpdate(ctx, Messages.BROADCASTS.vote.aborted)
			voteState = null
			ctx.locks.releaseTasks.push(() => voteStateUpdate$.next([ctx, update]))
			voteEndTask?.unsubscribe()
			voteEndTask = null
			const layerQueue = Obj.deepClone(serverState.layerQueue)
			const itemRes = LL.findItemById(layerQueue, newVoteState.itemId)
			if (!itemRes || !LL.isParentVoteItem(itemRes.item)) throw new Error('vote item not found or is invalid')
			const item = itemRes.item
			item.endingVoteState = newVoteState
			LL.setCorrectChosenLayerIdInPlace(item)
			await updatelqServerState(ctx, { layerQueue }, { event: 'vote-abort', type: 'system' })

			return { code: 'ok' as const }
		})
	},
)

export async function cancelVoteAutostart(_ctx: C.Locks, opts: { user: USR.GuiOrChatUserId }) {
	using ctx = await acquireReentrant(_ctx, voteStateMtx)
	if (voteState?.autostartCancelled) return { code: 'err:autostart-already-cancelled' as const, msg: 'Vote is already cancelled' }
	if (!voteState || voteState.code !== 'ready' || !voteState.autostartTime) {
		return { code: 'err:vote-not-queued' as const, msg: 'No vote is currently scheduled' }
	}

	const newVoteState = Obj.deepClone(voteState)
	newVoteState.autostartCancelled = true
	delete newVoteState.autostartTime
	voteState = newVoteState

	ctx.locks.releaseTasks.push(() => {
		voteStateUpdate$.next([getBaseCtx(), {
			source: { type: 'manual', user: opts.user, event: 'autostart-cancelled' },
			state: voteState,
		}])
	})
	return { code: 'ok' as const }
}

function registerVoteDeadlineAndReminder$(ctx: CS.Log & C.Db) {
	voteEndTask?.unsubscribe()

	if (!voteState || voteState.code !== 'in-progress') return
	voteEndTask = new Rx.Subscription()

	const currentTime = Date.now()
	const finalReminderWaitTime = Math.max(0, voteState.deadline - CONFIG.reminders.finalVote - currentTime)
	const finalReminderBuffer = finalReminderWaitTime - 5 * 1000
	const regularReminderInterval = CONFIG.reminders.voteReminderInterval

	// -------- schedule regular reminders --------
	voteEndTask.add(
		Rx.interval(regularReminderInterval)
			.pipe(
				Rx.takeUntil(Rx.timer(finalReminderBuffer)),
				C.durableSub('layer-queue:regular-vote-reminders', { ctx: getBaseCtx(), tracer }, async () => {
					const ctx = getBaseCtx()
					if (!voteState || voteState.code !== 'in-progress') return
					const timeLeft = voteState.deadline - Date.now()
					const serverState = await getServerState(ctx)
					const voteItem = LL.resolveParentVoteItem(voteState.itemId, serverState.layerQueue)
					const msg = Messages.BROADCASTS.vote.voteReminder(
						voteState,
						timeLeft,
						voteState.choices,
						voteItem?.displayProps ?? CONFIG.defaults.voteDisplayProps,
					)
					await broadcastVoteUpdate(ctx, msg, { onlyNotifyNonVotingAdmins: true })
				}),
			)
			.subscribe(),
	)

	// -------- schedule final reminder --------
	if (finalReminderWaitTime > 0) {
		voteEndTask.add(
			Rx.timer(finalReminderWaitTime).pipe(
				C.durableSub('layer-queue:final-vote-reminder', { ctx: getBaseCtx(), tracer }, async () => {
					if (!voteState || voteState.code !== 'in-progress') return
					const serverState = await getServerState(getBaseCtx())
					const voteItem = LL.resolveParentVoteItem(voteState.itemId, serverState.layerQueue)
					const msg = Messages.BROADCASTS.vote.voteReminder(
						voteState,
						CONFIG.reminders.finalVote,
						true,
						voteItem?.displayProps ?? CONFIG.defaults.voteDisplayProps,
					)
					await broadcastVoteUpdate(ctx, msg, { onlyNotifyNonVotingAdmins: true, repeatWarn: false })
				}),
			).subscribe(),
		)
	}

	// -------- schedule timeout handling --------
	voteEndTask.add(
		Rx.timer(Math.max(voteState.deadline - currentTime, 0)).subscribe({
			next: async () => {
				await handleVoteTimeout(C.initLocks(getBaseCtx()))
			},
			complete: () => {
				ctx.log.info('vote deadline reached')
				voteEndTask = null
			},
		}),
	)
}

const handleVoteTimeout = C.spanOp(
	'layer-queue:vote:handle-timeout',
	{ tracer, eventLogLevel: 'info' },
	async (_ctx: CS.Log & C.Db & C.Locks) => {
		using ctx = await acquireReentrant(_ctx, voteStateMtx)
		const res = await DB.runTransaction(ctx, async (ctx) => {
			if (!voteState || voteState.code !== 'in-progress') {
				return {
					code: 'err:no-vote-in-progress' as const,
					msg: 'No vote in progress',
					currentVote: voteState,
				}
			}
			const serverState = Obj.deepClone(await getServerState(ctx))
			const listItemRes = LL.findItemById(serverState.layerQueue, voteState.itemId)
			if (!listItemRes || !LL.isParentVoteItem(listItemRes.item)) throw new Error('Invalid vote item')
			const listItem = listItemRes.item as LL.ParentVoteItem
			let endingVoteState: V.EndingVoteState
			let tally: V.Tally | null = null
			if (Object.values(voteState.votes).length === 0) {
				endingVoteState = {
					code: 'ended:insufficient-votes',
					...Obj.selectProps(voteState, ['choices', 'itemId', 'deadline', 'votes', 'voterType']),
				}
			} else {
				const { value: serverInfoRes } = await SquadServer.rcon.serverInfo.get(ctx, { ttl: 10_000 })
				if (serverInfoRes.code !== 'ok') return serverInfoRes

				const serverInfo = serverInfoRes.data

				tally = V.tallyVotes(voteState, serverInfo.playerCount)
				C.setSpanOpAttrs({ tally })

				const winner = tally.leaders[Math.floor(Math.random() * tally.leaders.length)]
				endingVoteState = {
					code: 'ended:winner',
					...Obj.selectProps(voteState, ['choices', 'itemId', 'deadline', 'votes', 'voterType']),
					winner,
				}
				listItem.layerId = winner
			}
			listItem.endingVoteState = endingVoteState
			LL.setCorrectChosenLayerIdInPlace(listItem)
			const displayProps = listItem.displayProps ?? CONFIG.defaults.voteDisplayProps
			if (endingVoteState.code === 'ended:winner') {
				await broadcastVoteUpdate(ctx, Messages.BROADCASTS.vote.winnerSelected(tally!, endingVoteState!.winner, displayProps), {
					repeatWarn: false,
				})
			}
			if (endingVoteState.code === 'ended:insufficient-votes') {
				await broadcastVoteUpdate(ctx, Messages.BROADCASTS.vote.insufficientVotes(V.getDefaultChoice(endingVoteState), displayProps), {
					repeatWarn: false,
				})
			}
			voteState = null
			const voteUpdate: V.VoteStateUpdate = {
				state: null,
				source: { type: 'system', event: 'vote-timeout' },
			}
			ctx.locks.releaseTasks.push(() => voteStateUpdate$.next([getBaseCtx(), voteUpdate]))

			await syncNextLayerInPlace(ctx, serverState, { skipDbWrite: true })
			await updatelqServerState(ctx, serverState, { type: 'system', event: 'vote-timeout' })
			return { code: 'ok' as const, endingVoteState, tally }
		})
		return res
	},
)

async function broadcastVoteUpdate(
	ctx: CS.Log,
	msg: string,
	opts?: { onlyNotifyNonVotingAdmins?: boolean; repeatWarn?: boolean },
) {
	const repeatWarn = opts?.repeatWarn ?? true
	if (!voteState) return
	switch (voteState.voterType) {
		case 'public':
			await SquadServer.rcon.broadcast(ctx, msg)
			break
		case 'internal':
			{
				for (let i = 0; i < (repeatWarn ? 3 : 1); i++) {
					await SquadServer.warnAllAdmins(
						ctx,
						({ player }) => {
							if (!voteState || !opts?.onlyNotifyNonVotingAdmins) return msg
							if (!V.isVoteStateWithVoteData(voteState)) return
							if (voteState.votes[player.steamID.toString()]) return
							return msg
						},
					)
					if (i < 2) await sleep(5000)
				}
			}
			break
		default:
			assertNever(voteState.voterType)
	}
}

async function includeVoteStateUpdatePart(ctx: CS.Log & C.Db, update: V.VoteStateUpdate) {
	let discordIds: Set<bigint> = new Set()
	if (update.source.type === 'manual') {
		const discordId = update.source.user.discordId
		if (discordId) {
			discordIds.add(discordId)
		}
	}
	if (update.state) {
		discordIds = new Set([...discordIds, ...getVoteStateDiscordIds(update.state)])
	}
	const discordIdsArray = Array.from(discordIds)
	const users = await ctx.db().select().from(Schema.users).where(E.inArray(Schema.users.discordId, discordIdsArray))
	const withParts: V.VoteStateUpdate & Parts<USR.UserPart> = { ...update, parts: { users } }
	return withParts
}

function getVoteStateDiscordIds(state: V.VoteState) {
	const discordIds: bigint[] = []
	switch (state.code) {
		case 'ready': {
			break
		}
		case 'in-progress': {
			if (typeof state.initiator === 'object' && state.initiator.discordId) discordIds.push(state.initiator.discordId)
			break
		}
		default:
			assertNever(state)
	}
	return discordIds
}

// -------- user presence --------
export async function startEditing({ ctx }: { ctx: C.TrpcRequest }) {
	const denyRes = await Rbac.tryDenyPermissionsForUser(ctx, ctx.user.discordId, RBAC.perm('queue:write'))
	if (denyRes) return denyRes
	if (userPresence.editState) {
		return { code: 'err:already-editing' as const, userPresence }
	}
	userPresence = Obj.deepClone(userPresence)
	userPresence.editState = {
		startTime: Date.now(),
		userId: ctx.user.discordId,
		wsClientId: ctx.wsClientId,
	}
	const update: USR.UserPresenceStateUpdate & Parts<USR.UserPart> = {
		event: 'edit-start',
		state: userPresence,
		parts: {
			users: [ctx.user],
		},
	}

	userPresenceUpdate$.next(update)

	return { code: 'ok' as const }
}

export function endEditing({ ctx }: { ctx: C.TrpcRequest }) {
	if (!userPresence.editState || ctx.wsClientId !== userPresence.editState.wsClientId) {
		return { code: 'err:not-editing' as const }
	}
	userPresence = Obj.deepClone(userPresence)
	delete userPresence.editState
	const update: USR.UserPresenceStateUpdate & Parts<USR.UserPart> = {
		event: 'edit-end',
		state: userPresence,
		parts: {
			users: [ctx.user],
		},
	}
	userPresenceUpdate$.next(update)
	return { code: 'ok' as const }
}

function clearEditing() {
	userPresence = Obj.deepClone(userPresence)
	delete userPresence.editState
	const update: USR.UserPresenceStateUpdate & Parts<USR.UserPart> = {
		event: 'edit-end',
		state: userPresence,
		parts: { users: [] },
	}
	userPresenceUpdate$.next(update)
}

async function kickEditor({ ctx }: { ctx: C.TrpcRequest }) {
	const denyRes = await Rbac.tryDenyPermissionsForUser(ctx, ctx.user.discordId, RBAC.perm('queue:write'))
	if (denyRes) return denyRes
	if (!userPresence.editState) {
		return { code: 'err:no-editor' as const }
	}
	userPresence = Obj.deepClone(userPresence)
	delete userPresence.editState
	const update: USR.UserPresenceStateUpdate & Parts<USR.UserPart> = {
		event: 'edit-kick',
		state: userPresence,
		parts: {
			users: [],
		},
	}
	userPresenceUpdate$.next(update)
	return { code: 'ok' as const }
}

export async function* watchUserPresence({ ctx, signal }: { ctx: CS.Log & C.Db; signal?: AbortSignal }) {
	const users: USR.User[] = []
	if (userPresence.editState) {
		const [user] = await ctx.db().select().from(Schema.users).where(E.eq(Schema.users.discordId, userPresence.editState.userId))
		users.push(user)
	}
	yield { code: 'initial-state' as const, state: userPresence, parts: { users } } satisfies any & Parts<USR.UserPart>
	for await (const update of toAsyncGenerator(userPresenceUpdate$.pipe(withAbortSignal(signal!)))) {
		yield { code: 'update' as const, update }
	}
}

// -------- generic actions & data  --------
async function* watchLayerQueueStateUpdates(args: { ctx: CS.Log & C.Db; signal?: AbortSignal }) {
	for await (const update of toAsyncGenerator(serverStateUpdateWithParts$.pipe(withAbortSignal(args.signal!)))) {
		yield update
	}
}

export async function updateQueue({ input, ctx }: { input: SS.UserModifiableServerState; ctx: C.TrpcRequest }) {
	input = Obj.deepClone(input)
	const res = await DB.runTransaction(ctx, async (ctx) => {
		const serverStatePrev = await getServerState(ctx)
		const serverState = Obj.deepClone(serverStatePrev)
		if (input.layerQueueSeqId !== serverState.layerQueueSeqId) {
			return {
				code: 'err:out-of-sync' as const,
				msg: 'Update is out of sync',
			}
		}

		if (!deepEqual(serverState.layerQueue, input.layerQueue)) {
			const denyRes = await Rbac.tryDenyPermissionsForUser(ctx, ctx.user.discordId, {
				check: 'all',
				permits: [RBAC.perm('queue:write')],
			})
			if (denyRes) return denyRes
		}

		if (!deepEqual(serverState.settings, input.settings)) {
			const denyRes = await Rbac.tryDenyPermissionsForUser(ctx, ctx.user.discordId, {
				check: 'all',
				permits: [RBAC.perm('settings:write')],
			})
			if (denyRes) return denyRes
		}

		for (const item of input.layerQueue) {
			if (LL.isParentVoteItem(item) && item.choices.length > CONFIG.maxNumVoteChoices) {
				return {
					code: 'err:too-many-vote-choices' as const,
					msg: `Max choices allowed is ${CONFIG.maxNumVoteChoices}`,
				}
			}
		}

		if (input.layerQueue.length > CONFIG.maxQueueSize) {
			return { code: 'err:queue-too-large' as const }
		}

		for (const item of input.layerQueue) {
			if (LL.isParentVoteItem(item) && item.choices.length > CONFIG.maxNumVoteChoices) {
				return {
					code: 'err:too-many-vote-choices' as const,
					msg: `Max choices allowed is ${CONFIG.maxNumVoteChoices}`,
				}
			}
			if (
				LL.isParentVoteItem(item)
				&& !V.validateChoicesWithDisplayProps(item.choices.map(c => c.layerId), item.displayProps ?? CONFIG.defaults.voteDisplayProps)
			) {
				return {
					code: 'err:not-enough-visible-info' as const,
					msg: "Can't distinguish between vote choices.",
				}
			}
		}

		// TODO need to implement queue:force-write via a structural diff on the changed layerIds

		serverState.settings = input.settings
		serverState.layerQueue = input.layerQueue

		await syncNextLayerInPlace(ctx, serverState, { skipDbWrite: true })
		await syncVoteStateWithQueueStateInPlace(ctx, serverStatePrev.layerQueue, serverState.layerQueue)

		const update = await updatelqServerState(ctx, serverState, { type: 'manual', user: { discordId: ctx.user.discordId }, event: 'edit' })
		endEditing({ ctx })

		return { code: 'ok' as const, update }
	})

	return res
}

export async function getServerState(ctx: C.Db & CS.Log) {
	const query = ctx.db().select().from(Schema.servers).where(E.eq(Schema.servers.id, CONFIG.serverId))
	let serverRaw: any
	if (ctx.tx) [serverRaw] = await query.for('update')
	else [serverRaw] = await query
	return SS.ServerStateSchema.parse(unsuperjsonify(Schema.servers, serverRaw))
}

export async function updatelqServerState(
	ctx: C.Db & C.Tx,
	changes: Partial<SS.LQServerState>,
	source: SS.LQServerStateUpdate['source'],
) {
	const serverState = await getServerState(ctx)
	const newServerState = { ...serverState, ...changes }
	if (changes.layerQueueSeqId && changes.layerQueueSeqId !== serverState.layerQueueSeqId) {
		throw new Error('Invalid layer queue sequence ID')
	}
	newServerState.layerQueueSeqId = serverState.layerQueueSeqId + 1
	await ctx.db().update(Schema.servers).set(superjsonify(Schema.servers, { ...changes, layerQueueSeqId: newServerState.layerQueueSeqId }))
		.where(E.eq(Schema.servers.id, CONFIG.serverId))
	const update: SS.LQServerStateUpdate = { state: newServerState, source }

	// we can't pass the transaction context to subscribers
	ctx.tx.unlockTasks.push(() => serverStateUpdate$.next([update, DB.addPooledDb({ log: baseLogger })]))
	return newServerState
}

export async function warnShowNext(ctx: C.Db & CS.Log, playerId: string | 'all-admins', opts?: { repeat?: number }) {
	const serverState = await getServerState(ctx)
	const layerQueue = serverState.layerQueue
	const parts: USR.UserPart = { users: [] }
	const firstItem = layerQueue[0]
	if (firstItem?.source.type === 'manual') {
		const userId = firstItem.source.userId
		const [user] = await ctx.db().select().from(Schema.users).where(E.eq(Schema.users.discordId, userId))
		parts.users.push(user)
	}
	if (playerId === 'all-admins') {
		await SquadServer.warnAllAdmins(ctx, Messages.WARNS.queue.showNext(layerQueue, parts, { repeat: opts?.repeat ?? 1 }))
	} else {
		await SquadServer.rcon.warn(ctx, playerId, Messages.WARNS.queue.showNext(layerQueue, parts, { repeat: opts?.repeat ?? 1 }))
	}
}

async function includeLQServerUpdateParts(
	ctx: C.Db & CS.Log,
	_serverStateUpdate: SS.LQServerStateUpdate,
): Promise<SS.LQServerStateUpdate & Partial<Parts<USR.UserPart & LQY.LayerItemStatusesPart>>> {
	const userPartPromise = includeUserPartForLQServerUpdate(ctx, _serverStateUpdate)
	const layerItemStatusesPromise = includeLayerItemStatusesForLQServerUpdate(ctx, _serverStateUpdate)
	return {
		..._serverStateUpdate,
		parts: {
			...(await userPartPromise),
			...(await layerItemStatusesPromise),
		},
	}
}

async function includeUserPartForLQServerUpdate(ctx: C.Db & CS.Log, update: SS.LQServerStateUpdate) {
	const part: USR.UserPart = { users: [] as USR.User[] }
	const state = update.state
	const userIds: bigint[] = []
	if (update.source.type === 'manual' && update.source.user.discordId) {
		userIds.push(BigInt(update.source.user.discordId))
	}
	for (const item of state.layerQueue) {
		if (item.source.type === 'manual') userIds.push(BigInt(item.source.userId))
	}

	let users: Schema.User[] = []
	if (userIds.length > 0) {
		users = await ctx.db().select().from(Schema.users).where(E.inArray(Schema.users.discordId, userIds))
	}
	for (const user of users) {
		part.users.push(user)
	}
	return part
}

async function includeLayerItemStatusesForLQServerUpdate(ctx: CS.Log, update: SS.LQServerStateUpdate): Promise<LQY.LayerItemStatusesPart> {
	const queryCtx = LayerQueriesServer.resolveLayerQueryCtx(ctx, update.state)
	const constraints = SS.getPoolConstraints(update.state.settings.queue.mainPool)
	const statusRes = await LayerQueries.getLayerItemStatuses({ ctx: queryCtx, input: { constraints } })
	if (statusRes.code !== 'ok') {
		throw new Error(`Failed to get layer item statuses: ${statusRes}`)
	}
	return { layerItemStatuses: statusRes.statuses }
}

/**
 * sets next layer on server, generating a new queue item if needed. modifies serverState in place.
 */
async function syncNextLayerInPlace<NoDbWrite extends boolean>(
	ctx: CS.Log & C.Db & (NoDbWrite extends true ? object : C.Tx),
	serverState: SS.LQServerState,
	opts?: { skipDbWrite: NoDbWrite },
) {
	let nextLayerId = LL.getNextLayerId(serverState.layerQueue)
	let wroteServerState = false
	if (!nextLayerId) {
		const constraints: LQY.LayerQueryConstraint[] = []
		if (serverState.settings.queue.applyMainPoolToGenerationPool) {
			constraints.push(...SS.getPoolConstraints(serverState.settings.queue.mainPool, 'where-condition', 'where-condition'))
		}
		constraints.push(...SS.getPoolConstraints(serverState.settings.queue.generationPool, 'where-condition', 'where-condition'))
		const layerCtx = LayerQueriesServer.resolveLayerQueryCtx(ctx, serverState)

		const res = await LayerQueries.queryLayers({
			ctx: layerCtx,
			input: { constraints, pageSize: 1, sort: { type: 'random', seed: Math.random() } },
		})
		if (res.code !== 'ok') throw new Error(`Failed to query layers: ${JSON.stringify(res)}`)
		const ids = res.layers.map(layer => layer.id)
		;[nextLayerId] = ids
		if (!nextLayerId) return false
		const nextQueueItem = LL.createLayerListItem({ layerId: nextLayerId, source: { type: 'generated' } })
		serverState.layerQueue.push(nextQueueItem)
		if (!opts?.skipDbWrite) {
			await updatelqServerState(ctx as C.Db & C.Tx, serverState, { type: 'system', event: 'next-layer-generated' })
		}
		wroteServerState = true
	}
	if (!serverState.settings.updatesToSquadServerDisabled) {
		const res = await SquadServer.rcon.setNextLayer(ctx, nextLayerId)
		switch (res.code) {
			case 'err:unable-to-set-next-layer':
				unexpectedNextLayerSet$.next([ctx, res.unexpectedLayerId])
				break
			case 'err:rcon':
			case 'ok':
				unexpectedNextLayerSet$.next([ctx, null])
				break
			default:
				assertNever(res)
		}
	}
	return wroteServerState
}

export async function toggleUpdatesToSquadServer({ ctx, input }: { ctx: CS.Log & C.Db & C.UserOrPlayer; input: { disabled: boolean } }) {
	// if player we assume authorization has already been established
	if (ctx.user) {
		const denyRes = await Rbac.tryDenyPermissionsForUser(ctx, ctx.user.discordId, RBAC.perm('squad-server:disable-slm-updates'))
		if (denyRes) return denyRes
	}

	await DB.runTransaction(ctx, async ctx => {
		const serverState = await getServerState(ctx)
		serverState.settings.updatesToSquadServerDisabled = input.disabled
		await updatelqServerState(ctx, { settings: serverState.settings }, { type: 'system', event: 'updates-to-squad-server-toggled' })
	})

	await SquadServer.warnAllAdmins(ctx, Messages.WARNS.slmUpdatesSet(!input.disabled))
	return { code: 'ok' as const }
}

export async function getSlmUpdatesEnabled(ctx: CS.Log & C.Db & C.UserOrPlayer) {
	const serverState = await getServerState(ctx)
	return { code: 'ok' as const, enabled: !serverState.settings.updatesToSquadServerDisabled }
}

export function getBaseCtx() {
	return DB.addPooledDb({ log: baseLogger })
}

// -------- setup router --------
export const layerQueueRouter = router({
	watchLayerQueueState: procedure.subscription(watchLayerQueueStateUpdates),
	watchVoteStateUpdates: procedure.subscription(watchVoteStateUpdates),
	watchUnexpectedNextLayer: procedure.subscription(watchUnexpectedNextLayer),
	startVote: procedure
		.input(V.StartVoteInputSchema)
		.mutation(async ({ input, ctx }) => {
			return startVote(ctx, { ...input, initiator: { discordId: ctx.user.discordId } })
		}),
	abortVote: procedure.mutation(async ({ ctx }) => {
		const denyRes = await Rbac.tryDenyPermissionsForUser(ctx, ctx.user.discordId, { check: 'all', permits: [RBAC.perm('vote:manage')] })
		if (denyRes) return denyRes
		return await abortVote(ctx, { aborter: { discordId: ctx.user.discordId } })
	}),
	cancelVoteAutostart: procedure.mutation(async ({ ctx }) => {
		const denyRes = await Rbac.tryDenyPermissionsForUser(ctx, ctx.user.discordId, { check: 'all', permits: [RBAC.perm('vote:manage')] })
		if (denyRes) return denyRes
		return await cancelVoteAutostart(ctx, { user: { discordId: ctx.user.discordId } })
	}),

	startEditing: procedure.mutation(startEditing),
	endEditing: procedure.mutation(endEditing),
	kickEditor: procedure.mutation(kickEditor),

	watchUserPresence: procedure.subscription(watchUserPresence),

	updateQueue: procedure.input(SS.GenericServerStateUpdateSchema).mutation(updateQueue),
	toggleUpdatesToSquadServer: procedure.input(z.object({ disabled: z.boolean() })).mutation(toggleUpdatesToSquadServer),
})
