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
import * as SquadRcon from '@/server/systems/squad-rcon'
import * as SquadServer from '@/server/systems/squad-server.ts'
import * as WSSessionSys from '@/server/systems/ws-session.ts'
import * as LayerQueries from '@/systems.shared/layer-queries.shared.ts'
import * as Otel from '@opentelemetry/api'
import { Mutex } from 'async-mutex'
import * as dateFns from 'date-fns'
import { _AddUndefinedToPossiblyUndefinedPropertiesOfInterface } from 'discord.js'
import * as E from 'drizzle-orm/expressions'
import * as Rx from 'rxjs'
import { z } from 'zod'
import { procedure, router } from '../trpc.server.ts'

export type UserPresenceContext = {
	state: USR.UserPresenceState
	update$: Rx.Subject<USR.UserPresenceStateUpdate & Parts<USR.UserPart>>
}

export type VoteContext = {
	voteEndTask: Rx.Subscription | null
	autostartVoteSub: Rx.Subscription | null
	mtx: Mutex
	state: V.VoteState | null
	update$: Rx.Subject<V.VoteStateUpdate>
}

export type LayerQueueContext = {
	unexpectedNextLayerSet$: Rx.BehaviorSubject<L.LayerId | null>

	update$: Rx.ReplaySubject<[SS.LQStateUpdate, CS.Log & C.Db]>
}

export function initLayerQueueContext(): LayerQueueContext {
	return {
		unexpectedNextLayerSet$: new Rx.BehaviorSubject<L.LayerId | null>(null),
		update$: new Rx.ReplaySubject<[SS.LQStateUpdate, CS.Log & C.Db]>(1),
	}
}

