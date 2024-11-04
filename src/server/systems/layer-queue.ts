// I'm aware that this entire system is terribly named, and I apologize
import { eq } from 'drizzle-orm'
import deepEqual from 'fast-deep-equal'
import { BehaviorSubject, Subscription, of, timeout } from 'rxjs'
import StringComparison from 'string-comparison'
import { z } from 'zod'

import { toAsyncGenerator } from '@/lib/async.ts'
import * as DisplayHelpers from '@/lib/display-helpers.ts'
import { deepClone } from '@/lib/object'
import * as SM from '@/lib/rcon/squad-models'
import * as M from '@/models.ts'
import { CONFIG } from '@/server/config.ts'
import * as C from '@/server/context'
import * as DB from '@/server/db.ts'
import { baseLogger } from '@/server/logger.ts'
import * as Schema from '@/server/schema.ts'
import * as Sessions from '@/server/systems/sessions'
import * as SquadServer from '@/server/systems/squad-server'

import { procedure, procedureWithInput, router } from '../trpc'

let serverState$!: BehaviorSubject<[M.ServerState, C.Log]>
let voteEndTask: Subscription | null = null

const GENERIC_ERRORS = {
	outOfSyncError() {
		return { code: 'err:out-of-sync' as const, message: 'Out of sync with server. Please retry update.' }
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

	// -------- set next layer on server if necessary --------
	db.transaction(async (tx) => {
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

	// -------- if next layer is changed from ingame or some other system, then respect that and add layer to the front of the queue --------
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

	// if (CONFIG.commands.showNext.strings.includes(cmdText)) {
	// 	const server = await getServerState({ lock: false }, { ...ctx, db: DB.get(ctx) })
	// 	const { value: nextLayer } = await SquadServer.nextLayer.get(ctx)
	// 	if (!nextLayer) {
	// 		SquadServer.rcon.warn(ctx, evt.playerId, 'No next layer set')
	// 		return
	// 	}
	// 	if (server.currentVote) {
	// 		switch (server.currentVote.code) {
	// 			case 'in-progress': {
	// 				const layerNames = server.currentVote.choices.map((id) => DisplayHelpers.toShortLayerName(M.getMiniLayerFromId(id)))
	// 				SquadServer.rcon.warn(ctx, evt.playerId, `Vote in progress: ${layerNames.join(', ')}`)
	// 				break
	// 			}
	// 			case 'ended:aborted': {
	// 				const layerNames = server.currentVote.choices.map((id) => DisplayHelpers.toShortLayerName(M.getMiniLayerFromId(id)))
	// 				SquadServer.rcon.warn(ctx, evt.playerId, `Vote was aborted: ${layerNames.join(', ')}`)
	// 				break
	// 			}
	// 		}
	// 		if (!status) {
	// 			const layerNames = server.currentVote.choices.map((id) => DisplayHelpers.toShortLayerName(M.getMiniLayerFromId(id)))
	// 			SquadServer.rcon.warn(ctx, evt.playerId, `Next layer will be the winner of a vote: ${layerNames.join(', ')}`)
	// 			return
	// 		}
	// 		if (status.code === 'winner') {
	// 			const chosenLayerName = DisplayHelpers.toShortLayerName(M.getMiniLayerFromId(status.choice))
	// 			SquadServer.rcon.warn(ctx, evt.playerId, `${chosenLayerName}, by won vote`)
	// 			return
	// 		}
	// 		if (status.code === 'aborted') {
	// 			SquadServer.rcon.warn(ctx, evt.playerId, `${status.choice}, by default decision`)
	// 			return
	// 		}
	// 		throw new Error('unhandled result type')
	// 	}
	// 	SquadServer.rcon.warn(ctx, evt.playerId, `${DisplayHelpers.toShortLayerName(nextLayer)}`)
	// 	return
	// }

	if (CONFIG.commands.startVote.strings.includes(cmdText)) {
		const res = await startVote({ ...ctx, db: DB.get(ctx) })
		if (res.code !== 'ok') {
			SquadServer.rcon.warn(ctx, evt.playerId, res.msg)
		}
		return
	}

	const msg = `Error: Command type ${cmdText} is valid but unhandled`
	ctx.log.error(msg)
	SquadServer.rcon.warn(ctx, evt.playerId, msg)
}

async function startVote(ctx: C.Log & C.Db, opts?: { restarting?: boolean; seqId?: number }) {
	opts ??= {}
	opts.restarting ??= false
	const res = await DB.get(ctx).transaction(async (db) => {
		const _ctx = { ...ctx, db }
		const state = await getServerState({ lock: true }, _ctx)
		if (opts.seqId && state.layerQueueSeqId !== opts.seqId) {
			return GENERIC_ERRORS.outOfSyncError()
		}
		if (!state.currentVote) {
			return { code: 'err:no-vote-exists' as const, msg: 'No vote currently exists' }
		}
		if (!opts.restarting && state.currentVote.code === 'in-progress') {
			return { code: 'err:vote-in-progress' as const, msg: 'A vote is already in progress' }
		}
		if (!opts.restarting && state.currentVote.code.startsWith('ended:')) {
			return { code: 'err:vote-ended' as const, msg: 'The previous vote has ended' }
		}
		if (!opts.restarting && state.currentVote.code !== 'ready') {
			return { code: 'err:vote-not-ready' as const, msg: 'Vote is not in a ready state' }
		}
		const voteConfig = state.layerQueue[0].vote
		if (!voteConfig) {
			throw new Error('No vote config found when currentVote.code === "ready"')
		}
		const currentVote = {
			code: 'in-progress',
			choices: voteConfig.choices,
			defaultChoice: voteConfig.defaultChoice,
			deadline: Date.now() + CONFIG.voteDurationSeconds * 1000,
			votes: {},
		} satisfies M.VoteState
		state.currentVote = currentVote
		// state of currentVote can affect which mutations are allowed in the layerQueue
		state.layerQueueSeqId++
		await db.update(Schema.servers).set(state).where(eq(Schema.servers.id, CONFIG.serverId))
		return { code: 'ok' as const, currentVote }
	})
	if (res.code !== 'ok') return res
	const optionsText = res.currentVote.choices
		.map((layerId, index) => `${index + 1}: ${DisplayHelpers.toShortLayerNameFromId(layerId)}`)
		.join('\n')

	await SquadServer.broadcast(
		ctx,
		`Voting for next layer has started! Options:\n${optionsText}\nYou have ${CONFIG.voteDurationSeconds} seconds to vote!`
	)
	if (voteEndTask) throw new Error('Tried setting vote while a vote was already active')
	voteEndTask = of(0)
		.pipe(timeout(res.currentVote.deadline - Date.now()))
		.subscribe(async () => {
			await handleVoteTimeout(ctx)
		})
	return { code: 'ok' as const }
}

async function handleVote(evt: SM.SquadEvent & { type: 'chat-message' }, ctx: C.Log & C.Db) {
	const choiceIdx = parseInt(evt.message)
	await ctx.db.transaction(async (db) => {
		const serverState = await getServerState({ lock: true }, { ...ctx, db })

		const currentVote = serverState.currentVote
		if (!currentVote) {
			return
		}
		if (currentVote.code !== 'in-progress') {
			await SquadServer.warn(ctx, evt.playerId, `Vote is not in progress: (status: ${currentVote.code}}`)
			return
		}
		const updatedVoteState = deepClone(currentVote)
		updatedVoteState.votes[evt.playerId] = updatedVoteState.choices[choiceIdx]
		await db.update(Schema.servers).set({ currentVote: updatedVoteState }).where(eq(Schema.servers.id, CONFIG.serverId))
	})
}

async function handleVoteTimeout(ctx: C.Log & C.Db) {
	const severState = await ctx.db.transaction(async (db) => {
		const serverState = deepClone(await getServerState({ lock: true }, { ...ctx, db }))
		const currentVote = serverState.currentVote
		if (!currentVote || currentVote.code !== 'in-progress') {
			return { code: 'err:no-vote-in-progress' as const, currentVote }
		}
		if (Object.values(currentVote.votes).length < CONFIG.minValidVotes) {
			await SquadServer.broadcast(
				ctx,
				`Not enough votes to decide outcome! Defaulting to ${DisplayHelpers.toShortLayerNameFromId(currentVote.defaultChoice)}`
			)
			serverState.layerQueue[0].layerId = currentVote.defaultChoice
			serverState.layerQueueSeqId++
		} else {
			const tally = new Map<string, number>()
			let maxVotes: string | null = null
			for (const choice of Object.values(currentVote.votes)) {
				tally.set(choice, (tally.get(choice) || 0) + 1)

				if (maxVotes === null || tally.get(choice)! > tally.get(maxVotes)!) {
					maxVotes = choice
				}
			}
			// maxVotes will be set since we have at least one choice if we've got at least one vote
			const result = { choice: maxVotes!, votes: tally.get(maxVotes!)! }
			const newVoteState: M.VoteState = {
				choices: currentVote.choices,
				defaultChoice: currentVote.defaultChoice,
				deadline: currentVote.deadline,
				votes: currentVote.votes,

				code: 'ended:winner',
				winner: result.choice,
			}
			serverState.layerQueue[0].layerId = result.choice
			serverState.layerQueueSeqId++
			serverState.currentVote = newVoteState
		}

		await ctx.db.update(Schema.servers).set(serverState).where(eq(Schema.servers.id, CONFIG.serverId))
		return { code: 'ok' as const, serverState }
	})
	voteEndTask?.unsubscribe()
	voteEndTask = null
	return severState
}

async function includeServerStateParts(ctx: C.Db & C.Log, _serverState: M.ServerState): Promise<M.ServerState & M.UserPart> {
	const state = deepClone(_serverState) as M.ServerState & M.UserPart
	state.parts = {}
	state.parts.users = []
	if (state.currentVote?.code === 'ended:aborted' && state.currentVote.abortReason === 'manual') {
		if (state.currentVote.aborter === undefined) throw new Error('aborter is undefined when given abortReason of "manual"')
		const [user] = await ctx.db.select().from(Schema.users).where(eq(Schema.users.discordId, state.currentVote.aborter))
		if (user) {
			state.parts.users.push(user)
		} else {
			ctx.log.warn('cannot find user data for vote aborter: %d', state.currentVote.aborter)
		}
	}
	return state
}

async function* watchServerStateUpdates(args: { ctx: C.Log & C.Db }) {
	for await (const [update] of toAsyncGenerator(serverState$)) {
		yield await includeServerStateParts(args.ctx, update)
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
	const { value: nextLayer } = await SquadServer.nextLayer.get(ctx, {})
	if (nextLayer !== null) {
		return { code: 'err:no-next-layer' as const }
	}
	const serverState = deepClone(await getServerState({ lock: true }, ctx))
	if (state.seqId !== serverState.layerQueueSeqId) {
		return GENERIC_ERRORS.outOfSyncError()
	}

	const vote = serverState.currentVote
	if (vote?.code === 'in-progress') {
		return { code: 'err:vote-in-progress' as const }
	}

	await SquadServer.endGame(ctx)
}

async function abortVote(ctx: C.Log & C.Db, aborter: bigint, seqId?: number) {
	const res = await ctx.db.transaction(async (tx) => {
		const _ctx = { ...ctx, db: tx }
		const serverState = deepClone(await getServerState({ lock: true }, _ctx))
		if (seqId !== undefined && seqId !== serverState.layerQueueSeqId) return GENERIC_ERRORS.outOfSyncError()
		if (serverState.currentVote?.code !== 'in-progress') {
			return { code: 'err:no-vote-in-progress' as const, currentVote: serverState.currentVote }
		}
		serverState.currentVote = {
			...M.getVoteTallyProperties(serverState.currentVote),
			code: 'ended:aborted',
			abortReason: 'manual',
			aborter,
		}

		serverState.layerQueue[0].layerId = serverState.currentVote.defaultChoice
		serverState.layerQueueSeqId++
		await tx.update(Schema.servers).set(serverState)
		return { code: 'ok' as const, serverState }
	})
	if (res.code !== 'ok') return res
	SquadServer.broadcast(
		ctx,
		`Next Layer Vote was aborted. Next layer was defaulted to ${DisplayHelpers.toShortLayerNameFromId(res.serverState.layerQueue[0].layerId!)}`
	)
	serverState$.next([res.serverState, ctx])
	return res
}

async function updateQueue(args: { input: M.LayerQueueUpdate; ctx: C.Log & C.Db }) {
	const { input, ctx } = args
	const { release, value: nextLayerOnServer } = await SquadServer.nextLayer.get(ctx, { lock: true, ttl: 0 })
	try {
		const res = await ctx.db.transaction(async (db) => {
			const _ctx = { ...ctx, db }
			const serverState = deepClone(await getServerState({ lock: true }, _ctx))
			if (input.seqId !== serverState.layerQueueSeqId) {
				return { code: 'err:out-of-sync' as const, message: 'Update is out of sync' }
			}

			if (input.queue[0] && !deepEqual(input.queue[0], serverState.layerQueue[0])) {
				if (serverState.currentVote)
					return {
						code: 'err:next-layer-changed-while-vote-active' as const,
					}

				if (input.queue[0].vote) {
					serverState.currentVote = { code: 'ready' }
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
			return { code: 'ok' as const, serverState, updatedNextLayerId }
		})

		if (res.code !== 'ok') return res
		SquadServer.broadcast(ctx, 'Unknown Username')
		SquadServer.broadcast(ctx, 'Unknown Username')
		if (res.updatedNextLayerId !== null) await SquadServer.setNextLayer(ctx, M.getMiniLayerFromId(res.updatedNextLayerId))
		serverState$.next([res.serverState, ctx])
		return res
	} finally {
		release()
	}
}

export const serverRouter = router({
	watchServerState: procedure.subscription(watchServerStateUpdates),
	startVote: procedureWithInput(M.StartVoteSchema).mutation(async ({ input, ctx }) => startVote(ctx, input)),
	abortVote: procedureWithInput(z.object({ seqId: z.number() })).mutation(async ({ input, ctx }) => {
		const user = await Sessions.getUser({ lock: false }, ctx)
		return await abortVote(ctx, user.discordId, input.seqId)
	}),
	updateQueue: procedureWithInput(M.QueueUpdateSchema).mutation(updateQueue),
	watchCurrentLayerState: procedure.subscription(({ ctx }) => watchCurrentLayerState(ctx)),
	watchNextLayerState: procedure.subscription(({ ctx }) => watchNextLayerState(ctx)),
	rollToNextLayer: procedureWithInput(z.object({ seqId: z.number() })).mutation(({ ctx, input }) => rollToNextLayer(input, ctx)),
})
