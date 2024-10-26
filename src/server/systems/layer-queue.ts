import { TRPCError } from '@trpc/server'
import { Mutex } from 'async-mutex'
import { eq } from 'drizzle-orm'
import deepEqual from 'fast-deep-equal'
import {
	BehaviorSubject,
	Observable,
	Subscription,
	combineLatest,
	distinctUntilChanged,
	endWith,
	exhaustMap,
	filter,
	firstValueFrom,
	interval,
	map,
	of,
	shareReplay,
	startWith,
	switchMap,
	timeout,
} from 'rxjs'
import StringComparison from 'string-comparison'

import { toAsyncGenerator, traceTag } from '@/lib/async.ts'
import * as DisplayHelpers from '@/lib/display-helpers.ts'
import { deepClone } from '@/lib/object'
import * as SM from '@/lib/rcon/squad-models'
import * as M from '@/models.ts'
import { CONFIG } from '@/server/config.ts'
import * as C from '@/server/context'
import * as DB from '@/server/db.ts'
import { baseLogger } from '@/server/logger.ts'
import * as S from '@/server/schema.ts'
import * as SquadServer from '@/server/systems/squad-server'

const pollingRates = {
	normal: interval(3000),
	fast: interval(1000),
}
const serverInfoPollingRate$ = new BehaviorSubject('normal' as keyof typeof pollingRates)
let expectedCurrentLayer$!: BehaviorSubject<string | undefined>
let expectedNextLayer$!: Observable<string | undefined>
let serverState$!: BehaviorSubject<[M.ServerState, C.Log]>
let nowPlayingState$: Observable<M.LayerSyncState>
let nextLayerState$: Observable<M.LayerSyncState>
let pollServerInfo$!: Observable<SM.ServerStatus>
let voteEndTask: Subscription | null = null
export async function setupLayerQueue() {
	const log = baseLogger.child({ ctx: 'layer-queue' })
	const ctx = { log }
	const db = DB.get(ctx)

	// -------- bring server up to date with configuration --------
	const server = await db.transaction(async (db) => {
		let [server] = await db.select().from(S.servers).where(eq(S.servers.id, CONFIG.serverId)).for('update')
		if (!server) {
			await db.insert(S.servers).values({ id: CONFIG.serverId, displayName: CONFIG.serverDisplayName })
			;[server] = await db.select().from(S.servers).where(eq(S.servers.id, CONFIG.serverId))
		}
		if (server.displayName !== CONFIG.serverDisplayName) {
			await db.update(S.servers).set({ displayName: CONFIG.serverDisplayName }).where(eq(S.servers.id, CONFIG.serverId))
			server.displayName = CONFIG.serverDisplayName
		}
		return server
	})

	serverState$ = new BehaviorSubject([M.ServerStateSchema.parse(server), { log }])
	expectedCurrentLayer$ = new BehaviorSubject(undefined as string | undefined)

	pollServerInfo$ = serverInfoPollingRate$.pipe(
		traceTag('pollServerInfo$'),
		distinctUntilChanged(),

		// dynamic polling rate.
		switchMap((rate) => pollingRates[rate]),

		// perform request when polling rate changes or on initial subscription
		startWith(0),

		// don't repoll while a previous poll is in progress
		exhaustMap(SquadServer.getServerStatus),

		distinctUntilChanged((a, b) => deepEqual(a, b)),

		// subscribers immediately get last polled state if one is available
		shareReplay(1)
	)

	const squadServerCurrentLayer$ = pollServerInfo$.pipe(
		map((info) => info.currentLayer.id),
		endWith(null)
	)
	const squadServerNextLayer$ = pollServerInfo$.pipe(
		map((info) => info.nextLayer?.id),
		endWith(null)
	)

	nowPlayingState$ = combineLatest([expectedCurrentLayer$, squadServerCurrentLayer$]).pipe(
		traceTag('nowPlayingState$'),
		map(([expected, current]): M.LayerSyncState => {
			return getLayerSyncState(expected, current, ctx)
		}),
		distinctUntilChanged((a, b) => deepEqual(a, b)),
		shareReplay(1)
	)

	expectedNextLayer$ = serverState$.pipe(
		map(([s]) => s.layerQueue[0]?.layerId),
		filter((id) => !!id)
	)

	nextLayerState$ = combineLatest([expectedNextLayer$, squadServerNextLayer$]).pipe(
		traceTag('nextLayerState$'),
		// for now this is the exact same as nowPlayingState, unsure if we will need to change it in future
		map(([expected, current]): M.LayerSyncState => {
			return getLayerSyncState(expected, current, ctx)
		}),
		distinctUntilChanged((a, b) => deepEqual(a, b)),
		shareReplay(1)
	)

	// -------- keep squad server state in line with ours --------
	nowPlayingState$.subscribe(async function syncCurrentLayer(syncState) {
		if (syncState.status === 'desynced') {
			await SquadServer.rcon.setNextLayer(M.getMiniLayerFromId(syncState.expected))
			await SquadServer.rcon.endGame()
		}
	})

	nextLayerState$.subscribe(async function syncNextLayer(syncState) {
		if (syncState.status === 'desynced') {
			await SquadServer.rcon.setNextLayer(M.getMiniLayerFromId(syncState.expected))
		}
	})

	SquadServer.squadEvent$.subscribe(async (event) => {
		const _log = log.child({ msgEventId: event.eventId })
		const db = DB.get({ log: _log })
		_log.debug('received squad server event: %s, (id: %s)', event.type, event.eventId, event)
		const ctx = { db, log: _log }
		if (event.type === 'game-ended') {
			let updated: M.ServerState | undefined
			await db.transaction(async (db) => {
				const ctx = { db, log: _log }
				const serverState = await getServerState({ lock: true }, ctx)
				const nowPlayingLayer = await SquadServer.rcon.getNextLayer()
				if (nowPlayingLayer === null) throw new Error('game ended when no next layer set')
				if (serverState.layerQueue[0] && serverState.layerQueue[0].layerId !== nowPlayingLayer.id) {
					_log.warn("layerIds for next layer on squad server and our application don't match on game end")
					return
				}

				const updatedState = deepClone(serverState)
				expectedCurrentLayer$.next(nowPlayingLayer.id)
				updatedState.layerQueue.shift()
				updatedState.layerQueueSeqId++
				await db.update(S.servers).set({ layerQueue: updatedState.layerQueue, layerQueueSeqId: updatedState.layerQueueSeqId })
				updated = updatedState
			})
			if (updated) serverState$.next([updated, ctx])
		}

		if (event.type === 'chat-message' && event.message.startsWith(CONFIG.commandPrefix)) {
			handleCommand(event, ctx)
		}
		if (event.type === 'chat-message' && event.message.match(/^\d+$/)) {
			handleVote(event, ctx)
		}
	})
}

