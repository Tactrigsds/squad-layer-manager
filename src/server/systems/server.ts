import { TRPCError } from '@trpc/server'
import { eq } from 'drizzle-orm'
import deepEqual from 'fast-deep-equal'
import { BehaviorSubject, Subscription, combineLatest, of, timeout } from 'rxjs'
import StringComparison from 'string-comparison'
import { z } from 'zod'

import { distinctDeepEquals, toAsyncGenerator } from '@/lib/async.ts'
import * as DisplayHelpers from '@/lib/display-helpers.ts'
import { deepClone } from '@/lib/object'
import * as SM from '@/lib/rcon/squad-models'
import * as M from '@/models.ts'
import { CONFIG } from '@/server/config.ts'
import * as C from '@/server/context'
import * as DB from '@/server/db.ts'
import { baseLogger } from '@/server/logger.ts'
import * as Schema from '@/server/schema.ts'
import * as SquadServer from '@/server/systems/squad-server'

import { procedure, procedureWithInput, router } from '../trpc'

let serverState$!: BehaviorSubject<[M.ServerState, C.Log]>
let voteEndTask: Subscription | null = null
// -------- generic errors --------
const GENERIC_ERRORS = {
	outOfSyncError() {
		return { code: 'err:out-of-sync' as const, message: 'Server state was out of sync with server. Please retry update.' }
	},
}