const tracer = Otel.trace.getTracer('layer-queue')
export const initLayerQueue = C.spanOp(
	'layer-queue:init',
	{ tracer, eventLogLevel: 'info' },
	async (ctx: CS.Log & C.Db & C.ServerSlice & C.Locks) => {
		const serverId = ctx.serverId
		await DB.runTransaction(ctx, async (_ctx) => {
			using ctx = await acquireReentrant(_ctx, _ctx.vote.mtx)
			const s = ctx.layerQueue

			const initialServerState = await SquadServer.getFullServerState(ctx)
			// -------- prune main pool filters when filter entities are deleted  --------
			let mainPoolFilterIds = initialServerState.settings.queue.mainPool.filters
			const filters = await ctx.db().select().from(Schema.filters).where(E.inArray(Schema.filters.id, mainPoolFilterIds)).for('update')
			mainPoolFilterIds = mainPoolFilterIds.filter(id => filters.some(filter => filter.id === id))
			initialServerState.settings.queue.mainPool.filters = mainPoolFilterIds

			// -------- initialize vote state --------
			await syncVoteStateWithQueueStateInPlace(ctx, [], initialServerState.layerQueue)

			ctx.tx.unlockTasks.push(() => s.update$.next([{ state: initialServerState, source: { type: 'system', event: 'app-startup' } }, ctx]))

			ctx.log.info('vote state initialized')
		})
		ctx.log.info('initial update complete')

		// -------- log vote state updates --------
		ctx.serverSliceSub.add(ctx.vote.update$.subscribe((update) => {
			const ctx = getBaseCtx()
			ctx.log.info('Vote state updated : %s : %s : %s', update.source.type, update.source.event, update.state?.code ?? null)
		}))

		ctx.serverSliceSub.add(ctx.layerQueue.update$.subscribe(([state, ctx]) => {
			ctx.log.debug({ seqId: state.state.layerQueueSeqId }, 'pushing server state update')
		}))

		// -------- schedule generic admin reminders --------
		if (CONFIG.servers.find(s => s.id === ctx.serverId)!.remindersAndAnnouncementsEnabled) {
			ctx.serverSliceSub.add(
				Rx.interval(CONFIG.layerQueue.adminQueueReminderInterval).pipe(
					C.durableSub('layer-queue:queue-reminders', { ctx, tracer }, async () => {
						const ctx = SquadServer.resolveSliceCtx(getBaseCtx(), serverId)
						const serverState = await getServerState(ctx)
						const currentMatch = MatchHistory.getCurrentMatch(ctx)
						const voteState = ctx.vote.state
						if (SquadServer.state.serverRolling || currentMatch.status === 'post-game') return
						if (
							LL.isParentVoteItem(serverState.layerQueue[0])
							&& voteState?.code === 'ready'
							&& serverState.lastRoll
							&& serverState.lastRoll.getTime() + CONFIG.vote.startVoteReminderThreshold < Date.now()
						) {
							await SquadRcon.warnAllAdmins(ctx, Messages.WARNS.queue.votePending)
						} else if (serverState.layerQueue.length === 0) {
							await SquadRcon.warnAllAdmins(ctx, Messages.WARNS.queue.empty)
						}
					}),
				).subscribe(),
			)
		}

		// -------- when SLM is not able to set a layer on the server, notify admins.
		ctx.serverSliceSub.add(
			ctx.layerQueue.unexpectedNextLayerSet$
				.pipe(
					Rx.switchMap((unexpectedNextLayer) => {
						if (unexpectedNextLayer) {
							return Rx.interval(HumanTime.parse('2m')).pipe(
								Rx.startWith(0),
								Rx.map(() => unexpectedNextLayer),
							)
						}
						return Rx.EMPTY
					}),
					C.durableSub('layer-queue:notify-unexpected-next-layer', { tracer, ctx }, async (expectedNextLayerId) => {
						const ctx = SquadServer.resolveSliceCtx(getBaseCtx(), serverId)
						const serverState = await getServerState(ctx)
						const expectedLayerName = DH.toFullLayerNameFromId(LL.getNextLayerId(serverState.layerQueue)!)
						const actualLayerName = DH.toFullLayerNameFromId(expectedNextLayerId)
						await SquadRcon.warnAllAdmins(
							ctx,
							`Current next layer on the server is out-of-sync with queue. Got ${actualLayerName}, but expected ${expectedLayerName}`,
						)
					}),
				).subscribe(),
		)

		// -------- Interpret current/next layer updates from the game server for the purposes of syncing it with the queue  --------
		ctx.serverSliceSub.add(
			ctx.server.layersStatus
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
						const ctx = SquadServer.resolveSliceCtx(getBaseCtx(), serverId)
						await DB.runTransaction(ctx, (ctx) => processLayerStatusChange(ctx, status, prevStatus))
					}),
				)
				.subscribe(),
		)

		// -------- take editing user out of editing slot on disconnect --------
		ctx.serverSliceSub.add(
			WSSessionSys.disconnect$.pipe(
				C.durableSub('layer-queue:handle-user-disconnect', { ctx, tracer }, async (disconnectedCtx) => {
					const ctx = SquadServer.resolveSliceCtx(disconnectedCtx, serverId)
					const userPresence = ctx.userPresence
					if (userPresence.state.editState && userPresence.state.editState.wsClientId === disconnectedCtx.wsClientId) {
						delete userPresence.state.editState
						userPresence.update$.next({ event: 'edit-end', state: userPresence.state, parts: { users: [] } })
					}
					C.setSpanStatus(Otel.SpanStatusCode.OK)
				}),
			).subscribe(),
		)

		// -------- trim pool filters when filter entities are deleted --------
		ctx.serverSliceSub.add(
			FilterEntity.filterMutation$
				.pipe(
					Rx.filter(([_, mut]) => mut.type === 'delete'),
					C.durableSub('layer-queue:handle-filter-delete', { ctx, tracer, taskScheduling: 'parallel' }, async ([_ctx, mutation]) => {
						const ctx = SquadServer.resolveSliceCtx(_ctx, serverId)
						const updatedServerState = await DB.runTransaction(ctx, async (_ctx) => {
							const serverState = await getServerState(ctx)
							const remainingFilterIds = serverState.settings.queue.mainPool.filters.filter(f => f !== mutation.key)
							if (remainingFilterIds.length === serverState.settings.queue.mainPool.filters.length) return null
							serverState.settings.queue.mainPool.filters = remainingFilterIds
							await ctx.db().update(Schema.servers).set({ settings: serverState.settings }).where(E.eq(Schema.servers.id, serverState.id))

							return serverState
						})

						if (!updatedServerState) return

						ctx.layerQueue.update$.next([{ state: updatedServerState, source: { type: 'system', event: 'filter-delete' } }, ctx])
					}),
				).subscribe(),
		)
	},
)

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
	if (prevStatus != null && !Obj.deepEqual(status.currentLayer, prevStatus.currentLayer)) {
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

export async function handleNewGame(ctx: C.Db & C.Locks & C.SquadServer & C.Vote & C.LayerQueue & C.MatchHistory, eventTime: Date) {
	const serverId = ctx.serverId
	const status = await Rx.firstValueFrom(
		ctx.server.layersStatus.observe(ctx, { ttl: 1_000 }).pipe(
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
				serverId: ctx.serverId,
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
	ctx.server.postRollEventsSub?.unsubscribe()
	ctx.server.postRollEventsSub = new Rx.Subscription()

	// -------- schedule FRAAS auto fog-off --------
	if (currentLayerItem && currentLayerItem.layerId) {
		const currentLayer = L.toLayer(currentLayerItem.layerId)
		if (currentLayer.Gamemode === 'FRAAS') {
			ctx.server.postRollEventsSub.add(
				Rx.timer(CONFIG.fogOffDelay).subscribe(async () => {
					const ctx = SquadServer.resolveSliceCtx(getBaseCtx(), serverId)
					await SquadRcon.setFogOfWar(ctx, 'off')
					void SquadRcon.broadcast(ctx, Messages.BROADCASTS.fogOff)
				}),
			)
		}
	}

	// -------- schedule post-roll announcements --------
	if (CONFIG.servers.find(s => s.id === ctx.serverId)?.remindersAndAnnouncementsEnabled) {
		const announcementTasks: (Rx.Observable<void>)[] = []
		announcementTasks.push(toCold(async () => {
			const ctx = SquadServer.resolveSliceCtx(getBaseCtx(), serverId)
			const historyState = MatchHistory.getPublicMatchHistoryState(ctx)
			const currentMatch = MatchHistory.getCurrentMatch(ctx)
			if (!currentMatch) return
			const mostRelevantEvent = BAL.getHighestPriorityTriggerEvent(MH.getActiveTriggerEvents(historyState))
			if (!mostRelevantEvent) return
			await SquadRcon.warnAllAdmins(ctx, Messages.WARNS.balanceTrigger.showEvent(mostRelevantEvent, currentMatch, { isCurrent: true }))
		}))

		announcementTasks.push(toCold(async () => {
			const ctx = SquadServer.resolveSliceCtx(getBaseCtx(), serverId)
			warnShowNext(ctx, 'all-admins')
		}))

		announcementTasks.push(toCold(async () => {
			const ctx = SquadServer.resolveSliceCtx(getBaseCtx(), serverId)
			const serverState = await getServerState(ctx)
			if (serverState.layerQueue.length <= CONFIG.layerQueue.lowQueueWarningThreshold) {
				await SquadRcon.warnAllAdmins(ctx, Messages.WARNS.queue.lowQueueItemCount(serverState.layerQueue.length))
			}
		}))

		const withWaits: Rx.Observable<unknown>[] = []
		withWaits.push(Rx.timer(CONFIG.postRollAnnouncementsTimeout))

		for (let i = 0; i < announcementTasks.length; i++) {
			withWaits.push(announcementTasks[i].pipe(Rx.catchError(() => Rx.EMPTY)))
			if (i !== announcementTasks.length - 1) {
				withWaits.push(Rx.timer(2000))
			}
		}

		ctx.server.postRollEventsSub.add(Rx.concat(Rx.from(withWaits)).subscribe())
	}
}

async function processLayerStatusChange(
	_ctx: CS.Log & C.Db & C.Tx & C.Locks & C.SquadServer & C.Vote & C.LayerQueue & C.MatchHistory,
	status: LayerStatus,
	prevStatus: LayerStatus | null,
) {
	using ctx = await acquireReentrant(_ctx, _ctx.vote.mtx)
	const eventTime = new Date()
	const serverState = await getServerState(ctx)
	const serverInfoRes = await ctx.server.serverInfo.get(ctx, { ttl: 3_000 })
	if (serverInfoRes.value.code !== 'ok') return serverInfoRes.value
	const serverInfo = serverInfoRes.value.data
	const currentLayerAction = checkForCurrentLayerChangeActions(status, prevStatus, serverState, serverInfo)
	C.setSpanOpAttrs({ currentLayerAction })
	if (!currentLayerAction) return
	switch (currentLayerAction.code) {
		case 'current-layer-changed-with-players:set-server-rolling': {
			SquadServer.state.serverRolling = true
			break
		}
		case 'current-layer-changed-with-no-players:handle-new-game': {
			await handleNewGame(ctx, eventTime)
			break
		}
		default:
			assertNever(currentLayerAction)
	}

	const nextLayerAction = checkForNextLayerStatusActions(status, serverState, SquadServer.state.serverRolling)
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
			if (status.nextLayer) ctx.layerQueue.unexpectedNextLayerSet$.next(status.nextLayer?.id ?? null)
			break
		}
		default:
			assertNever(nextLayerAction)
	}
}

// -------- voting --------
//
async function syncVoteStateWithQueueStateInPlace(
	_ctx: CS.Log & C.Locks & C.SquadServer & C.Vote & C.MatchHistory,
	oldQueue: LL.LayerList,
	newQueue: LL.LayerList,
) {
	if (Obj.deepEqual(oldQueue, newQueue)) return
	using ctx = await acquireReentrant(_ctx, _ctx.vote.mtx)
	const serverId = ctx.serverId
	let newVoteState: V.VoteState | undefined | null

	const oldQueueItem = oldQueue[0] as LL.LayerListItem | undefined
	const newQueueItem = newQueue[0]

	// check if we need to set 'ready'. we only want to do this if there's been a meaningul state change that means we have to initialize it or restart the autostart time. Also if we already have a .endingVoteState we don't want to overwrite that here
	const currentMatch = MatchHistory.getCurrentMatch(ctx)

	const vote = ctx.vote

	if (vote.state?.code === 'in-progress') {
		if (newQueue.some(item => item.itemId === vote.state!.itemId)) return

		// setting to null rather than calling clearVote indicates that a new "ready" vote state might be set instead
		newVoteState = null
	} else if (
		newQueueItem && LL.isParentVoteItem(newQueueItem) && !newQueueItem.endingVoteState
		&& (!oldQueueItem || newQueueItem.itemId !== oldQueueItem.itemId || !LL.isParentVoteItem(oldQueueItem))
		&& currentMatch.status !== 'post-game'
	) {
		let autostartTime: Date | undefined
		if (currentMatch.startTime && CONFIG.vote.autoStartVoteDelay) {
			const startTime = dateFns.addMilliseconds(currentMatch.startTime, CONFIG.vote.autoStartVoteDelay)
			if (dateFns.isFuture(startTime)) autostartTime = startTime
			else autostartTime = dateFns.addMinutes(new Date(), 5)
		}
		newVoteState = {
			code: 'ready',
			choices: newQueueItem.choices.map(choice => choice.layerId),
			itemId: newQueueItem.itemId,
			voterType: vote.state?.voterType ?? 'public',
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

		vote.voteEndTask?.unsubscribe()
		vote.voteEndTask = null
		vote.autostartVoteSub?.unsubscribe()
		vote.autostartVoteSub = null
		if (newVoteState?.code === 'ready' && newVoteState.autostartTime && CONFIG.vote.autoStartVoteDelay) {
			ctx.log.info('scheduling autostart vote to %s for %s', newVoteState.autostartTime.toISOString(), newVoteState.itemId)
			vote.autostartVoteSub = Rx.of(1).pipe(Rx.delay(dateFns.differenceInMilliseconds(newVoteState.autostartTime, Date.now()))).subscribe(
				() => {
					startVote(SquadServer.resolveSliceCtx(C.initLocks(getBaseCtx()), serverId), { initiator: 'autostart' })
				},
			)
		}
		vote.state = newVoteState
		ctx.locks.releaseTasks.push(() => vote.update$.next(update))
	}
}

export const startVote = C.spanOp(
	'layer-queue:vote:start',
	{ tracer, eventLogLevel: 'info', attrs: (_, opts) => opts },
	async (
		_ctx: CS.Log & C.Db & Partial<C.User> & C.Locks & C.SquadServer & C.Vote & C.LayerQueue & C.UserPresence & C.MatchHistory,
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

		using ctx = await acquireReentrant(_ctx, _ctx.vote.mtx)
		const { value: statusRes } = await ctx.server.layersStatus.get(ctx, { ttl: 10_000 })
		if (statusRes.code !== 'ok') {
			return statusRes
		}
		const currentMatch = MatchHistory.getCurrentMatch(ctx)
		if (currentMatch.status === 'post-game') {
			return { code: 'err:vote-not-allowed' as const, msg: Messages.WARNS.vote.start.noVoteInPostGame }
		}

		const duration = opts.duration ?? CONFIG.vote.voteDuration
		const res = await DB.runTransaction(ctx, async (ctx) => {
			const serverState = await getServerState(ctx)
			const newServerState = Obj.deepClone(serverState)
			const itemId = opts.itemId ?? newServerState.layerQueue[0]?.itemId
			if (!itemId) {
				return { code: 'err:item-not-found' as const, msg: Messages.WARNS.vote.start.itemNotFound }
			}

			const initiateVoteRes = V.canInitiateVote(
				itemId,
				newServerState.layerQueue,
				opts.voterType ?? 'public',
				ctx.vote.state ?? undefined,
			)

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

			clearEditing({ ctx })

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

			ctx.vote.autostartVoteSub?.unsubscribe()
			ctx.vote.autostartVoteSub = null

			ctx.vote.state = updatedVoteState
			ctx.locks.releaseTasks.push(() => ctx.vote.update$.next(update))
			registerVoteDeadlineAndReminder$(ctx)
			void broadcastVoteUpdate(
				ctx,
				Messages.BROADCASTS.vote.started(
					ctx.vote.state,
					duration,
					item.displayProps ?? CONFIG.vote.voteDisplayProps,
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
}, (ctx: CS.Log & C.Db & C.SquadServer & C.Vote & C.LayerQueue, msg: SM.ChatMessage) => {
	//
	const choiceIdx = parseInt(msg.message.trim())
	const voteState = ctx.vote.state
	if (!voteState) {
		C.setSpanStatus(Otel.SpanStatusCode.ERROR, 'No vote in progress')
		return
	}
	if (voteState.voterType === 'public') {
		if (msg.chat !== 'ChatAll') {
			void SquadRcon.warn(ctx, msg.playerId, Messages.WARNS.vote.wrongChat('AllChat'))
			return
		}
	}
	if (voteState.voterType === 'internal') {
		if (msg.chat !== 'ChatAdmin') {
			void SquadRcon.warn(ctx, msg.playerId, Messages.WARNS.vote.wrongChat('AdminChat'))
			return
		}
	}
	if (choiceIdx <= 0 || choiceIdx > voteState.choices.length) {
		C.setSpanStatus(Otel.SpanStatusCode.ERROR, 'Invalid choice')
		void SquadRcon.warn(ctx, msg.playerId, Messages.WARNS.vote.invalidChoice)
		return
	}
	if (voteState.code !== 'in-progress') {
		void SquadRcon.warn(ctx, msg.playerId, Messages.WARNS.vote.noVoteInProgress)
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

	ctx.vote.update$.next(update)
	void (async () => {
		const serverState = await getServerState(ctx)
		const voteItem = LL.resolveParentVoteItem(voteState.itemId, serverState.layerQueue)
		SquadRcon.warn(
			ctx,
			msg.playerId,
			Messages.WARNS.vote.voteCast(choice, voteItem?.displayProps ?? CONFIG.vote.voteDisplayProps),
		)
	})()
	C.setSpanStatus(Otel.SpanStatusCode.OK)
})

export const abortVote = C.spanOp(
	'layer-queue:vote:abort',
	{ tracer, eventLogLevel: 'info', attrs: (_, opts) => opts },
	async (_ctx: CS.Log & C.Db & C.Locks & C.SquadServer & C.Vote & C.LayerQueue, opts: { aborter: USR.GuiOrChatUserId }) => {
		using ctx = await acquireReentrant(_ctx, _ctx.vote.mtx)
		const voteState = ctx.vote.state
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
			ctx.vote.state = null
			ctx.locks.releaseTasks.push(() => ctx.vote.update$.next(update))
			ctx.vote.voteEndTask?.unsubscribe()
			ctx.vote.voteEndTask = null
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

export async function cancelVoteAutostart(_ctx: C.Locks & C.Vote, opts: { user: USR.GuiOrChatUserId }) {
	using ctx = await acquireReentrant(_ctx, _ctx.vote.mtx)
	if (ctx.vote.state?.autostartCancelled) {
		return { code: 'err:autostart-already-cancelled' as const, msg: 'Vote is already cancelled' }
	}
	if (!ctx.vote.state || ctx.vote.state.code !== 'ready' || !ctx.vote.state.autostartTime) {
		return { code: 'err:vote-not-queued' as const, msg: 'No vote is currently scheduled' }
	}

	const newVoteState = Obj.deepClone(ctx.vote.state)
	newVoteState.autostartCancelled = true
	delete newVoteState.autostartTime
	ctx.vote.state = newVoteState

	ctx.locks.releaseTasks.push(() => {
		ctx.vote.update$.next({
			source: { type: 'manual', user: opts.user, event: 'autostart-cancelled' },
			state: ctx.vote.state,
		})
	})
	return { code: 'ok' as const }
}

function registerVoteDeadlineAndReminder$(ctx: CS.Log & C.Db & C.SquadServer & C.Vote) {
	const serverId = ctx.serverId
	ctx.vote.voteEndTask?.unsubscribe()

	if (!ctx.vote.state || ctx.vote.state.code !== 'in-progress') return
	ctx.vote.voteEndTask = new Rx.Subscription()

	const currentTime = Date.now()
	const finalReminderWaitTime = Math.max(0, ctx.vote.state.deadline - CONFIG.vote.finalVoteReminder - currentTime)
	const finalReminderBuffer = finalReminderWaitTime - 5 * 1000
	const regularReminderInterval = CONFIG.vote.voteReminderInterval

	// -------- schedule regular reminders --------
	ctx.vote.voteEndTask.add(
		Rx.interval(regularReminderInterval)
			.pipe(
				Rx.takeUntil(Rx.timer(finalReminderBuffer)),
				C.durableSub('layer-queue:regular-vote-reminders', { ctx: getBaseCtx(), tracer }, async () => {
					const ctx = SquadServer.resolveSliceCtx(getBaseCtx(), serverId)
					if (!ctx.vote.state || ctx.vote.state.code !== 'in-progress') return
					const timeLeft = ctx.vote.state.deadline - Date.now()
					const serverState = await getServerState(ctx)
					const voteItem = LL.resolveParentVoteItem(ctx.vote.state.itemId, serverState.layerQueue)
					const msg = Messages.BROADCASTS.vote.voteReminder(
						ctx.vote.state,
						timeLeft,
						ctx.vote.state.choices,
						voteItem?.displayProps ?? CONFIG.vote.voteDisplayProps,
					)
					await broadcastVoteUpdate(ctx, msg, { onlyNotifyNonVotingAdmins: true })
				}),
			)
			.subscribe(),
	)

	// -------- schedule final reminder --------
	if (finalReminderWaitTime > 0) {
		ctx.vote.voteEndTask.add(
			Rx.timer(finalReminderWaitTime).pipe(
				C.durableSub('layer-queue:final-vote-reminder', { ctx: getBaseCtx(), tracer }, async () => {
					const ctx = SquadServer.resolveSliceCtx(getBaseCtx(), serverId)
					if (!ctx.vote.state || ctx.vote.state.code !== 'in-progress') return
					const serverState = await getServerState(ctx)
					const voteItem = LL.resolveParentVoteItem(ctx.vote.state.itemId, serverState.layerQueue)
					const msg = Messages.BROADCASTS.vote.voteReminder(
						ctx.vote.state,
						CONFIG.vote.finalVoteReminder,
						true,
						voteItem?.displayProps ?? CONFIG.vote.voteDisplayProps,
					)
					await broadcastVoteUpdate(ctx, msg, { onlyNotifyNonVotingAdmins: true, repeatWarn: false })
				}),
			).subscribe(),
		)
	}

	// -------- schedule timeout handling --------
	ctx.vote.voteEndTask.add(
		Rx.timer(Math.max(ctx.vote.state.deadline - currentTime, 0)).subscribe({
			next: async () => {
				await handleVoteTimeout(SquadServer.resolveSliceCtx(C.initLocks(getBaseCtx()), serverId))
			},
			complete: () => {
				ctx.log.info('vote deadline reached')
				ctx.vote.voteEndTask = null
			},
		}),
	)
}

const handleVoteTimeout = C.spanOp(
	'layer-queue:vote:handle-timeout',
	{ tracer, eventLogLevel: 'info' },
	async (_ctx: CS.Log & C.Db & C.Locks & C.SquadServer & C.Vote & C.LayerQueue & C.MatchHistory) => {
		using ctx = await acquireReentrant(_ctx, _ctx.vote.mtx)
		const res = await DB.runTransaction(ctx, async (ctx) => {
			if (!ctx.vote.state || ctx.vote.state.code !== 'in-progress') {
				return {
					code: 'err:no-vote-in-progress' as const,
					msg: 'No vote in progress',
					currentVote: ctx.vote.state,
				}
			}
			const serverState = Obj.deepClone(await getServerState(ctx))
			const listItemRes = LL.findItemById(serverState.layerQueue, ctx.vote.state.itemId)
			if (!listItemRes || !LL.isParentVoteItem(listItemRes.item)) throw new Error('Invalid vote item')
			const listItem = listItemRes.item as LL.ParentVoteItem
			let endingVoteState: V.EndingVoteState
			let tally: V.Tally | null = null
			if (Object.values(ctx.vote.state.votes).length === 0) {
				endingVoteState = {
					code: 'ended:insufficient-votes',
					...Obj.selectProps(ctx.vote.state, ['choices', 'itemId', 'deadline', 'votes', 'voterType']),
				}
			} else {
				const { value: serverInfoRes } = await ctx.server.serverInfo.get(ctx, { ttl: 10_000 })
				if (serverInfoRes.code !== 'ok') return serverInfoRes

				const serverInfo = serverInfoRes.data

				tally = V.tallyVotes(ctx.vote.state, serverInfo.playerCount)
				C.setSpanOpAttrs({ tally })

				const winner = tally.leaders[Math.floor(Math.random() * tally.leaders.length)]
				endingVoteState = {
					code: 'ended:winner',
					...Obj.selectProps(ctx.vote.state, ['choices', 'itemId', 'deadline', 'votes', 'voterType']),
					winner,
				}
				listItem.layerId = winner
			}
			listItem.endingVoteState = endingVoteState
			LL.setCorrectChosenLayerIdInPlace(listItem)
			const displayProps = listItem.displayProps ?? CONFIG.vote.voteDisplayProps
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
			ctx.vote.state = null
			const update: V.VoteStateUpdate = {
				state: null,
				source: { type: 'system', event: 'vote-timeout' },
			}
			ctx.locks.releaseTasks.push(() => ctx.vote.update$.next(update))

			await syncNextLayerInPlace(ctx, serverState, { skipDbWrite: true })
			await updatelqServerState(ctx, serverState, { type: 'system', event: 'vote-timeout' })
			return { code: 'ok' as const, endingVoteState, tally }
		})
		return res
	},
)

async function broadcastVoteUpdate(
	ctx: CS.Log & C.SquadServer & C.Vote,
	msg: string,
	opts?: { onlyNotifyNonVotingAdmins?: boolean; repeatWarn?: boolean },
) {
	const repeatWarn = opts?.repeatWarn ?? true
	if (!ctx.vote.state) return
	switch (ctx.vote.state.voterType) {
		case 'public':
			await SquadRcon.broadcast(ctx, msg)
			break
		case 'internal':
			{
				for (let i = 0; i < (repeatWarn ? 3 : 1); i++) {
					await SquadRcon.warnAllAdmins(
						ctx,
						({ player }) => {
							if (!ctx.vote.state || !opts?.onlyNotifyNonVotingAdmins) return msg
							if (!V.isVoteStateWithVoteData(ctx.vote.state)) return
							if (ctx.vote.state.votes[player.steamID.toString()]) return
							return msg
						},
					)
					if (i < 2) await sleep(5000)
				}
			}
			break
		default:
			assertNever(ctx.vote.state.voterType)
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
export async function startEditing({ ctx }: { ctx: C.TrpcRequest & C.SquadServer & C.UserPresence }) {
	const denyRes = await Rbac.tryDenyPermissionsForUser(ctx, ctx.user.discordId, RBAC.perm('queue:write'))
	if (denyRes) return denyRes
	if (ctx.userPresence.state.editState) {
		return { code: 'err:already-editing' as const, userPresence: ctx.userPresence.state }
	}
	const userPresence = Obj.deepClone(ctx.userPresence.state)
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

	ctx.userPresence.state = userPresence
	ctx.userPresence.update$.next(update)

	return { code: 'ok' as const }
}

export function endEditing({ ctx }: { ctx: C.TrpcRequest & C.SquadServer & C.UserPresence }) {
	if (!ctx.userPresence.state.editState || ctx.wsClientId !== ctx.userPresence.state.editState.wsClientId) {
		return { code: 'err:not-editing' as const }
	}
	const userPresence = Obj.deepClone(ctx.userPresence.state)
	delete userPresence.editState
	const update: USR.UserPresenceStateUpdate & Parts<USR.UserPart> = {
		event: 'edit-end',
		state: userPresence,
		parts: {
			users: [ctx.user],
		},
	}
	ctx.userPresence.state = userPresence
	ctx.userPresence.update$.next(update)
	return { code: 'ok' as const }
}

function clearEditing({ ctx }: { ctx: C.UserPresence }) {
	const userPresence = Obj.deepClone(ctx.userPresence.state)
	delete userPresence.editState
	const update: USR.UserPresenceStateUpdate & Parts<USR.UserPart> = {
		event: 'edit-end',
		state: userPresence,
		parts: { users: [] },
	}
	ctx.userPresence.state = userPresence
	ctx.userPresence.update$.next(update)
}

async function kickEditor({ ctx }: { ctx: C.TrpcRequest & C.UserPresence }) {
	const denyRes = await Rbac.tryDenyPermissionsForUser(ctx, ctx.user.discordId, RBAC.perm('queue:write'))
	if (denyRes) return denyRes
	if (!ctx.userPresence.state.editState) {
		return { code: 'err:no-editor' as const }
	}
	const userPresence = Obj.deepClone(ctx.userPresence.state)
	delete userPresence.editState
	const update: USR.UserPresenceStateUpdate & Parts<USR.UserPart> = {
		event: 'edit-kick',
		state: userPresence,
		parts: {
			users: [],
		},
	}
	ctx.userPresence.state = userPresence
	ctx.userPresence.update$.next(update)
	return { code: 'ok' as const }
}

export async function updateQueue(
	{ input, ctx }: {
		input: SS.UserModifiableServerState
		ctx: C.TrpcRequest & C.SquadServer & C.Vote & C.UserPresence & C.LayerQueue & C.MatchHistory
	},
) {
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

		if (!Obj.deepEqual(serverState.layerQueue, input.layerQueue)) {
			const denyRes = await Rbac.tryDenyPermissionsForUser(ctx, ctx.user.discordId, {
				check: 'all',
				permits: [RBAC.perm('queue:write')],
			})
			if (denyRes) return denyRes
		}

		if (!Obj.deepEqual(serverState.settings, input.settings)) {
			const denyRes = await Rbac.tryDenyPermissionsForUser(ctx, ctx.user.discordId, {
				check: 'all',
				permits: [RBAC.perm('settings:write')],
			})
			if (denyRes) return denyRes
		}

		for (const item of input.layerQueue) {
			if (LL.isParentVoteItem(item) && item.choices.length > CONFIG.vote.maxNumVoteChoices) {
				return {
					code: 'err:too-many-vote-choices' as const,
					msg: `Max choices allowed is ${CONFIG.vote.maxNumVoteChoices}`,
				}
			}
		}

		if (input.layerQueue.length > CONFIG.layerQueue.maxQueueSize) {
			return { code: 'err:queue-too-large' as const }
		}

		for (const item of input.layerQueue) {
			if (LL.isParentVoteItem(item) && item.choices.length > CONFIG.vote.maxNumVoteChoices) {
				return {
					code: 'err:too-many-vote-choices' as const,
					msg: `Max choices allowed is ${CONFIG.vote.maxNumVoteChoices}`,
				}
			}
			if (
				LL.isParentVoteItem(item)
				&& !V.validateChoicesWithDisplayProps(item.choices.map(c => c.layerId), item.displayProps ?? CONFIG.vote.voteDisplayProps)
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

export async function getServerState(ctx: C.Db & CS.Log & C.LayerQueue) {
	const query = ctx.db().select().from(Schema.servers).where(E.eq(Schema.servers.id, ctx.serverId))
	let serverRaw: any
	if (ctx.tx) [serverRaw] = await query.for('update')
	else [serverRaw] = await query
	return SS.ServerStateSchema.parse(unsuperjsonify(Schema.servers, serverRaw))
}

export async function updatelqServerState(
	ctx: C.Db & C.Tx & C.SquadServer & C.LayerQueue,
	changes: Partial<SS.LQServerState>,
	source: SS.LQStateUpdate['source'],
) {
	const serverState = await getServerState(ctx)
	const newServerState = { ...serverState, ...changes }
	if (changes.layerQueueSeqId && changes.layerQueueSeqId !== serverState.layerQueueSeqId) {
		throw new Error('Invalid layer queue sequence ID')
	}
	newServerState.layerQueueSeqId = serverState.layerQueueSeqId + 1
	await ctx.db().update(Schema.servers)
		.set(superjsonify(Schema.servers, { ...changes, layerQueueSeqId: newServerState.layerQueueSeqId }))
		.where(E.eq(Schema.servers.id, ctx.serverId))
	const update: SS.LQStateUpdate = { state: newServerState, source }

	// we can't pass the transaction context to subscribers
	ctx.tx.unlockTasks.push(() => ctx.layerQueue.update$.next([update, DB.addPooledDb({ log: baseLogger })]))
	return newServerState
}

export async function warnShowNext(
	ctx: C.Db & CS.Log & C.SquadServer & C.LayerQueue,
	playerId: string | 'all-admins',
	opts?: { repeat?: number },
) {
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
		await SquadRcon.warnAllAdmins(ctx, Messages.WARNS.queue.showNext(layerQueue, parts, { repeat: opts?.repeat ?? 1 }))
	} else {
		await SquadRcon.warn(ctx, playerId, Messages.WARNS.queue.showNext(layerQueue, parts, { repeat: opts?.repeat ?? 1 }))
	}
}

async function includeLQServerUpdateParts(
	ctx: C.Db & CS.Log & C.MatchHistory,
	_serverStateUpdate: SS.LQStateUpdate,
): Promise<SS.LQStateUpdate & Partial<Parts<USR.UserPart & LQY.LayerItemStatusesPart>>> {
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

async function includeUserPartForLQServerUpdate(ctx: C.Db & CS.Log, update: SS.LQStateUpdate) {
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

async function includeLayerItemStatusesForLQServerUpdate(
	ctx: CS.Log & C.MatchHistory,
	update: SS.LQStateUpdate,
): Promise<LQY.LayerItemStatusesPart> {
	const queryCtx = LayerQueriesServer.resolveLayerQueryCtx(ctx, update.state)
	const constraints = SS.getPoolConstraints(update.state.settings.queue.mainPool)
	const statusRes = await LayerQueries.getLayerItemStatuses({ ctx: queryCtx, input: { constraints } })
	if (statusRes.code !== 'ok') {
		ctx.log.error(`Failed to get layer item statuses: ${JSON.stringify(statusRes)}`)
		return {
			layerItemStatuses: { blocked: new Map(), present: new Set(), violationDescriptors: new Map() },
		}
	}
	return { layerItemStatuses: statusRes.statuses }
}

/**
 * sets next layer on server, generating a new queue item if needed. modifies serverState in place.
 */
async function syncNextLayerInPlace<NoDbWrite extends boolean>(
	ctx: CS.Log & C.Db & (NoDbWrite extends true ? object : C.Tx) & C.SquadServer & C.LayerQueue & C.MatchHistory,
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
			await updatelqServerState(ctx as C.Db & C.SquadServer & C.LayerQueue & C.Tx, serverState, {
				type: 'system',
				event: 'next-layer-generated',
			})
		}
		wroteServerState = true
	}
	const currentStatusRes = (await ctx.server.layersStatus.get(ctx)).value
	if (currentStatusRes.code !== 'ok') return currentStatusRes
	if (!serverState.settings.updatesToSquadServerDisabled) {
		const res = await SquadRcon.setNextLayer(ctx, nextLayerId)
		switch (res.code) {
			case 'err:unable-to-set-next-layer':
				ctx.layerQueue.unexpectedNextLayerSet$.next(res.unexpectedLayerId)
				break
			case 'err:rcon':
			case 'ok':
				ctx.layerQueue.unexpectedNextLayerSet$.next(null)
				break
			default:
				assertNever(res)
		}
	}
	return wroteServerState
}

export async function toggleUpdatesToSquadServer(
	{ ctx, input }: { ctx: CS.Log & C.Db & C.SquadServer & C.UserOrPlayer & C.LayerQueue; input: { disabled: boolean } },
) {
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

	await SquadRcon.warnAllAdmins(ctx, Messages.WARNS.slmUpdatesSet(!input.disabled))
	return { code: 'ok' as const }
}

export async function getSlmUpdatesEnabled(ctx: CS.Log & C.Db & C.UserOrPlayer & C.SquadServer & C.LayerQueue) {
	const serverState = await getServerState(ctx)
	return { code: 'ok' as const, enabled: !serverState.settings.updatesToSquadServerDisabled }
}

export async function requestFeedback(
	ctx: CS.Log & C.Db & C.SquadServer & C.LayerQueue,
	username: string,
	layerQueueNumber: string | undefined,
) {
	const serverState = await getServerState(ctx)
	let index: LL.LLItemIndex | undefined
	if (serverState.layerQueue.length === 0) return { code: 'err:empty' as const }
	if (layerQueueNumber === undefined) index = LL.iterLayerList(serverState.layerQueue).next().value
	else index = LL.resolveLayerQueueItemIndexForNumber(serverState.layerQueue, layerQueueNumber) ?? undefined
	if (!index) return { code: 'err:not-found' as const }
	const item = LL.resolveItemForIndex(serverState.layerQueue, index)!
	await SquadRcon.warnAllAdmins(ctx, Messages.WARNS.queue.requestFeedback(index, username, item))
	return { code: 'ok' as const }
}

export function getBaseCtx() {
	return C.initLocks(DB.addPooledDb({ log: baseLogger }))
}

// -------- setup router --------
export const layerQueueRouter = router({
	watchLayerQueueState: procedure.subscription(async function*({ ctx, signal }) {
		const obs = SquadServer.selectedServerCtx$(ctx).pipe(
			Rx.switchMap(ctx => {
				return ctx.layerQueue.update$.pipe(
					Rx.mergeMap(async ([update]) => {
						const withParts = await includeLQServerUpdateParts(ctx, update)
						withParts.state = Obj.deepClone(update.state)
						delete withParts.state.settings.connections
						return withParts
					}),
				)
			}),
			withAbortSignal(signal!),
		)

		yield* toAsyncGenerator(obs)
	}),

	watchVoteStateUpdates: procedure.subscription(async function*({ ctx, signal }) {
		const obs = SquadServer.selectedServerCtx$(ctx).pipe(
			Rx.switchMap(async function*(ctx) {
				let initialState: (V.VoteState & Parts<USR.UserPart>) | null = null
				const voteState = ctx.vote.state
				if (voteState) {
					const ids = getVoteStateDiscordIds(voteState)
					const users = await ctx.db().select().from(Schema.users).where(E.inArray(Schema.users.discordId, ids))
					initialState = { ...voteState, parts: { users } }
				}
				yield { code: 'initial-state' as const, state: initialState } satisfies V.VoteStateUpdateOrInitialWithParts
				for await (const update of toAsyncGenerator(ctx.vote.update$)) {
					const withParts = await includeVoteStateUpdatePart(getBaseCtx(), update)
					yield { code: 'update' as const, update: withParts } satisfies V.VoteStateUpdateOrInitialWithParts
				}
			}),
			withAbortSignal(signal!),
		)

		yield* toAsyncGenerator(obs)
	}),

	watchUnexpectedNextLayer: procedure.subscription(async function*({ ctx, signal }) {
		const obs = SquadServer.selectedServerCtx$(ctx).pipe(
			Rx.switchMap(ctx => {
				return ctx.layerQueue.unexpectedNextLayerSet$
			}),
			withAbortSignal(signal!),
		)
		yield* toAsyncGenerator(obs)
	}),

	startVote: procedure
		.input(V.StartVoteInputSchema)
		.mutation(async ({ input, ctx: _ctx }) => {
			const ctx = SquadServer.resolveWsClientSliceCtx(_ctx)
			return startVote(ctx, { ...input, initiator: { discordId: ctx.user.discordId } })
		}),

	abortVote: procedure.mutation(async ({ ctx: _ctx }) => {
		const ctx = SquadServer.resolveWsClientSliceCtx(_ctx)
		const denyRes = await Rbac.tryDenyPermissionsForUser(ctx, ctx.user.discordId, { check: 'all', permits: [RBAC.perm('vote:manage')] })
		if (denyRes) return denyRes
		return await abortVote(ctx, { aborter: { discordId: ctx.user.discordId } })
	}),

	cancelVoteAutostart: procedure.mutation(async ({ ctx: _ctx }) => {
		const ctx = SquadServer.resolveWsClientSliceCtx(_ctx)
		const denyRes = await Rbac.tryDenyPermissionsForUser(ctx, ctx.user.discordId, { check: 'all', permits: [RBAC.perm('vote:manage')] })
		if (denyRes) return denyRes
		return await cancelVoteAutostart(ctx, { user: { discordId: ctx.user.discordId } })
	}),

	startEditing: procedure.mutation(async ({ ctx: _ctx }) => {
		const ctx = SquadServer.resolveWsClientSliceCtx(_ctx)
		return startEditing({ ctx })
	}),
	endEditing: procedure.mutation(async ({ ctx: _ctx }) => {
		const ctx = SquadServer.resolveWsClientSliceCtx(_ctx)
		return endEditing({ ctx })
	}),
	kickEditor: procedure.mutation(async ({ ctx: _ctx }) => {
		const ctx = SquadServer.resolveWsClientSliceCtx(_ctx)
		return kickEditor({ ctx })
	}),

	watchUserPresence: procedure.subscription(async function*({ ctx, signal }) {
		const obs = SquadServer.selectedServerCtx$(ctx)
			.pipe(
				Rx.switchMap(async function*(ctx) {
					const users: USR.User[] = []
					if (ctx.userPresence.state.editState) {
						const [user] = await ctx.db().select().from(Schema.users).where(
							E.eq(Schema.users.discordId, ctx.userPresence.state.editState.userId),
						)
						users.push(user)
					}
					yield { code: 'initial-state' as const, state: ctx.userPresence.state, parts: { users } } satisfies any & Parts<USR.UserPart>
					for await (const update of toAsyncGenerator(ctx.userPresence.update$)) {
						yield { code: 'update' as const, update }
					}
				}),
				withAbortSignal(signal!),
			)

		return yield* toAsyncGenerator(obs)
	}),

	updateQueue: procedure.input(SS.GenericServerStateUpdateSchema).mutation(async ({ input, ctx: _ctx }) => {
		const ctx = SquadServer.resolveWsClientSliceCtx(_ctx)
		return updateQueue({ input, ctx })
	}),

	toggleUpdatesToSquadServer: procedure.input(z.object({ disabled: z.boolean() })).mutation(async ({ ctx: _ctx, input }) => {
		const ctx = SquadServer.resolveWsClientSliceCtx(_ctx)
		return await toggleUpdatesToSquadServer({ ctx, input })
	}),
})