async function getServerState({ lock }: { lock: boolean }, ctx: C.Db) {
	const query = ctx.db.select().from(S.servers).where(eq(S.servers.id, CONFIG.serverId))
	let serverRaw: S.Server | undefined
	if (lock) [serverRaw] = await query.for('update')
	else [serverRaw] = await query
	return M.ServerStateSchema.parse(serverRaw)
}

async function handleCommand(evt: SM.SquadEvent & { type: 'chat-message' }, ctx: C.Log) {
	const words = evt.message.split(/\s+/)
	const cmdText = words[0].slice(1)
	const args = words.slice(1)
	const allCommandStrings = Object.values(CONFIG.commands)
		.map((c) => c.strings)
		.flat()
	if (!allCommandStrings.includes(cmdText)) {
		const sortedMatches = StringComparison.diceCoefficient.sortMatch(cmdText, allCommandStrings)
		SquadServer.rcon.warn(evt.playerId, `Unknown command "${cmdText}". Did you mean ${sortedMatches[0]}?`)
		return
	}

	if (CONFIG.commands.showNext.strings.includes(cmdText)) {
		const server = await getServerState({ lock: false }, { ...ctx, db: DB.get(ctx) })
		const nextLayer = await SquadServer.rcon.getNextLayer()
		if (!nextLayer) {
			SquadServer.rcon.warn(evt.playerId, 'No next layer set')
			return
		}
		if (server.currentVote) {
			const results = getVoteResults(server.currentVote)
			if (!results) {
				const layerNames = server.currentVote.choices.map((id) => DisplayHelpers.toShortLayerName(M.getMiniLayerFromId(id)))
				SquadServer.rcon.warn(evt.playerId, `Next layer will be the winner of a vote: ${layerNames.join(', ')}`)
				return
			}
			const chosenLayerName = DisplayHelpers.toShortLayerName(M.getMiniLayerFromId(results.choice))
			if (results.resultType === 'winner') {
				SquadServer.rcon.warn(evt.playerId, `${chosenLayerName}, by won vote`)
				return
			}
			if (results.resultType === 'aborted') {
				SquadServer.rcon.warn(evt.playerId, `${results.choice}, by default decision`)
				return
			}
			throw new Error('unhandled result type')
		}
		SquadServer.rcon.warn(evt.playerId, `${DisplayHelpers.toShortLayerName(nextLayer)}`)
		return
	}

	if (CONFIG.commands.startVote.strings.includes(cmdText)) {
		const res = await startVote({ ...ctx, db: DB.get(ctx) })
		if (res.code === 'err:warn') {
			SquadServer.rcon.warn(evt.playerId, res.msg)
		}
		return
	}

	const msg = `Error: Command type ${cmdText} is valid but unhandled`
	ctx.log.error(msg)
	SquadServer.rcon.warn(evt.playerId, msg)
}