export async function setupServerstate() {
	const log = baseLogger.child({ ctx: 'layer-queue' })
	const systemCtx = { log }
	const db = DB.get(systemCtx)

	// -------- bring server up to date with configuration --------
	const server = await db.transaction(async (db) => {
		let [server] = await db.select().from(Schema.servers).where(eq(Schema.servers.id, CONFIG.serverId)).for('update')
		if (!server) {
			await db.insert(Schema.servers).values({ id: CONFIG.serverId, displayName: CONFIG.serverDisplayName })
			;[server] = await db.select().from(Schema.servers).where(eq(Schema.servers.id, CONFIG.serverId))
		}
		if (server.displayName !== CONFIG.serverDisplayName) {
			await db.update(Schema.servers).set({ displayName: CONFIG.serverDisplayName }).where(eq(Schema.servers.id, CONFIG.serverId))
			server.displayName = CONFIG.serverDisplayName
		}
		return server
	})

	serverState$ = new BehaviorSubject([M.ServerStateSchema.parse(server), systemCtx])

	await db.transaction(async (tx) => {
		const { value: squadServerNextLayer, release } = await SquadServer.nextLayer.get(systemCtx, { lock: true, ttl: 0 })
		try {
			const _ctx = { ...systemCtx, db: tx }
			const serverState = await getServerState({ lock: true }, _ctx)
			if (!serverState.layerQueue[0]?.layerId) return null
			if (
				squadServerNextLayer === null ||
				(serverState.layerQueue[0]?.layerId && serverState.layerQueue[0]?.layerId !== squadServerNextLayer.id)
			) {
				await SquadServer.setNextLayer(_ctx, M.getMiniLayerFromId(serverState.layerQueue[0].layerId))
			}
		} finally {
			release()
		}
	})

	SquadServer.nextLayer.observe(systemCtx).subscribe(async (nextLayer) => {
		if (nextLayer === null) return
		await db.transaction(async (tx) => {
			const { value: squadServerNextLayer, release } = await SquadServer.nextLayer.get(systemCtx, { lock: true, ttl: 50 })
			try {
				const _ctx = { ...systemCtx, db: tx }
				const serverState = await getServerState({ lock: true }, _ctx)
				if (squadServerNextLayer !== null && serverState.layerQueue[0]?.layerId !== squadServerNextLayer.id) {
					const layerQueue = deepClone(serverState.layerQueue)
					layerQueue.unshift({ layerId: squadServerNextLayer.id, generated: false })
					await tx.update(Schema.servers).set({ layerQueue, currentVote: null }).where(eq(Schema.servers.id, CONFIG.serverId))
				}
			} finally {
				release()
			}
		})
	})
	// -------- keep squad server state in line with ours --------
	// nowPlayingState$.subscribe(async function syncCurrentLayer(syncState) {
	// 	if (syncState.status === 'desynced') {
	// 		await SquadServer.setNextLayer(ctx, M.getMiniLayerFromId(syncState.expected))
	// 		await SquadServer.endGame(ctx)
	// 	}
	// })

	function getNextLayerUpdate(serverState: M.ServerState, squadServerNextLayer: M.MiniLayer | null) {
		if (!serverState.layerQueue[0]?.layerId) return null
		if (
			squadServerNextLayer === null ||
			(serverState.layerQueue[0]?.layerId && serverState.layerQueue[0]?.layerId !== squadServerNextLayer.id)
		)
			return M.getMiniLayerFromId(serverState.layerQueue[0].layerId)
		return null
	}

	combineLatest([SquadServer.nextLayer.observe(systemCtx).pipe(distinctDeepEquals()), serverState$]).subscribe(
		async ([squadServerNextLayer, [serverState, ctx]]) => {
			if (!serverState.layerQueue[0]?.layerId) return
			if (getNextLayerUpdate(serverState, squadServerNextLayer)) {
				// get fresh data, lock resource and serverState while we update the layer so we can't run into atomicity bugs
				const { release, value: squadServerNextLayer } = await SquadServer.nextLayer.get(ctx, { lock: true, ttl: 0 })
				const db = DB.get(ctx)
				try {
					await db.transaction(async (tx) => {
						const _ctx = { ...ctx, db: tx }
						const serverState = await getServerState({ lock: true }, _ctx)
						const newNextLayer = getNextLayerUpdate(serverState, squadServerNextLayer)
						if (newNextLayer !== null) await SquadServer.setNextLayer(ctx, newNextLayer)
					})
				} finally {
					release()
				}
			}
		}
	)

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
				await db.update(Schema.servers).set({ layerQueue: updatedState.layerQueue, layerQueueSeqId: updatedState.layerQueueSeqId })
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
	const query = ctx.db.select().from(Schema.servers).where(eq(Schema.servers.id, CONFIG.serverId))
	let serverRaw: Schema.Server | undefined
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
		await db.update(Schema.servers).set({ currentVote }).where(eq(Schema.servers.id, CONFIG.serverId))
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

async function handleVote(evt: SM.SquadEvent & { type: 'chat-message' }, ctx: C.Log & C.Db) {
	const choiceIdx = parseInt(evt.message)
	await ctx.db.transaction(async (db) => {
		const [{ currentVote: currentVoteRaw }] = await db
			.select({ currentVote: Schema.servers.currentVote })
			.from(Schema.servers)
			.where(eq(Schema.servers.id, CONFIG.serverId))
			.for('update')

		const currentVote = M.ServerStateSchema.shape.currentVote.parse(currentVoteRaw)
		if (!currentVote || canCountVote(ctx, choiceIdx, evt.playerId, currentVote)) {
			return
		}
		const updatedVoteState = deepClone(currentVote)
		updatedVoteState.votes[evt.playerId] = updatedVoteState.choices[choiceIdx]
		await db.update(Schema.servers).set({ currentVote: updatedVoteState }).where(eq(Schema.servers.id, CONFIG.serverId))
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
		const result = M.getVoteStatus(currentVote)
		if (result === null) throw new Error('setting endReason should have ended vote')
		const queue = serverState.layerQueue
		queue[0].layerId = result.choice
		serverState.layerQueueSeqId++
		await ctx.db
			.update(Schema.servers)
			.set({ layerQueueSeqId: serverState.layerQueueSeqId, layerQueue: queue, currentVote })
			.where(eq(Schema.servers.id, CONFIG.serverId))
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

async function includeServerStateParts(ctx: C.Db & C.Log, _serverState: M.ServerState): Promise<M.ServerStateWithParts> {
	const serverState: M.ServerStateWithParts = deepClone(_serverState)
	if (serverState.currentVote) {
		const result = M.getVoteStatus(serverState.currentVote)
		if (result?.code === 'aborted') {
			serverState.parts ??= {}
			serverState.parts.users ??= new Map()
			const [user] = await ctx.db.select().from(Schema.users).where(eq(Schema.users.discordId, result.aborter))
			if (user) {
				serverState.parts.users.set(user.discordId, user)
			} else {
				ctx.log.warn('cannot find user data for vote aborter: %d', result.aborter)
			}
		}
	}
	return serverState
}

async function* watchServerStateUpdates(args: { ctx: C.Log & C.Db }) {
	for await (const [update] of toAsyncGenerator(serverState$)) {
		yield await includeServerStateParts(args.ctx, update)
	}
}

async function* watchServerState({ ctx }: { ctx: C.Log }) {
	const serverStatus$ = SquadServer.serverStatus.observe(ctx)
	for await (const info of toAsyncGenerator(serverStatus$)) {
		yield info
	}
}

async function* watchCurrentLayerState(ctx: C.Log) {
	const currentLayer$ = SquadServer.currentLayer.observe(ctx)
	for await (const status of toAsyncGenerator(currentLayer$)) {
		yield status
	}
}

async function* watchNextLayerState(ctx: C.Log) {
	const nextLayer$ = SquadServer.nextLayer.observe(ctx)
	for await (const state of toAsyncGenerator(nextLayer$)) {
		yield state
	}
}

async function rollToNextLayer(state: { seqId: number }, ctx: C.Log & C.Db) {
	const res = await ctx.db.transaction(async (db) => {
		const serverState = deepClone(await getServerState({ lock: true }, { ...ctx, db }))
		if (state.seqId !== serverState.layerQueueSeqId) {
			return GENERIC_ERRORS.outOfSyncError()
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
			.update(Schema.servers)
			.set({
				layerQueueSeqId: serverState.layerQueueSeqId,
				layerQueue: queue,
				currentVote: null,
			})
			.where(eq(Schema.servers.id, CONFIG.serverId))
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

async function abortVote({ ctx, input }: { ctx: C.Log & C.Db; input: { seqId: number } }) {
	const res = await ctx.db.transaction(async (tx) => {
		const _ctx = { ...ctx, db: tx }
		const serverState = deepClone(await getServerState({ lock: true }, _ctx))
		if (input.seqId !== serverState.layerQueueSeqId) return GENERIC_ERRORS.outOfSyncError()
		if (!serverState.currentVote) {
			return { code: 'err:no-vote-set' as const }
		}
		let result = M.getVoteStatus(serverState.currentVote)
		if (result) {
			return { code: 'err:vote-already-resolved' as const }
		}
		serverState.currentVote!.endReason = 'aborted'
		result = M.getVoteStatus(serverState.currentVote)
		serverState.layerQueue[0].layerId = result!.choice
		serverState.layerQueueSeqId++
		await tx.update(Schema.servers).set(serverState)
		return { code: 'ok' as const, serverState }
	})
	if (res.code !== 'ok') return res
	SquadServer.broadcast(ctx, 'Next Layer Vote was aborted.')
	serverState$.next([res.serverState, ctx])
	return res
}

async function restartVote({ ctx, input }: { ctx: C.Log & C.Db; input: { seqId: number } }) {
	const res = await ctx.db.transaction(async (tx) => {
		const _ctx = { ...ctx, db: tx }
		const serverState = deepClone(await getServerState({ lock: true }, _ctx))
		if (input.seqId !== serverState.layerQueueSeqId) {
			return GENERIC_ERRORS.outOfSyncError()
		}
		if (!serverState.currentVote) {
			return { code: 'err:no-vote-set' as const }
		}

		delete serverState.currentVote.aborter
		delete serverState.currentVote.endReason
		serverState.currentVote.votes = {}
		serverState.currentVote.deadline = Date.now() + CONFIG.voteLengthSeconds * 1000
		serverState.layerQueueSeqId++
		await tx.update(Schema.servers).set(serverState).where(eq(Schema.servers.id, serverState.id))
		return { code: 'ok' as const, serverState }
	})
	if (res.code !== 'ok') return
	serverState$.next([res.serverState, ctx])
	return res
}

async function processLayerQueueUpdate(args: { input: M.LayerQueueUpdate; ctx: C.Log & C.Db }) {
	const { input, ctx } = args
	const { release, value: nextLayerOnServer } = await SquadServer.nextLayer.get(ctx, { lock: true, ttl: 0 })
	try {
		const res = await ctx.db.transaction(async (db) => {
			const _ctx = { ...ctx, db }
			const serverState = deepClone(await getServerState({ lock: true }, _ctx))
			if (input.seqId !== serverState.layerQueueSeqId) {
				return { code: 'err:out-of-sync' as const, message: 'Update is out of sync' }
			}

			let voteStarted = false
			if (input.queue[0] && !deepEqual(input.queue[0], serverState.layerQueue[0])) {
				if (serverState.currentVote)
					return {
						code: 'err:next-layer-changed-while-vote-active' as const,
					}

				if (input.queue[0].vote) {
					serverState.currentVote = {
						choices: input.queue[0].vote.choices,
						defaultChoice: input.queue[0].vote.defaultChoice,
						deadline: Date.now() + CONFIG.voteLengthSeconds * 1000,
						votes: {},
					}
					voteStarted = true
				}
			}

			serverState.layerQueue = input.queue
			serverState.layerQueueSeqId++
			let updatedNextLayerId: string | null = null
			// we're setting the default choice of a layer temporarily if
			const nextLayerId = serverState.layerQueue[0]?.layerId
			if (nextLayerId && nextLayerOnServer?.id !== nextLayerId) {
				updatedNextLayerId = nextLayerId
			}

			await db.update(Schema.servers).set(serverState).where(eq(Schema.servers.id, CONFIG.serverId))
			return { code: 'ok' as const, serverState, updatedNextLayerId, voteStarted }
		})

		if (res.code !== 'ok') return res
		SquadServer.broadcast(ctx, 'Unknown Username')
		if (res.updatedNextLayerId !== null) await SquadServer.setNextLayer(ctx, M.getMiniLayerFromId(res.updatedNextLayerId))
		serverState$.next([res.serverState, ctx])
		return res
	} finally {
		release()
	}
}

export const serverRouter = router({
	watchServerUpdates: procedure.subscription(watchServerStateUpdates),
	updateQueue: procedureWithInput(M.QueueUpdateSchema).mutation(processLayerQueueUpdate),
	restartVote: procedureWithInput(z.object({ seqId: z.number() })).mutation(restartVote),
	abortVote: procedureWithInput(z.object({ seqId: z.number() })).mutation(abortVote),
	watchServerstate: procedure.subscription(watchServerState),
	watchCurrentLayerState: procedure.subscription(({ ctx }) => watchCurrentLayerState(ctx)),
	watchNextLayerState: procedure.subscription(({ ctx }) => watchNextLayerState(ctx)),
})
