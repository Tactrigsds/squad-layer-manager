import * as Schema from '$root/drizzle/schema.ts'
import { acquireInBlock, distinctDeepEquals, toAsyncGenerator, toCold, withAbortSignal } from '@/lib/async.ts'
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

const voteStateUpdate$ = new Rx.Subject<[CS.Log & C.Db, V.VoteStateUpdate]>()

const userPresence: USR.UserPresenceState = {}
const userPresenceUpdate$ = new Rx.Subject<USR.UserPresenceStateUpdate & Parts<USR.UserPart>>()

let postRollEventsSub: Rx.Subscription | undefined

const voteStateMtx = new Mutex()

const tracer = Otel.trace.getTracer('layer-queue')
export const setup = C.spanOp('layer-queue:setup', { tracer, eventLogLevel: 'info' }, async () => {
	const log = baseLogger
	const ctx = DB.addPooledDb({ log })
	ctx.log.info('setting up layer queue and server state')

	// -------- bring server up to date with configuration --------
	await DB.runTransaction(ctx, async (ctx) => {
		ctx.log.info('in transaction')
		// eslint-disable-next-line @typescript-eslint/no-unused-vars
		using acquired = await acquireInBlock(voteStateMtx)
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
		if (server.displayName !== CONFIG.serverDisplayName) {
			await ctx
				.db()
				.update(Schema.servers)
				.set({
					displayName: CONFIG.serverDisplayName,
				})
				.where(E.eq(Schema.servers.id, CONFIG.serverId))
			server.displayName = CONFIG.serverDisplayName
		}

		const initialServerState = SS.ServerStateSchema.parse(server)
		ctx.log.info('initial servers tate parsed')

		// -------- prune main pool filters when filter entities are deleted  --------
		let mainPoolFilterIds = initialServerState.settings.queue.mainPool.filters
		const filters = await ctx.db().select().from(Schema.filters).where(E.inArray(Schema.filters.id, mainPoolFilterIds)).for('update')
		mainPoolFilterIds = mainPoolFilterIds.filter(id => filters.some(filter => filter.id === id))
		initialServerState.settings.queue.mainPool.filters = mainPoolFilterIds

		serverStateUpdate$.next([{ state: initialServerState, source: { type: 'system', event: 'app-startup' } }, ctx])

		// -------- initialize vote state --------
		const update = getVoteStateUpdatesFromQueueUpdate([], initialServerState.layerQueue, voteState)
		if (update.code === 'ok') {
			voteState = update.update.state
			voteStateUpdate$.next([ctx, update.update])
		}
		ctx.log.info('vote state initialized')
	})
	ctx.log.info('initial update complete')

	// -------- set next layer on server when rcon is connected--------
	SquadServer.rcon.core.connected$.pipe(
		C.durableSub('layer-queue:set-next-layer-on-connected', { ctx, tracer, eventLogLevel: 'info' }, async (isConnected) => {
			if (!isConnected) return
			const serverState = await getServerState({}, ctx)
			await syncNextLayerInPlace(ctx, serverState)
			C.setSpanStatus(Otel.SpanStatusCode.OK)
		}),
	).subscribe()

	serverStateUpdate$.subscribe(([state, ctx]) => {
		ctx.log.debug({ seqId: state.state.layerQueueSeqId }, 'pushing server state update')
	})

	// -------- schedule generic admin reminders --------
	Rx.interval(CONFIG.reminders.adminQueueReminderInterval).pipe(
		C.durableSub('layer-queue:queue-reminders', { ctx, tracer }, async () => {
			const serverState = await getServerState({}, ctx)
			if (
				LL.isParentVoteItem(serverState.layerQueue[0])
				&& voteState?.code === 'ready'
				&& SquadServer.state.lastRoll.getTime() + CONFIG.reminders.startVoteReminderThreshold < Date.now()
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
				const serverState = await getServerState({}, ctx)
				const expectedLayerName = DH.toFullLayerNameFromId(LL.getNextLayerId(serverState.layerQueue)!)
				const actualLayerName = DH.toFullLayerNameFromId(expectedNextLayerId)
				await SquadServer.warnAllAdmins(
					ctx,
					`Current next layer on the server is out-of-sync with queue. Got ${actualLayerName}, but expected ${expectedLayerName}`,
				)
			}),
		).subscribe()

	// -------- Interpret current/next layer updates from the game server for the purposes of syncing it with the queue  --------
	type LayerStatus = { currentLayer: L.UnvalidatedLayer; nextLayer: L.UnvalidatedLayer | null }
	type LayerStatusWithPrev = [LayerStatus | null, LayerStatus | null]

	SquadServer.rcon.layersStatus
		.observe(ctx)
		.pipe(
			Rx.filter((statusRes) => statusRes.code === 'ok'),
			Rx.map((statusRes): LayerStatus => ({ currentLayer: statusRes.data.currentLayer, nextLayer: statusRes.data.nextLayer })),
			distinctDeepEquals(),
			Rx.scan((withPrev, status): LayerStatusWithPrev => [status, withPrev[0]], [null, null] as LayerStatusWithPrev),
			C.durableSub('layer-queue:check-layer-status-change', { ctx, tracer, root: true }, async ([status, prevStatus]) => {
				C.setSpanOpAttrs({ status, prevStatus })
				if (!status) return
				await DB.runTransaction(ctx, (ctx) => processLayerStatusChange(ctx, status, prevStatus))
				C.setSpanStatus(Otel.SpanStatusCode.OK)
			}),
		)
		.subscribe()

	async function processLayerStatusChange(ctx: CS.Log & C.Db & C.Tx, status: LayerStatus, prevStatus: LayerStatus | null) {
		const serverState = await getServerState({ lock: true }, ctx)
		const action = checkforStatusChangeActions(status, prevStatus, serverState)
		switch (action.code) {
			case 'correct-layer-set:no-action':
			case 'sync-disabled:no-action':
			case 'no-next-layer-set:no-action':
				break
			case 'expected-new-current-layer:roll':
				await handleServerRoll(ctx, serverState)
				break
			case 'layer-change-with-empty-queue:buffer-next-match-context': {
				// the SquadServer system is expecting "buffered" match details just before map roll. in this case since we don't have an actual layer queue item that we're rolling to so we'll just generate a generic one. Not strictly necessary right now but will serve as a placeholder for future functionality.
				const item = LL.createLayerListItem({
					layerId: status.currentLayer.id,
					source: { type: 'unknown' },
				})
				SquadServer.bufferNextMatchLQItem(item)
				break
			}
			case 'current-layer-changed:reset':
				// unclear if this can even be hit at the moment
				await handleAdminChangeLayer(ctx, serverState)
				break
			case 'unknown-layer-set:no-action':
				break
			case 'unexpected-layer-change:reset':
			case 'null-layer-set:reset': {
				await syncNextLayerInPlace(ctx, serverState)
				break
			}
			default:
				assertNever(action)
		}
		C.setSpanStatus(Otel.SpanStatusCode.OK)
	}

	const handleServerRoll = C.spanOp(
		'layer-queue:handle-server-roll',
		{ tracer, eventLogLevel: 'info' },
		async (baseCtx: CS.Log & C.Db & C.Tx, prevServerState: SS.LQServerState) => {
			baseCtx.log.info('Attempting to handle roll to next layer')
			C.setSpanOpAttrs({ prevQueueLength: prevServerState.layerQueue.length })
			// eslint-disable-next-line @typescript-eslint/no-unused-vars
			using acquired = await acquireInBlock(voteStateMtx)
			const serverState = Obj.deepClone(prevServerState)
			if (prevServerState.layerQueue.length === 0) {
				C.setSpanStatus(Otel.SpanStatusCode.ERROR, 'No layers in queue to roll to')
				return
			}
			const currentLayerItem = serverState.layerQueue.shift()
			const currentLayerId = currentLayerItem?.layerId
			postRollEventsSub?.unsubscribe()
			postRollEventsSub = new Rx.Subscription()

			// -------- schedule FRAAS auto fog-off --------
			if (currentLayerItem && currentLayerId) {
				const currentLayer = L.toLayer(currentLayerId)
				if (currentLayer.Gamemode === 'FRAAS') {
					postRollEventsSub.add(
						Rx.timer(CONFIG.fogOffDelay).subscribe(async () => {
							await SquadServer.rcon.setFogOfWar(ctx, 'off')
							await SquadServer.rcon.broadcast(ctx, Messages.BROADCASTS.fogOff)
						}),
					)
				}
			}
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
				const serverState = await getServerState({}, ctx)
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

			SquadServer.bufferNextMatchLQItem(currentLayerItem!)
			const updateRes = getVoteStateUpdatesFromQueueUpdate(prevServerState.layerQueue, serverState.layerQueue, voteState, true)
			switch (updateRes.code) {
				case 'noop':
				case 'err:queue-change-during-vote':
					break
				case 'ok':
					voteState = updateRes.update.state
					voteStateUpdate$.next([baseCtx, updateRes.update])
					break
				default:
					assertNever(updateRes)
			}
			serverState.lastRoll = new Date()
			await syncNextLayerInPlace(baseCtx, serverState, { noDbWrite: true })
			await baseCtx
				.db()
				.update(Schema.servers)
				.set(superjsonify(Schema.servers, serverState))
				.where(E.eq(Schema.servers.id, CONFIG.serverId))
			serverStateUpdate$.next([{ state: serverState, source: { type: 'system', event: 'server-roll' } }, baseCtx])
			C.setSpanStatus(Otel.SpanStatusCode.OK)
		},
	)

	const handleAdminChangeLayer = C.spanOp(
		'layer-queue:handle-admin-change-layer',
		{ tracer },
		async (baseCtx: CS.Log & C.Db & C.Tx, serverState: SS.LQServerState) => {
			C.setSpanOpAttrs({ serverState })
			// the new current layer was set to something unexpected, so we just handle updating the next layer
			const time = new Date()

			await syncNextLayerInPlace(baseCtx, serverState, { noDbWrite: true })

			serverState.lastRoll = time
			await baseCtx
				.db()
				.update(Schema.servers)
				.set(superjsonify(Schema.servers, serverState))
				.where(E.eq(Schema.servers.id, CONFIG.serverId))

			serverStateUpdate$.next([{ state: serverState, source: { type: 'system', event: 'admin-change-layer' } }, baseCtx])
			C.setSpanStatus(Otel.SpanStatusCode.OK)
		},
	)

	/**
	 * Determines how to respond to the next layer potentially having been set on the gameserver, bringing it out of sync with the queue
	 * This function isn't super necessarry atm as we don't allow AdminSetNextLayer overrides in any case anymore, but leaving here in case we want to change this later.
	 */
	function checkforStatusChangeActions(
		status: LayerStatus,
		prevStatus: LayerStatus | null,
		serverState: SS.LQServerState,
	) {
		if (serverState.settings.updatesToSquadServerDisabled) return { code: 'sync-disabled:no-action' as const }
		const lqNextLayerId = LL.getNextLayerId(serverState.layerQueue)
		if (prevStatus != null && !deepEqual(status.currentLayer, prevStatus.currentLayer)) {
			if (!lqNextLayerId) {
				return { code: 'layer-change-with-empty-queue:buffer-next-match-context' as const }
			} else if (L.areLayersCompatible(status.currentLayer.id, lqNextLayerId)) {
				// new current layer was expected, so we just need to roll
				return { code: 'expected-new-current-layer:roll' as const }
			} else {
				return { code: 'current-layer-changed:reset' as const }
			}
		}

		if (status.nextLayer === null) return { code: 'null-layer-set:reset' as const }
		if (!status.nextLayer) return { code: 'unknown-layer-set:no-action' as const }

		if (!lqNextLayerId) return { code: 'no-next-layer-set:no-action' as const }
		if (L.areLayersCompatible(status.nextLayer, lqNextLayerId)) return { code: 'correct-layer-set:no-action' as const }
		return { code: 'unexpected-layer-change:reset' as const, expectedNextLayerId: lqNextLayerId }
	}

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
					const serverState = await getServerState({ lock: true }, ctx)
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

// -------- voting --------
//
function getVoteStateUpdatesFromQueueUpdate(
	lastQueue: LL.LayerList,
	newQueue: LL.LayerList,
	voteState: V.VoteState | null,
	force = false,
) {
	const lastQueueItem = lastQueue[0] as LL.LayerListItem | undefined
	const newQueueItem = newQueue[0]

	if ((!lastQueueItem || !LL.isParentVoteItem(lastQueueItem)) && !LL.isParentVoteItem(newQueueItem)) return { code: 'noop' as const }

	if (!deepEqual(lastQueueItem, newQueueItem) && voteState?.code === 'in-progress' && !force) {
		return { code: 'err:queue-change-during-vote' as const }
	}

	if (lastQueueItem && LL.isParentVoteItem(lastQueueItem) && LL.isParentVoteItem(newQueueItem)) {
		return {
			code: 'ok' as const,
			update: { state: null, source: { type: 'system', event: 'queue-change' } } satisfies V.VoteStateUpdate,
		}
	}

	if (newQueueItem && newQueueItem.choices && !deepEqual(lastQueueItem?.choices, newQueueItem.choices)) {
		let newVoteState: V.VoteState
		if (lastQueueItem?.itemId === newQueueItem.itemId) {
			newVoteState = {
				...(voteState ?? { code: 'ready' }),
				choices: newQueueItem.choices.map(choice => choice.layerId),
				itemId: newQueueItem.itemId,
			}
		} else {
			newVoteState = {
				code: 'ready',
				choices: newQueueItem.choices.map(choice => choice.layerId),
				itemId: newQueueItem.itemId,
			}
		}
		return {
			code: 'ok' as const,
			update: {
				state: newVoteState,
				source: { type: 'system', event: 'queue-change' },
			} satisfies V.VoteStateUpdate,
		}
	}

	return { code: 'noop' as const }
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
	{ tracer, eventLogLevel: 'info' },
	async (
		ctx: CS.Log & C.Db & Partial<C.User>,
		opts: { durationSeconds?: number; initiator: USR.GuiOrChatUserId },
	) => {
		C.setSpanOpAttrs(opts)
		if (ctx.user) {
			const denyRes = await Rbac.tryDenyPermissionsForUser(ctx, ctx.user.discordId, {
				check: 'all',
				permits: [RBAC.perm('vote:manage')],
			})
			if (denyRes) {
				C.setSpanStatus(Otel.SpanStatusCode.ERROR, 'Permission denied')
				return denyRes
			}
		}

		// eslint-disable-next-line @typescript-eslint/no-unused-vars
		using acquired = await acquireInBlock(voteStateMtx)
		const { value: statusRes } = await SquadServer.rcon.layersStatus.get(ctx, { ttl: 10_000 })
		if (statusRes.code !== 'ok') {
			C.setSpanStatus(Otel.SpanStatusCode.ERROR, 'Failed to get server status')
			return statusRes
		}

		const durationSeconds = opts.durationSeconds ?? CONFIG.defaults.voteDuration / 1000
		const res = await DB.runTransaction(ctx, async (ctx) => {
			if (!voteState) {
				return {
					code: 'err:no-vote-exists' as const,
					msg: Messages.WARNS.vote.start.noVoteConfigured,
				}
			}

			if (voteState.code === 'in-progress') {
				return {
					code: 'err:vote-in-progress' as const,
					msg: Messages.WARNS.vote.start.voteAlreadyInProgress,
				}
			}

			{
				const serverState = await getServerState({ lock: true }, ctx)
				serverStateUpdate$.next([{ state: serverState, source: { type: 'system', event: 'vote-start' } }, ctx])
			}

			const updatedVoteState = {
				code: 'in-progress',
				...Obj.selectProps(voteState, ['choices', 'itemId']),
				deadline: Date.now() + durationSeconds * 1000,
				votes: {},
				initiator: opts.initiator,
			} satisfies V.VoteState

			ctx.log.info('registering vote deadline')
			const update = {
				state: updatedVoteState,
				source: {
					type: 'manual',
					event: 'start-vote',
					user: opts.initiator,
				},
			} satisfies V.VoteStateUpdate

			return { code: 'ok' as const, voteStateUpdate: update }
		})

		if (res.code !== 'ok') {
			return res
		}

		voteState = res.voteStateUpdate.state
		voteStateUpdate$.next([ctx, res.voteStateUpdate])
		registerVoteDeadlineAndReminder$(ctx)
		await SquadServer.rcon.broadcast(
			ctx,
			Messages.BROADCASTS.vote.started(
				res.voteStateUpdate.state.choices,
				V.getDefaultChoice(res.voteStateUpdate.state),
				durationSeconds * 1000,
			),
		)

		return res
	},
)

export const handleVote = C.spanOp('layer-queue:vote:handle-vote', { tracer }, async (ctx: CS.Log & C.Db, msg: SM.ChatMessage) => {
	// no need to acquire vote mutex here, this is a safe operation
	C.setSpanOpAttrs({ messageId: msg.message, playerId: msg.playerId })

	const choiceIdx = parseInt(msg.message.trim())
	if (!voteState) {
		C.setSpanStatus(Otel.SpanStatusCode.ERROR, 'No vote in progress')
		return
	}
	if (choiceIdx <= 0 || choiceIdx > voteState.choices.length) {
		C.setSpanStatus(Otel.SpanStatusCode.ERROR, 'Invalid choice')
		await SquadServer.rcon.warn(ctx, msg.playerId, Messages.WARNS.vote.invalidChoice)
		return
	}
	if (voteState.code !== 'in-progress') {
		await SquadServer.rcon.warn(ctx, msg.playerId, Messages.WARNS.vote.noVoteInProgress)
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
	await SquadServer.rcon.warn(ctx, msg.playerId, Messages.WARNS.vote.voteCast(choice))
	C.setSpanStatus(Otel.SpanStatusCode.OK)
})

export const abortVote = C.spanOp(
	'layer-queue:vote:abort',
	{ tracer, eventLogLevel: 'info' },
	async (ctx: CS.Log & C.Db, opts: { aborter: USR.GuiOrChatUserId }) => {
		C.setSpanOpAttrs(opts)
		// eslint-disable-next-line @typescript-eslint/no-unused-vars
		using acquired = await acquireInBlock(voteStateMtx)

		if (!voteState || voteState?.code !== 'in-progress') {
			return {
				code: 'err:no-vote-in-progress' as const,
			}
		}

		const newVoteState: V.VoteState = {
			choices: voteState.choices,
			itemId: voteState.itemId,
			deadline: voteState.deadline,
			votes: voteState.votes,
			code: 'ended:aborted',
			aborter: opts.aborter,
		}

		const update: V.VoteStateUpdate = {
			state: newVoteState,
			source: { type: 'manual', user: opts.aborter, event: 'abort-vote' },
		}
		voteState = newVoteState
		voteStateUpdate$.next([ctx, update])
		voteEndTask?.unsubscribe()
		voteEndTask = null
		await SquadServer.rcon.broadcast(ctx, Messages.BROADCASTS.vote.aborted(V.getDefaultChoice(voteState)))

		return { code: 'ok' as const }
	},
)

function registerVoteDeadlineAndReminder$(ctx: CS.Log & C.Db) {
	voteEndTask?.unsubscribe()

	if (!voteState || voteState.code !== 'in-progress') return
	voteEndTask = new Rx.Subscription()

	const finalReminderWaitTime = Math.max(0, voteState.deadline - CONFIG.reminders.finalVote - Date.now())
	const finalReminderBuffer = finalReminderWaitTime - 5 * 1000
	const regularReminderInterval = CONFIG.reminders.voteReminderInterval

	// -------- schedule regular reminders --------
	voteEndTask.add(
		Rx.interval(regularReminderInterval)
			.pipe(
				Rx.takeUntil(Rx.timer(finalReminderBuffer)),
				C.durableSub('layer-queue:regular-vote-reminders', { ctx, tracer }, async () => {
					if (!voteState || voteState.code !== 'in-progress') return
					const timeLeft = voteState.deadline - Date.now()
					await SquadServer.rcon.broadcast(ctx, Messages.BROADCASTS.vote.voteReminder(timeLeft, voteState.choices))
				}),
			)
			.subscribe(),
	)

	// -------- schedule final reminder --------
	if (finalReminderWaitTime > 0) {
		voteEndTask.add(
			Rx.timer(finalReminderWaitTime).pipe(
				C.durableSub('layer-queue:final-vote-reminder', { ctx, tracer }, async () => {
					if (!voteState || voteState.code !== 'in-progress') return
					await SquadServer.rcon.broadcast(
						ctx,
						Messages.BROADCASTS.vote.voteReminder(CONFIG.reminders.finalVote, voteState.choices, true),
					)
				}),
			).subscribe(),
		)
	}

	// -------- schedule timeout handling --------
	voteEndTask.add(
		Rx.timer(Math.max(voteState.deadline - Date.now(), 0)).subscribe({
			next: async () => {
				await handleVoteTimeout(ctx)
			},
			complete: () => {
				ctx.log.info('vote deadline reached')
				voteEndTask = null
			},
		}),
	)
}

const handleVoteTimeout = C.spanOp('layer-queue:vote:handle-timeout', { tracer, eventLogLevel: 'info' }, async (ctx: CS.Log & C.Db) => {
	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	using acquired = await acquireInBlock(voteStateMtx)
	const res = await DB.runTransaction(ctx, async (ctx) => {
		const serverState = Obj.deepClone(await getServerState({ lock: true }, ctx))
		if (!voteState || voteState.code !== 'in-progress') {
			return {
				code: 'err:no-vote-in-progress' as const,
				msg: 'No vote in progress',
				currentVote: voteState,
			}
		}
		let newVoteState: V.VoteState
		let voteUpdate: V.VoteStateUpdate
		let tally: V.Tally | null = null
		if (Object.values(voteState.votes).length === 0) {
			newVoteState = {
				code: 'ended:insufficient-votes',
				...Obj.selectProps(voteState, ['choices', 'itemId', 'deadline', 'votes']),
			}
			voteUpdate = {
				source: { type: 'system', event: 'vote-timeout' },
				state: newVoteState,
			}
		} else {
			const { value: serverInfoRes } = await SquadServer.rcon.serverInfo.get(ctx, { ttl: 10_000 })
			if (serverInfoRes.code !== 'ok') return serverInfoRes

			const serverInfo = serverInfoRes.data

			tally = V.tallyVotes(voteState, serverInfo.playerCount)
			C.setSpanOpAttrs({ tally })

			const winner = tally.leaders[Math.floor(Math.random() * tally.leaders.length)]
			serverState.layerQueue[0].layerId = winner
			newVoteState = {
				code: 'ended:winner',
				...Obj.selectProps(voteState, ['choices', 'itemId', 'deadline', 'votes']),
				winner,
			}
			voteUpdate = {
				source: { type: 'system', event: 'vote-timeout' },
				state: newVoteState,
			}
		}
		await ctx.db().update(Schema.servers).set(superjsonify(Schema.servers, serverState)).where(
			E.eq(Schema.servers.id, CONFIG.serverId),
		)
		return { code: 'ok' as const, serverState, voteUpdate, tally }
	})

	if (res.code !== 'ok') return res

	const update: SS.LQServerStateUpdate = {
		state: res.serverState,
		source: { type: 'system', event: 'vote-timeout' },
	}
	serverStateUpdate$.next([update, ctx])
	voteState = res.voteUpdate.state
	voteStateUpdate$.next([ctx, res.voteUpdate])
	if (res.voteUpdate.state!.code === 'ended:winner') {
		await syncNextLayerInPlace(ctx, update.state, { noDbWrite: true })
		await SquadServer.rcon.broadcast(ctx, Messages.BROADCASTS.vote.winnerSelected(res.tally!, res.voteUpdate.state!.winner))
	}
	if (res.voteUpdate!.state!.code === 'ended:insufficient-votes') {
		await SquadServer.rcon.broadcast(ctx, Messages.BROADCASTS.vote.insufficientVotes(V.getDefaultChoice(res.voteUpdate.state!)))
	}
	return res
})

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
		case 'ended:winner':
		case 'ended:insufficient-votes':
		case 'ready': {
			break
		}
		case 'ended:aborted': {
			if (state.aborter.discordId) discordIds.push(state.aborter.discordId)
			break
		}
		case 'in-progress': {
			if (state.initiator.discordId) discordIds.push(state.initiator.discordId)
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

async function kickEditor({ ctx }: { ctx: C.TrpcRequest }) {
	const denyRes = await Rbac.tryDenyPermissionsForUser(ctx, ctx.user.discordId, RBAC.perm('queue:write'))
	if (denyRes) return denyRes
	if (!userPresence.editState) {
		return { code: 'err:no-editor' as const }
	}
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
	C.setSpanOpAttrs({ input })
	input = Obj.deepClone(input)
	const res = await DB.runTransaction(ctx, async (ctx) => {
		const serverStatePrev = await getServerState({ lock: true }, ctx)
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

		if (input.layerQueue.length > CONFIG.maxQueueSize) {
			return { code: 'err:queue-too-large' as const }
		}

		for (const item of input.layerQueue) {
			if (LL.isParentVoteItem(item) && item.choices.length === 0) {
				return { code: 'err:empty-vote' as const }
			}
			if (LL.isParentVoteItem(item) && item.choices.length > CONFIG.maxNumVoteChoices) {
				return {
					code: 'err:too-many-vote-choices' as const,
					msg: `Max choices allowed is ${CONFIG.maxNumVoteChoices}`,
				}
			}

			const choiceSet = new Set<string>()
			if (LL.isParentVoteItem(item)) {
				for (const choice of item.choices) {
					if (choiceSet.has(choice.layerId)) {
						return {
							code: 'err:duplicate-vote-choices' as const,
							msg: `Duplicate choice: ${choice}`,
						}
					}
					choiceSet.add(choice.layerId)
				}
			}
		}

		// TODO need to implement queue:force-write via a structural diff on the changed layerIds

		serverState.settings = input.settings
		serverState.layerQueue = input.layerQueue
		serverState.layerQueueSeqId++

		await syncNextLayerInPlace(ctx, serverState, { noDbWrite: true })

		const voteUpdateRes = getVoteStateUpdatesFromQueueUpdate(serverStatePrev.layerQueue, serverState.layerQueue, voteState)

		switch (voteUpdateRes.code) {
			case 'err:queue-change-during-vote':
				return { code: 'err:queue-change-during-vote' as const }
			case 'noop':
				break
			case 'ok': {
				voteState = voteUpdateRes.update.state
				voteStateUpdate$.next([ctx, voteUpdateRes.update])
			}
		}

		await ctx.db().update(Schema.servers).set(superjsonify(Schema.servers, serverState)).where(
			E.eq(Schema.servers.id, CONFIG.serverId),
		)
		endEditing({ ctx })

		return { code: 'ok' as const, serverState }
	})
	if (res.code !== 'ok') return res

	const update: SS.LQServerStateUpdate = {
		state: res.serverState,
		source: { type: 'manual', user: { discordId: ctx.user.discordId }, event: 'edit' },
	}
	serverStateUpdate$.next([update, ctx])

	return { code: 'ok' as const, serverStateUpdate: update }
}

// -------- utility --------
export async function getServerState({ lock }: { lock?: boolean }, ctx: C.Db & CS.Log) {
	lock ??= false
	const query = ctx.db().select().from(Schema.servers).where(E.eq(Schema.servers.id, CONFIG.serverId))
	let serverRaw: any
	if (lock) [serverRaw] = await query.for('update')
	else [serverRaw] = await query
	return SS.ServerStateSchema.parse(unsuperjsonify(Schema.servers, serverRaw))
}

export async function warnShowNext(ctx: C.Db & CS.Log, playerId: string | 'all-admins', opts?: { repeat?: number }) {
	const serverState = await getServerState({}, ctx)
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
 * sets next layer on server, generating a new queue item if needed. modifies serverState in place
 */
async function syncNextLayerInPlace<NoDbWrite extends boolean>(
	ctx: CS.Log & C.Db & (NoDbWrite extends true ? object : C.Tx),
	serverState: SS.LQServerState,
	opts?: { noDbWrite: NoDbWrite },
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
		serverState.layerQueueSeqId++
		if (!opts?.noDbWrite) {
			await ctx.db().update(Schema.servers).set(superjsonify(Schema.servers, {
				layerQueue: serverState.layerQueue,
				layerQueueSeqId: serverState.layerQueueSeqId,
			})).where(E.eq(Schema.servers.id, serverState.id))
			serverStateUpdate$.next([{ state: serverState, source: { type: 'system', event: 'next-layer-generated' } }, ctx])
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
		const serverState = await getServerState({ lock: true }, ctx)
		serverState.settings.updatesToSquadServerDisabled = input.disabled
		await ctx.db().update(Schema.servers).set(superjsonify(Schema.servers, { settings: serverState.settings }))
		serverStateUpdate$.next([{ state: serverState, source: { type: 'system', event: 'updates-to-squad-server-toggled' } }, ctx])
	})

	await SquadServer.warnAllAdmins(ctx, Messages.WARNS.slmUpdatesSet(!input.disabled))
	return { code: 'ok' as const }
}

export async function getSlmUpdatesEnabled(ctx: CS.Log & C.Db & C.UserOrPlayer) {
	const serverState = await getServerState({ lock: true }, ctx)
	return { code: 'ok' as const, enabled: !serverState.settings.updatesToSquadServerDisabled }
}

// -------- setup router --------
export const layerQueueRouter = router({
	watchLayerQueueState: procedure.subscription(watchLayerQueueStateUpdates),
	watchVoteStateUpdates: procedure.subscription(watchVoteStateUpdates),
	watchUnexpectedNextLayer: procedure.subscription(watchUnexpectedNextLayer),
	startVote: procedure
		.input(V.AdvancedVoteConfigSchema)
		.mutation(async ({ input, ctx }) => startVote(ctx, { ...input, initiator: { discordId: ctx.user.discordId } })),
	abortVote: procedure.mutation(async ({ ctx }) => {
		const denyRes = await Rbac.tryDenyPermissionsForUser(ctx, ctx.user.discordId, { check: 'all', permits: [RBAC.perm('vote:manage')] })
		if (denyRes) return denyRes
		return await abortVote(ctx, { aborter: { discordId: ctx.user.discordId } })
	}),

	startEditing: procedure.mutation(startEditing),
	endEditing: procedure.mutation(endEditing),
	kickEditor: procedure.mutation(kickEditor),

	watchUserPresence: procedure.subscription(watchUserPresence),

	updateQueue: procedure.input(SS.GenericServerStateUpdateSchema).mutation(updateQueue),
	toggleUpdatesToSquadServer: procedure.input(z.object({ disabled: z.boolean() })).mutation(toggleUpdatesToSquadServer),
})