async function startVote(ctx: C.Log & C.Db) {
	const res = await DB.get(ctx).transaction(async (db) => {
		const _ctx = { ...ctx, db }
		const state = await getServerState({ lock: true }, _ctx)
		if (state.currentVote) {
			return { code: 'err:warn' as const, msg: `Vote already active!` }
		}
		if (!state.layerQueue[0].vote) {
			return {
				code: 'err:warn' as const,
				msg: `Next layer is not based on a vote. Next layer: ${state.layerQueue[0].layerId ? 'Next Layer:' + DisplayHelpers.toShortLayerNameFromId(state.layerQueue[0].layerId!) : ''}`,
			}
		}
		const voteConfig = state.layerQueue[0].vote
		const currentVote: M.VoteState = {
			choices: voteConfig.choices,
			defaultChoice: voteConfig.defaultChoice,
			deadline: Date.now() + CONFIG.voteLengthSeconds * 1000,
			votes: {},
		}
		await db.update(S.servers).set({ currentVote }).where(eq(S.servers.id, CONFIG.serverId))
		return { code: 'ok' as const, currentVote }
	})
	if (res.code !== 'ok') return res
	const currentVote = res.currentVote
	const optionsText = currentVote.choices
		.map((layerId, index) => `${index + 1}: ${DisplayHelpers.toShortLayerNameFromId(layerId)}`)
		.join('\n')
	await SquadServer.rcon.broadcast(
		`Voting for next layer has started! Options:\n${optionsText}\nYou have ${CONFIG.voteLengthSeconds} seconds to vote!`
	)
	if (voteEndTask) throw new Error('Tried setting vote while a vote was already active')
	voteEndTask = of(0)
		.pipe(timeout(currentVote.deadline - Date.now()))
		.subscribe(async () => {
			await handleVoteEnded('timeout', ctx)
		})
	return { code: 'ok' as const }
}

function getVoteResults(state: M.VoteState) {
	if (!state.endReason) return null
	if (state.endReason === 'aborted') return { resultType: 'aborted' as const, choice: state.defaultChoice }
	if (state.endReason === 'timeout') {
		const counts: Record<string, number> = {}
		for (const choice of state.choices) {
			counts[choice] = 0
		}
		for (const choice of Object.values(state.votes)) {
			counts[choice]++
		}

		const sortedChoices = Object.entries(counts).sort((a, b) => b[1] - a[1])
		return { resultType: 'winner' as const, choice: sortedChoices[0][0] }
	}
	throw new Error('unhandled endReason')
}

async function handleVote(evt: SM.SquadEvent & { type: 'chat-message' }, ctx: C.Log & C.Db) {
	const choiceIdx = parseInt(evt.message)
	await ctx.db.transaction(async (db) => {
		const [{ currentVote: currentVoteRaw }] = await db
			.select({ currentVote: S.servers.currentVote })
			.from(S.servers)
			.where(eq(S.servers.id, CONFIG.serverId))
			.for('update')

		const currentVote = M.ServerStateSchema.shape.currentVote.parse(currentVoteRaw)
		if (!currentVote || canCountVote(choiceIdx, evt.playerId, currentVote)) {
			return
		}
		const updatedVoteState = deepClone(currentVote)
		updatedVoteState.votes[evt.playerId] = updatedVoteState.choices[choiceIdx]
		await db.update(S.servers).set({ currentVote: updatedVoteState }).where(eq(S.servers.id, CONFIG.serverId))
	})
}

async function handleVoteEnded(endReason: 'timeout' | 'aborted', ctx: C.Log & C.Db) {
	const severState = await ctx.db.transaction(async (db) => {
		const serverState = deepClone(await getServerState({ lock: true }, { ...ctx, db }))
		const currentVote = serverState.currentVote
		if (!currentVote) {
			ctx.log.error('Tried to end vote while no vote was active')
			return { code: 'err:no-vote-active' as const }
		}
		currentVote.endReason = endReason
		const result = getVoteResults(currentVote)
		if (result === null) throw new Error('setting endReason should have ended vote')
		const queue = serverState.layerQueue
		queue[0].layerId = result.choice
		serverState.layerQueueSeqId++
		await ctx.db
			.update(S.servers)
			.set({ layerQueueSeqId: serverState.layerQueueSeqId, layerQueue: queue, currentVote })
			.where(eq(S.servers.id, CONFIG.serverId))
		return { code: 'ok' as const, serverState }
	})
	voteEndTask?.unsubscribe()
	voteEndTask = null
	return severState
}

