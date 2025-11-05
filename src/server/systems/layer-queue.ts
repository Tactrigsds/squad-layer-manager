import * as Schema from '$root/drizzle/schema.ts'
import { acquireReentrant, sleep, toAsyncGenerator, toCold, withAbortSignal } from '@/lib/async.ts'
import * as DH from '@/lib/display-helpers.ts'
import { superjsonify, unsuperjsonify } from '@/lib/drizzle'
import * as Obj from '@/lib/object'
import { assertNever } from '@/lib/type-guards.ts'
import { Parts, toEmpty } from '@/lib/types'
import { HumanTime } from '@/lib/zod.ts'
import * as Messages from '@/messages.ts'
import * as BAL from '@/models/balance-triggers.models.ts'
import * as CS from '@/models/context-shared'
import * as L from '@/models/layer'
import * as LL from '@/models/layer-list.models'
import * as LQY from '@/models/layer-queries.models.ts'
import * as MH from '@/models/match-history.models'
import * as SS from '@/models/server-state.models'
import * as SME from '@/models/squad-models.events.ts'
import * as SM from '@/models/squad.models.ts'
import * as USR from '@/models/users.models'
import * as V from '@/models/vote.models.ts'
import * as RBAC from '@/rbac.models.ts'
import { CONFIG } from '@/server/config.ts'
import * as C from '@/server/context'
import * as DB from '@/server/db.ts'
import { baseLogger } from '@/server/logger.ts'
import orpcBase from '@/server/orpc-base'
import * as LayerQueriesServer from '@/server/systems/layer-queries.server.ts'
import * as MatchHistory from '@/server/systems/match-history.ts'
import * as Rbac from '@/server/systems/rbac.system.ts'
import * as SquadRcon from '@/server/systems/squad-rcon'
import * as SquadServer from '@/server/systems/squad-server.ts'
import * as LayerQueries from '@/systems.shared/layer-queries.shared.ts'
import * as Otel from '@opentelemetry/api'

import { Mutex } from 'async-mutex'
import * as dateFns from 'date-fns'
import { _AddUndefinedToPossiblyUndefinedPropertiesOfInterface } from 'discord.js'
import * as E from 'drizzle-orm/expressions'
import * as Rx from 'rxjs'
import { z } from 'zod'
import * as Users from './users'

export type VoteContext = {
	voteEndTask: Rx.Subscription | null
	autostartVoteSub: Rx.Subscription | null
	mtx: Mutex
	state: V.VoteState | null
	update$: Rx.Subject<V.VoteStateUpdate>
}

export type LayerQueueContext = {
	unexpectedNextLayerSet$: Rx.BehaviorSubject<L.LayerId | null>

	update$: Rx.ReplaySubject<[SS.LQStateUpdate, CS.Log & C.Db & C.ServerId]>
}

export function initLayerQueueContext(): LayerQueueContext {
	return {
		unexpectedNextLayerSet$: new Rx.BehaviorSubject<L.LayerId | null>(null),
		update$: new Rx.ReplaySubject(1),
	}
}

