import { TRPCError } from '@trpc/server'
import { eq } from 'drizzle-orm'
import deepEqual from 'fast-deep-equal'
import { BehaviorSubject, Subscription, combineLatest, distinctUntilChanged, of, timeout } from 'rxjs'
import StringComparison from 'string-comparison'

import { toAsyncGenerator } from '@/lib/async.ts'
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

let serverState$!: BehaviorSubject<[M.ServerState, C.Log]>
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

	serverState$ = new BehaviorSubject([M.ServerStateSchema.parse(server), ctx])

	// -------- keep squad server state in line with ours --------
	// nowPlayingState$.subscribe(async function syncCurrentLayer(syncState) {
	// 	if (syncState.status === 'desynced') {
	// 		await SquadServer.setNextLayer(ctx, M.getMiniLayerFromId(syncState.expected))
	// 		await SquadServer.endGame(ctx)
	// 	}
	// })

	combineLatest([SquadServer.nextLayer.observe({ log }), serverState$]).subscribe(([squadServerNextLayer, [serverState]]) => {
		if (
			squadServerNextLayer !== null &&
			serverState.layerQueue[0]?.layerId &&
			serverState.layerQueue[0]?.layerId !== squadServerNextLayer.id
		)
			SquadServer.setNextLayer(ctx, M.getMiniLayerFromId(serverState.layerQueue[0].layerId))
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
				const { value: nowPlayingLayer } = await SquadServer.nextLayer.get(ctx)
				if (nowPlayingLayer === null) throw new Error('game ended when no next layer set')
				if (serverState.layerQueue[0] && serverState.layerQueue[0].layerId !== nowPlayingLayer.id) {
					_log.warn("layerIds for next layer on squad server and our application don't match on game end")
					return
				}

				const updatedState = deepClone(serverState)
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
		SquadServer.warn(ctx, evt.playerId, `Unknown command "${cmdText}". Did you mean ${sortedMatches[0]}?`)
		return
	}

	if (CONFIG.commands.showNext.strings.includes(cmdText)) {
		const server = await getServerState({ lock: false }, { ...ctx, db: DB.get(ctx) })
		const { value: nextLayer } = await SquadServer.nextLayer.get(ctx)
		if (!nextLayer) {
			SquadServer.rcon.warn(ctx, evt.playerId, 'No next layer set')
			return
		}
		if (server.currentVote) {
			const results = getVoteResults(server.currentVote)
			if (!results) {
				const layerNames = server.currentVote.choices.map((id) => DisplayHelpers.toShortLayerName(M.getMiniLayerFromId(id)))
				SquadServer.rcon.warn(ctx, evt.playerId, `Next layer will be the winner of a vote: ${layerNames.join(', ')}`)
				return
			}
			const chosenLayerName = DisplayHelpers.toShortLayerName(M.getMiniLayerFromId(results.choice))
			if (results.resultType === 'winner') {
				SquadServer.rcon.warn(ctx, evt.playerId, `${chosenLayerName}, by won vote`)
				return
			}
			if (results.resultType === 'aborted') {
				SquadServer.rcon.warn(ctx, evt.playerId, `${results.choice}, by default decision`)
				return
			}
			throw new Error('unhandled result type')
		}
		SquadServer.rcon.warn(ctx, evt.playerId, `${DisplayHelpers.toShortLayerName(nextLayer)}`)
		return
	}

	if (CONFIG.commands.startVote.strings.includes(cmdText)) {
		const res = await startVote({ ...ctx, db: DB.get(ctx) })
		if (res.code === 'err:warn') {
			SquadServer.rcon.warn(ctx, evt.playerId, res.msg)
		}
		return
	}

	const msg = `Error: Command type ${cmdText} is valid but unhandled`
	ctx.log.error(msg)
	SquadServer.rcon.warn(ctx, evt.playerId, msg)
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

	await SquadServer.broadcast(
		ctx,
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
		if (!currentVote || canCountVote(ctx, choiceIdx, evt.playerId, currentVote)) {
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

function canCountVote(ctx: C.Log, choiceIdx: number, playerId: string, voteState: M.ServerState['currentVote']) {
	if (voteState === null) return false
	if (voteState.endReason || voteState.deadline < Date.now()) return false
	if (choiceIdx <= 0 || choiceIdx >= voteState.choices.length) {
		SquadServer.warn(ctx, playerId, 'Invalid vote. Please enter a number between 1 and ' + (voteState.choices.length - 1))
		return false
	}
	return true
}

export async function* watchServerStateUpdates() {
	for await (const [update] of toAsyncGenerator(serverState$)) {
		yield update
	}
}

export async function* pollServerInfo(ctx: C.Log) {
	const o = SquadServer.serverStatus.observe(ctx).pipe(distinctUntilChanged((a, b) => deepEqual(a, b)))
	for await (const info of toAsyncGenerator(o)) {
		yield info
	}
}

export async function* watchNowPlayingState(ctx: C.Log) {
	for await (const status of toAsyncGenerator(SquadServer.currentLayer.observe(ctx))) {
		yield status
	}
}
export async function* watchNextLayerState(ctx: C.Log) {
	for await (const state of toAsyncGenerator(SquadServer.nextLayer.observe(ctx))) {
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
	const { value: currentNextLayer, release } = await SquadServer.nextLayer.get(ctx, { lock: true })
	try {
		if (currentNextLayer?.id === res.nextLayerId) return
		await SquadServer.setNextLayer(ctx, M.getMiniLayerFromId(res.nextLayerId))
		await SquadServer.endGame(ctx)
	} finally {
		release()
	}
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