function canCountVote(choiceIdx: number, playerId: string, voteState: M.ServerState['currentVote']) {
	if (voteState === null) return false
	if (voteState.endReason || voteState.deadline < Date.now()) return false
	if (choiceIdx <= 0 || choiceIdx >= voteState.choices.length) {
		SquadServer.rcon.warn(playerId, 'Invalid vote. Please enter a number between 1 and ' + (voteState.choices.length - 1))
		return false
	}
	return true
}

export async function* watchServerStateUpdates() {
	for await (const [update] of toAsyncGenerator(serverState$)) {
		yield update
	}
}

export async function* pollServerInfo() {
	for await (const info of toAsyncGenerator(pollServerInfo$)) {
		yield info
	}
}

export async function* watchNowPlayingState() {
	for await (const status of toAsyncGenerator(nowPlayingState$)) {
		yield status
	}
}
export async function* watchNextLayerState() {
	for await (const state of toAsyncGenerator(nextLayerState$)) {
		yield state
	}
}

export async function rollToNextLayer(state: { seqId: number }, ctx: C.Log & C.Db) {
	const res = await ctx.db.transaction(async (db) => {
		const serverState = deepClone(await getServerState({ lock: true }, { ...ctx, db }))
		if (state.seqId !== serverState.layerQueueSeqId) {
			return { code: 'err:out-of-sync' as const, message: 'Update is out of sync' }
		}
		const nextQueueItem = serverState.layerQueue[0]
		if (!nextQueueItem) {
			// TODO implement this case
			throw new TRPCError({
				code: 'BAD_REQUEST',
				message: 'Tried to roll to next layer when queue is empty',
			})
		}
		const vote = serverState.currentVote
		const queue = serverState.layerQueue
		if (vote && !queue[0].layerId) {
			if (Object.values(vote.votes).length >= CONFIG.minValidVotes) vote.endReason = 'aborted'
			else vote.endReason = 'timeout'
			const result = getVoteResults(vote)
			if (!result) throw new Error('endReason should have been set')
			queue[0].layerId = result.choice
		}
		const nextLayerId = queue[0].layerId!
		serverState.layerQueueSeqId++
		queue.shift()
		await db
			.update(S.servers)
			.set({
				layerQueueSeqId: serverState.layerQueueSeqId,
				layerQueue: queue,
				currentVote: null,
			})
			.where(eq(S.servers.id, CONFIG.serverId))
		return { code: 'ok' as const, nextLayerId }
	})
	if (res.code !== 'ok') {
		return res
	}
	const nextLayer = await SquadServer.rcon.getNextLayer()
	if (!nextLayer || nextLayer.id !== res.nextLayerId) {
		await setNextLayer(res.nextLayerId)
	}
	await SquadServer.rcon.endGame()
}

async function setNextLayer(layerId: string) {
	expectedCurrentLayer$.next(layerId)
	await SquadServer.rcon.setNextLayer(M.getMiniLayerFromId(layerId))
	await firstValueFrom(nowPlayingState$.pipe(filter((s) => s.status !== 'desynced')))
}

export async function processLayerQueueUpdate(update: M.LayerQueueUpdate, ctx: C.Log & C.Db) {
	const res = await ctx.db.transaction(async (db) => {
		const _ctx = { ...ctx, db }
		const serverState = deepClone(await getServerState({ lock: true }, _ctx))
		if (update.seqId !== serverState.layerQueueSeqId) {
			return { code: 'err:out-of-sync' as const, message: 'Update is out of sync' }
		}

		if (update.queue[0] && !deepEqual(update.queue[0], serverState.layerQueue[0])) {
			if (serverState.currentVote) {
				const res = await handleVoteEnded('aborted', _ctx)
				if (res.code === 'err:no-vote-active') throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Tried to end inactive vote' })
				serverState.layerQueueSeqId = res.serverState.layerQueueSeqId
			}
		}

		serverState.layerQueue = update.queue
		serverState.layerQueueSeqId++

		await db
			.update(S.servers)
			.set({ layerQueue: serverState.layerQueue, layerQueueSeqId: serverState.layerQueueSeqId })
			.where(eq(S.servers.id, CONFIG.serverId))
		return { code: 'ok' as const, serverState }
	})
	if (res.code === 'err:out-of-sync') return res
	serverState$.next([res.serverState, ctx])
	return { code: 'ok' as const }
}

function getLayerSyncState(expected: string | undefined, current: string | null, ctx: C.Log): M.LayerSyncState {
	ctx.log.info('expected: %s, current: %s', expected, current)
	if (!current) return { status: 'offline' }
	if (expected === undefined || expected === current) return { status: 'synced', value: current }
	if (expected !== current) return { status: 'desynced', expected: expected, current: current }
	throw new Error('unhandled case')
}