const tracer = Otel.trace.getTracer('layer-queue')
export const init = C.spanOp(
	'layer-queue:init',
	{ tracer, eventLogLevel: 'info' },
	async (ctx: CS.Log & C.Db & C.ServerSlice & C.Mutexes) => {
		const serverId = ctx.serverId
		await DB.runTransaction(ctx, async (_ctx) => {
			using ctx = await acquireReentrant(_ctx, _ctx.vote.mtx)
			const s = ctx.layerQueue

			const initialServerState = await SquadServer.getFullServerState(ctx)

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
						if (ctx.server.serverRolling$.value || currentMatch.status === 'post-game') return
						if (
							LL.isVoteItem(serverState.layerQueue[0])
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

		// -------- make sure next layer set is synced with queue --------
		const nextSetLayer$ = ctx.server.layersStatus
			.observe(ctx)
			.pipe(
				Rx.concatMap((statusRes): Rx.Observable<L.UnvalidatedLayer | null> =>
					statusRes.code === 'ok' ? Rx.of(statusRes.data.nextLayer) : Rx.EMPTY
				),
				Rx.distinctUntilChanged((a, b) => a?.id === b?.id),
			)

		const nextQueuedLayer$ = ctx.layerQueue.update$.pipe(Rx.map(([update]) => LL.getNextLayerId(update.state.layerQueue) ?? null))

		Rx.combineLatest([
			nextSetLayer$,
			nextQueuedLayer$,
		]).pipe(
			C.durableSub('layer-queue:sync-next-layer-status', { tracer, ctx }, async ([nextSet, nextQueued]) => {
				if ((nextSet?.id ?? null) === nextQueued) return
				const ctx = SquadServer.resolveSliceCtx(getBaseCtx(), serverId)

				// this case will be dealt with in handleNewGame, so can ignore it here
				if (ctx.server.serverRolling$.value) return

				await DB.runTransaction(ctx, async (ctx) => {
					const serverState = await getServerState(ctx)
					await syncNextLayerInPlace(ctx, serverState)
				})
			}),
		).subscribe()
	},
)

export async function handleNewGame(
	_ctx: C.Db & C.Mutexes & C.SquadServer & C.Vote & C.LayerQueue & C.MatchHistory,
	newLayer: L.UnvalidatedLayer,
	newGameEvent?: SME.NewGame,
) {
	if (newGameEvent && newGameEvent?.layerClassname !== newLayer.Layer) {
		_ctx.log.warn(`Layers do not match: ${newGameEvent.layerClassname} !== ${newLayer.Layer}. discarding new game event`)
		newGameEvent = undefined
	}

	using ctx = await acquireReentrant(_ctx, _ctx.vote.mtx, _ctx.matchHistory.mtx)

	const eventTime = newGameEvent?.time ?? new Date()

	const serverId = ctx.serverId

	const res = await DB.runTransaction(ctx, async (ctx) => {
		const serverState = await getServerState(ctx)
		const nextLqItem = serverState.layerQueue[0]

		let currentMatchLqItem: LL.Item | undefined
		const newServerState = Obj.deepClone(serverState)
		newServerState.lastRoll = new Date()
		if (nextLqItem && L.areLayersCompatible(nextLqItem.layerId, newLayer.id)) {
			currentMatchLqItem = newServerState.layerQueue.shift()
		}
		const newLayerId = currentMatchLqItem?.layerId ?? newLayer.id

		await MatchHistory.addNewCurrentMatch(
			ctx,
			MH.getNewMatchHistoryEntry({
				layerId: newLayerId,
				serverId: ctx.serverId,
				startTime: eventTime,
				lqItem: currentMatchLqItem,
			}),
		)
		await syncNextLayerInPlace(ctx, newServerState, { skipDbWrite: true })
		await syncVoteStateWithQueueStateInPlace(ctx, serverState.layerQueue, newServerState.layerQueue)
		await updateServerState(ctx, newServerState, { type: 'system', event: 'server-roll' })
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

// -------- voting --------
//
async function syncVoteStateWithQueueStateInPlace(
	_ctx: CS.Log & C.Mutexes & C.SquadServer & C.Vote & C.MatchHistory,
	oldQueue: LL.List,
	newQueue: LL.List,
) {
	if (Obj.deepEqual(oldQueue, newQueue)) return
	using ctx = await acquireReentrant(_ctx, _ctx.vote.mtx)
	const serverId = ctx.serverId
	let newVoteState: V.VoteState | undefined | null

	const oldQueueItem = oldQueue[0] as LL.Item | undefined
	const newQueueItem = newQueue[0]

	// check if we need to set 'ready'. we only want to do this if there's been a meaningul state change that means we have to initialize it or restart the autostart time. Also if we already have a .endingVoteState we don't want to overwrite that here
	const currentMatch = MatchHistory.getCurrentMatch(ctx)

	const vote = ctx.vote

	if (vote.state?.code === 'in-progress') {
		if (newQueue.some(item => item.itemId === vote.state!.itemId)) return

		// setting to null rather than calling clearVote indicates that a new "ready" vote state might be set instead
		newVoteState = null
	} else if (
		newQueueItem && LL.isVoteItem(newQueueItem) && !newQueueItem.endingVoteState
		&& (!oldQueueItem || newQueueItem.itemId !== oldQueueItem.itemId || !LL.isVoteItem(oldQueueItem))
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
	} else if (!newQueueItem || !LL.isVoteItem(newQueueItem)) {
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
		ctx.mutexes.releaseTasks.push(() => vote.update$.next(update))
	}
}

export const startVote = C.spanOp(
	'layer-queue:vote:start',
	{ tracer, eventLogLevel: 'info', attrs: (_, opts) => opts },
	async (
		_ctx: CS.Log & C.Db & Partial<C.User> & C.Mutexes & C.SquadServer & C.Vote & C.LayerQueue & C.MatchHistory,
		opts: V.StartVoteInput & { initiator: USR.GuiOrChatUserId | 'autostart' },
	) => {
		if (_ctx.user !== undefined) {
			// @ts-expect-error cringe
			const denyRes = await Rbac.tryDenyPermissionsForUser(_ctx, RBAC.perm('vote:manage'))
			if (denyRes) {
				return denyRes
			}
		}

		using ctx = await acquireReentrant(_ctx, _ctx.vote.mtx)
		const statusRes = await ctx.server.layersStatus.get(ctx, { ttl: 10_000 })
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

			const item = initiateVoteRes.item
			delete item.endingVoteState
			LL.setCorrectChosenLayerIdInPlace(item)
			await updateServerState(ctx, newServerState, { event: 'vote-start', type: 'system' })

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
			ctx.mutexes.releaseTasks.push(() => ctx.vote.update$.next(update))
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
	async (_ctx: CS.Log & C.Db & C.Mutexes & C.SquadServer & C.Vote & C.LayerQueue, opts: { aborter: USR.GuiOrChatUserId }) => {
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
			ctx.mutexes.releaseTasks.push(() => ctx.vote.update$.next(update))
			ctx.vote.voteEndTask?.unsubscribe()
			ctx.vote.voteEndTask = null
			const layerQueue = Obj.deepClone(serverState.layerQueue)
			const { item } = toEmpty(LL.findItemById(layerQueue, newVoteState.itemId))
			if (!item || !LL.isVoteItem(item)) throw new Error('vote item not found or is invalid')
			item.endingVoteState = newVoteState
			LL.setCorrectChosenLayerIdInPlace(item)
			await updateServerState(ctx, { layerQueue }, { event: 'vote-abort', type: 'system' })

			return { code: 'ok' as const }
		})
	},
)

export async function cancelVoteAutostart(_ctx: C.Mutexes & C.Vote, opts: { user: USR.GuiOrChatUserId }) {
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

	ctx.mutexes.releaseTasks.push(() => {
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
	async (_ctx: CS.Log & C.Db & C.Mutexes & C.SquadServer & C.Vote & C.LayerQueue & C.MatchHistory) => {
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
			const { item: listItem } = toEmpty(LL.findItemById(serverState.layerQueue, ctx.vote.state.itemId))
			if (!listItem || !LL.isVoteItem(listItem)) throw new Error('Invalid vote item')
			let endingVoteState: V.EndingVoteState
			let tally: V.Tally | null = null
			if (Object.values(ctx.vote.state.votes).length === 0) {
				endingVoteState = {
					code: 'ended:insufficient-votes',
					...Obj.selectProps(ctx.vote.state, ['choices', 'itemId', 'deadline', 'votes', 'voterType']),
				}
			} else {
				const serverInfoRes = await ctx.server.serverInfo.get(ctx, { ttl: 10_000 })
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
			ctx.mutexes.releaseTasks.push(() => ctx.vote.update$.next(update))

			await syncNextLayerInPlace(ctx, serverState, { skipDbWrite: true })
			await updateServerState(ctx, serverState, { type: 'system', event: 'vote-timeout' })
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
	const dbUsers = await ctx.db().select().from(Schema.users).where(E.inArray(Schema.users.discordId, discordIdsArray))
	const users = await Promise.all(dbUsers.map(user => Users.buildUser(ctx, user)))
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

export async function updateQueue(
	{ input, ctx }: {
		input: { layerQueue: LL.List; layerQueueSeqId: number }
		ctx: C.OrpcBase & C.SquadServer & C.Vote & C.LayerQueue & C.MatchHistory
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

		for (const item of input.layerQueue) {
			if (LL.isVoteItem(item) && item.choices.length > CONFIG.vote.maxNumVoteChoices) {
				return {
					code: 'err:too-many-vote-choices' as const,
					msg: `Max choices allowed is ${CONFIG.vote.maxNumVoteChoices}`,
				}
			}
		}

		if (input.layerQueue.length > CONFIG.layerQueue.maxQueueSize) {
			return {
				code: 'err:queue-too-large' as const,
				msg: ` Queue size exceeds maximum limit (${input.layerQueue.length}/${CONFIG.layerQueue.maxQueueSize})`,
			}
		}

		for (const item of input.layerQueue) {
			if (LL.isVoteItem(item) && item.choices.length > CONFIG.vote.maxNumVoteChoices) {
				return {
					code: 'err:too-many-vote-choices' as const,
					msg: `Max choices allowed is ${CONFIG.vote.maxNumVoteChoices}`,
				}
			}
			if (
				LL.isVoteItem(item)
				&& !V.validateChoicesWithDisplayProps(item.choices.map(c => c.layerId), item.displayProps ?? CONFIG.vote.voteDisplayProps)
			) {
				return {
					code: 'err:not-enough-visible-info' as const,
					msg: "Can't distinguish between vote choices.",
				}
			}
		}

		serverState.layerQueue = input.layerQueue

		await syncNextLayerInPlace(ctx, serverState, { skipDbWrite: true })
		await syncVoteStateWithQueueStateInPlace(ctx, serverStatePrev.layerQueue, serverState.layerQueue)

		const update = await updateServerState(ctx, serverState, { type: 'manual', user: { discordId: ctx.user.discordId }, event: 'edit' })

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

export async function updateServerState(
	ctx: C.Db & C.Tx & C.SquadServer & C.LayerQueue,
	changes: Partial<SS.ServerState>,
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
	ctx.tx.unlockTasks.push(() => ctx.layerQueue.update$.next([update, { ...getBaseCtx(), serverId: ctx.serverId }]))
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
		parts.users.push(await Users.buildUser(ctx, user))
	}
	if (playerId === 'all-admins') {
		await SquadRcon.warnAllAdmins(ctx, Messages.WARNS.queue.showNext(layerQueue, parts, { repeat: opts?.repeat ?? 1 }))
	} else {
		await SquadRcon.warn(ctx, playerId, Messages.WARNS.queue.showNext(layerQueue, parts, { repeat: opts?.repeat ?? 1 }))
	}
}

/**
 * sets next layer on server, generating a new queue item if needed. modifies serverState in place.
 */
async function syncNextLayerInPlace<NoDbWrite extends boolean>(
	ctx: CS.Log & C.Db & (NoDbWrite extends true ? object : C.Tx) & C.SquadServer & C.LayerQueue & C.MatchHistory,
	serverState: SS.ServerState,
	opts?: { skipDbWrite: NoDbWrite },
) {
	let nextLayerId = LL.getNextLayerId(serverState.layerQueue)
	let wroteServerState = false
	if (!nextLayerId) {
		const constraints = SS.getSettingsConstraints(serverState.settings)
		const layerCtx = LayerQueriesServer.resolveLayerQueryCtx(ctx, serverState)

		const res = await LayerQueries.queryLayers({
			ctx: layerCtx,
			input: { constraints, pageSize: 1, sort: { type: 'random', seed: LQY.getSeed() } },
		})
		if (res.code !== 'ok') throw new Error(`Failed to query layers: ${JSON.stringify(res)}`)
		const ids = res.layers.map(layer => layer.id)
		;[nextLayerId] = ids
		if (!nextLayerId) return false
		const nextQueueItem = LL.createLayerListItem({ layerId: nextLayerId }, { type: 'generated' })
		serverState.layerQueue.push(nextQueueItem)
		if (!opts?.skipDbWrite) {
			await updateServerState(ctx as C.Db & C.SquadServer & C.LayerQueue & C.Tx, serverState, {
				type: 'system',
				event: 'next-layer-generated',
			})
		}
		wroteServerState = true
	}
	const currentStatusRes = await ctx.server.layersStatus.get(ctx)
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
		const denyRes = await Rbac.tryDenyPermissionsForUser({ ...ctx, user: ctx.user! }, RBAC.perm('squad-server:disable-slm-updates'))
		if (denyRes) return denyRes
	}

	await DB.runTransaction(ctx, async ctx => {
		const serverState = await getServerState(ctx)
		serverState.settings.updatesToSquadServerDisabled = input.disabled
		await updateServerState(ctx, { settings: serverState.settings }, { type: 'system', event: 'updates-to-squad-server-toggled' })
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
	playerName: string,
	layerQueueNumber: string | undefined,
) {
	const serverState = await getServerState(ctx)
	let index: LL.ItemIndex | undefined
	if (serverState.layerQueue.length === 0) return { code: 'err:empty' as const }
	if (layerQueueNumber === undefined) index = LL.iterItems(...serverState.layerQueue).next().value
	else index = LL.resolveLayerQueueItemIndexForNumber(layerQueueNumber) ?? undefined
	if (!index) return { code: 'err:not-found' as const }
	const item = LL.resolveItemForIndex(serverState.layerQueue, index)!
	await SquadRcon.warnAllAdmins(ctx, Messages.WARNS.queue.requestFeedback(index, playerName, item))
	return { code: 'ok' as const }
}

function getBaseCtx() {
	return C.initLocks(DB.addPooledDb({ log: baseLogger }))
}

// -------- setup router --------
export const orpcRouter = {
	watchVoteStateUpdates: orpcBase.handler(async function*({ context, signal }) {
		const obs = SquadServer.selectedServerCtx$(context).pipe(
			Rx.switchMap(async function*(ctx) {
				let initialState: (V.VoteState & Parts<USR.UserPart>) | null = null
				const voteState = ctx.vote.state
				if (voteState) {
					const ids = getVoteStateDiscordIds(voteState)
					const users = await Users.buildUsers(
						ctx,
						await ctx.db().select().from(Schema.users).where(E.inArray(Schema.users.discordId, ids)),
					)
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

	watchUnexpectedNextLayer: orpcBase.handler(async function*({ context, signal }) {
		const obs = SquadServer.selectedServerCtx$(context).pipe(
			Rx.switchMap(ctx => {
				return ctx.layerQueue.unexpectedNextLayerSet$
			}),
			withAbortSignal(signal!),
		)
		yield* toAsyncGenerator(obs)
	}),

	startVote: orpcBase
		.input(V.StartVoteInputSchema)
		.handler(async ({ input, context: _ctx }) => {
			const ctx = SquadServer.resolveWsClientSliceCtx(_ctx)
			return startVote(ctx, { ...input, initiator: { discordId: ctx.user.discordId } })
		}),

	abortVote: orpcBase.handler(async ({ context: _ctx }) => {
		const ctx = SquadServer.resolveWsClientSliceCtx(_ctx)
		const denyRes = await Rbac.tryDenyPermissionsForUser(ctx, RBAC.perm('vote:manage'))
		if (denyRes) return denyRes
		return await abortVote(ctx, { aborter: { discordId: ctx.user.discordId } })
	}),

	cancelVoteAutostart: orpcBase.handler(async ({ context: _ctx }) => {
		const ctx = SquadServer.resolveWsClientSliceCtx(_ctx)
		const denyRes = await Rbac.tryDenyPermissionsForUser(ctx, RBAC.perm('vote:manage'))
		if (denyRes) return denyRes
		return await cancelVoteAutostart(ctx, { user: { discordId: ctx.user.discordId } })
	}),

	toggleUpdatesToSquadServer: orpcBase
		.input(z.object({ disabled: z.boolean() }))
		.handler(async ({ context: _ctx, input }) => {
			const ctx = SquadServer.resolveWsClientSliceCtx(_ctx)
			return await toggleUpdatesToSquadServer({ ctx, input })
		}),
}
