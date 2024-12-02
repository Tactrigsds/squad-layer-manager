import { eq } from 'drizzle-orm'
import deepEqual from 'fast-deep-equal'
import { BehaviorSubject, mergeMap, of, Subscription } from 'rxjs'
import StringComparison from 'string-comparison'
import { z } from 'zod'

import { sleep, toAsyncGenerator } from '@/lib/async.ts'
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
import { superjsonify, unsuperjsonify } from '@/lib/drizzle'

let serverState$!: BehaviorSubject<[M.ServerState, C.Log & C.Db]>
let voteEndTask: Subscription | null = null

const GENERIC_ERRORS = {
	outOfSyncError() {
		return { code: 'err:out-of-sync' as const, msg: 'Out of sync with server. Please retry update.' }
	},
}

export async function setupLayerQueueAndServerState() {
	const log = baseLogger
	const systemCtx = { log, db: DB.get({ log }) }

	await using opCtx = C.pushOperation(systemCtx, 'layer-queue:setup')

	// -------- bring server up to date with configuration --------
	const initialServerState = await opCtx.db.transaction(async (db) => {
		let [server] = await db.select().from(Schema.servers).where(eq(Schema.servers.id, CONFIG.serverId)).for('update')
		if (!server) {
			await db.insert(Schema.servers).values({ id: CONFIG.serverId, displayName: CONFIG.serverDisplayName })
			;[server] = await db.select().from(Schema.servers).where(eq(Schema.servers.id, CONFIG.serverId))
		}
		if (server.displayName !== CONFIG.serverDisplayName) {
			await db.update(Schema.servers).set({ displayName: CONFIG.serverDisplayName }).where(eq(Schema.servers.id, CONFIG.serverId))
			server.displayName = CONFIG.serverDisplayName
		}
		return M.ServerStateSchema.parse(unsuperjsonify(Schema.servers, server))
	})

	serverState$ = new BehaviorSubject([initialServerState, systemCtx])

	// -------- set next layer on server if necessary --------
	await opCtx.db.transaction(async (tx) => {
		const ctx = { ...opCtx, db: tx }
		const { value: serverStatus, release } = await SquadServer.rcon.serverStatus.get(ctx, { lock: true, ttl: 0 })
		const squadServerNextLayer = serverStatus.nextLayer
		try {
			const serverState = await getServerState({ lock: true }, ctx)
			if (!serverState.layerQueue[0]?.layerId) return null
			if (
				squadServerNextLayer === null ||
				(serverState.layerQueue[0]?.layerId && serverState.layerQueue[0]?.layerId !== squadServerNextLayer.id)
			) {
				await SquadServer.rcon.setNextLayer(ctx, M.getMiniLayerFromId(serverState.layerQueue[0].layerId))
			}
		} finally {
			release()
		}
	})

	// -------- setup vote state events --------
	if (initialServerState.currentVote && initialServerState.currentVote?.code !== 'ready') {
		registerVoteDeadline$(opCtx, initialServerState.currentVote.deadline)
	}

	// -------- If next layer is changed from ingame or some other system, then respect that and add layer to the front of the queue. --------
	SquadServer.rcon.serverStatus.observe(systemCtx).subscribe(async (status) => {
		if (status.nextLayer === null) return
		await systemCtx.db.transaction(async (tx) => {
			const { value: status, release } = await SquadServer.rcon.serverStatus.get(systemCtx, { lock: true, ttl: 50 })
			try {
				const _ctx = { ...systemCtx, db: tx }
				const serverState = await getServerState({ lock: true }, _ctx)
				if (status.nextLayer !== null && serverState.layerQueue[0]?.layerId !== status.nextLayer.id) {
					const layerQueue = deepClone(serverState.layerQueue)
					// if the last layer was also set by the gameserver, then we're replacing it
					if (layerQueue[0]?.source === 'gameserver') layerQueue.shift()
					layerQueue.unshift({ layerId: status.nextLayer.id, source: 'gameserver' })
					await tx
						.update(Schema.servers)
						.set(superjsonify(Schema.servers, { layerQueue, currentVote: null }))
						.where(eq(Schema.servers.id, CONFIG.serverId))
				}
			} finally {
				release()
			}
		})
	})

	SquadServer.rcon.event$.subscribe(async (event) => {
		const _log = log.child({ msgEventId: event.type })
		const db = DB.get({ log: _log })
		_log.debug('received squad server event: %s', event.type, event)
		const ctx = C.pushOperation({ db, log: _log }, 'layer-queue:handle-event')

		if (event.type === 'chat-message' && event.message.message.startsWith(CONFIG.commandPrefix)) {
			handleCommand(event.message, ctx)
		}

		if (event.type === 'chat-message' && event.message.message.match(/^\d+$/)) {
			handleVote(event.message, ctx)
		}
	})
}

async function handleCommand(msg: SM.ChatMessage, ctx: C.Log) {
	const words = msg.message.split(/\s+/)
	const cmdText = words[0].slice(1)
	// const args = words.slice(1)
	const allCommandStrings = Object.values(CONFIG.commands)
		.map((c) => c.strings)
		.flat()
	if (!allCommandStrings.includes(cmdText)) {
		const sortedMatches = StringComparison.diceCoefficient.sortMatch(cmdText, allCommandStrings)
		SquadServer.rcon.warn(ctx, msg.playerId, `Unknown command "${cmdText}". Did you mean ${sortedMatches[0]}?`)
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
			SquadServer.rcon.warn(ctx, msg.playerId, res.msg)
		}
		return
	}

	const errorMessage = `Error: Command type ${cmdText} is valid but unhandled`
	ctx.log.error(errorMessage)
	await SquadServer.rcon.warn(ctx, msg.playerId, errorMessage)
}

// -------- voting --------
async function startVote(ctx: C.Log & C.Db, opts?: { restart?: boolean; seqId?: number }) {
	await using opCtx = C.pushOperation(ctx, 'layer-queue:vote:start')
	opts ??= {}
	opts.restart ??= false
	const res = await DB.get(opCtx).transaction(async (db) => {
		const _ctx = { ...opCtx, db }
		const state = await getServerState({ lock: true }, _ctx)
		if (opts.seqId && state.layerQueueSeqId !== opts.seqId) {
			return GENERIC_ERRORS.outOfSyncError()
		}
		if (!state.currentVote) {
			return { code: 'err:no-vote-exists' as const, msg: 'No vote currently exists' }
		}
		if (!opts.restart && state.currentVote.code === 'in-progress') {
			return { code: 'err:vote-in-progress' as const, msg: 'A vote is already in progress' }
		}
		if (!opts.restart && state.currentVote.code.startsWith('ended:')) {
			return { code: 'err:vote-ended' as const, msg: 'The previous vote has ended' }
		}
		if (!opts.restart && state.currentVote.code !== 'ready') {
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
		return { code: 'ok' as const, currentVote, serverState: state }
	})
	if (res.code !== 'ok') return res
	const optionsText = res.currentVote.choices
		.map((layerId, index) => `${index + 1}: ${DisplayHelpers.toShortLayerNameFromId(layerId)}`)
		.join('\n')

	opCtx.tasks.push(
		SquadServer.rcon.broadcast(
			opCtx,
			`Voting for next layer has started! Options:\n${optionsText}\nYou have ${CONFIG.voteDurationSeconds} seconds to vote!`
		)
	)
	if (voteEndTask) throw new Error('Tried setting vote while a vote was already active')
	registerVoteDeadline$(opCtx, res.currentVote.deadline)
	serverState$.next([res.serverState, ctx])
	return { code: 'ok' as const }
}

async function handleVote(msg: SM.ChatMessage, ctx: C.Log & C.Db) {
	await using opCtx = C.pushOperation(ctx, 'layer-queue:vote:handle-vote')
	const choiceIdx = parseInt(msg.message)
	await opCtx.db.transaction(async (db) => {
		const serverState = await getServerState({ lock: true }, { ...opCtx, db })

		const currentVote = serverState.currentVote
		if (!currentVote) {
			return
		}
		if (currentVote.code !== 'in-progress') {
			return
		}

		const updatedVoteState = deepClone(currentVote)
		updatedVoteState.votes[msg.playerId] = updatedVoteState.choices[choiceIdx]
		await db.update(Schema.servers).set({ currentVote: updatedVoteState }).where(eq(Schema.servers.id, CONFIG.serverId))
	})
}

async function abortVote(ctx: C.Log & C.Db, aborter: bigint, seqId?: number) {
	await using opCtx = C.pushOperation(ctx, 'layer-queue:vote:abort')
	const res = await opCtx.db.transaction(async (tx) => {
		const _ctx = { ...opCtx, db: tx }
		const serverState = deepClone(await getServerState({ lock: true }, _ctx))
		if (seqId !== undefined && seqId !== serverState.layerQueueSeqId) return GENERIC_ERRORS.outOfSyncError()
		if (serverState.currentVote?.code !== 'in-progress') {
			return { code: 'err:no-vote-in-progress' as const, currentVote: serverState.currentVote }
		}
		serverState.currentVote = {
			...M.getVoteTallyProperties(serverState.currentVote),
			code: 'ended:aborted',
			abortReason: 'manual',
			aborter: aborter.toString(),
		}

		serverState.layerQueue[0].layerId = serverState.currentVote.defaultChoice
		serverState.layerQueueSeqId++
		await tx.update(Schema.servers).set(serverState).where(eq(Schema.servers.id, CONFIG.serverId))
		return { code: 'ok' as const, serverState }
	})
	if (res.code !== 'ok') return res
	opCtx.tasks.push(
		SquadServer.rcon.broadcast(
			opCtx,
			`Next Layer Vote was aborted. Next layer was defaulted to ${DisplayHelpers.toShortLayerNameFromId(
				res.serverState.layerQueue[0].layerId!
			)}`
		)
	)
	serverState$.next([res.serverState, ctx])
	return res
}

function registerVoteDeadline$(ctx: C.Log & C.Db, deadline: number) {
	voteEndTask?.unsubscribe()
	voteEndTask = of(0)
		.pipe(mergeMap(() => sleep(Math.max(deadline - Date.now(), 0))))
		.subscribe(async () => {
			await handleVoteTimeout(ctx)
		})
}

async function handleVoteTimeout(ctx: C.Log & C.Db) {
	await using opCtx = C.pushOperation(ctx, 'layer-queue:vote:handle-timeout')
	const res = await opCtx.db.transaction(async (db) => {
		const ctx = { ...opCtx, db }
		const serverState = deepClone(await getServerState({ lock: true }, ctx))
		const currentVote = serverState.currentVote
		if (!currentVote || currentVote.code !== 'in-progress') {
			return { code: 'err:no-vote-in-progress' as const, currentVote }
		}
		if (Object.values(currentVote.votes).length < CONFIG.minValidVotes) {
			ctx.tasks.push(
				SquadServer.rcon.broadcast(
					ctx,
					`Not enough votes to decide outcome! Defaulting to ${DisplayHelpers.toShortLayerNameFromId(currentVote.defaultChoice)}`
				)
			)
			serverState.layerQueue[0].layerId = currentVote.defaultChoice
			serverState.currentVote = {
				code: 'ended:aborted',
				abortReason: 'timeout:insufficient-votes',
				choices: currentVote.choices,
				defaultChoice: currentVote.defaultChoice,
				deadline: currentVote.deadline,
				votes: currentVote.votes,
			}
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
			serverState.currentVote = newVoteState
		}
		serverState.layerQueueSeqId++

		await ctx.db.update(Schema.servers).set(serverState).where(eq(Schema.servers.id, CONFIG.serverId))
		ctx.log.info('Vote timed out')
		return { code: 'ok' as const, serverState }
	})
	if (res.code === 'ok') {
		serverState$.next([res.serverState, ctx])
	}
	voteEndTask?.unsubscribe()
	voteEndTask = null
	return res
}

// -------- generic actions & data  --------
async function* watchServerStateUpdates(args: { ctx: C.Log & C.Db }) {
	for await (const [update] of toAsyncGenerator(serverState$)) {
		yield await includeServerStateParts(args.ctx, update)
	}
}

async function rollToNextLayer(state: { seqId: number }, ctx: C.Log & C.Db) {
	await using opCtx = C.pushOperation(ctx, 'layer-queue:roll-next')
	const { value: status, release } = await SquadServer.rcon.serverStatus.get(opCtx, { lock: true })
	try {
		if (status.nextLayer !== null) {
			return { code: 'err:no-next-layer' as const }
		}
		const serverState = deepClone(await getServerState({}, opCtx))
		if (state.seqId !== serverState.layerQueueSeqId) {
			return GENERIC_ERRORS.outOfSyncError()
		}

		const vote = serverState.currentVote
		if (vote?.code === 'in-progress') {
			return { code: 'err:vote-in-progress' as const }
		}

		await SquadServer.rcon.endGame(opCtx)
	} finally {
		release()
	}
}

async function updateQueue(args: { input: M.LayerQueueUpdate; ctx: C.Log & C.Db }) {
	await using opCtx = C.pushOperation(args.ctx, 'layer-queue:update')
	const { release, value: status } = await SquadServer.rcon.serverStatus.get(opCtx, { lock: true, ttl: 0 })
	try {
		const res = await opCtx.db.transaction(async (db) => {
			const _ctx = { ...opCtx, db }
			const serverState = deepClone(await getServerState({ lock: true }, _ctx))
			if (args.input.seqId !== serverState.layerQueueSeqId) {
				return { code: 'err:out-of-sync' as const, message: 'Update is out of sync' }
			}

			if (args.input.queue[0] && !deepEqual(args.input.queue[0], serverState.layerQueue[0])) {
				if (serverState.currentVote && serverState.currentVote.code === 'in-progress') {
					return {
						code: 'err:next-layer-changed-while-vote-active' as const,
					}
				}

				if (args.input.queue[0].vote) {
					serverState.currentVote = { code: 'ready' }
				} else {
					serverState.currentVote = null
				}
			}
			serverState.settings = args.input.settings
			serverState.layerQueue = args.input.queue
			serverState.layerQueueSeqId++
			let updatedNextLayerId: string | null = null
			// we're setting the default choice of a layer temporarily if
			const nextLayerId = serverState.layerQueue[0]?.layerId
			if (nextLayerId && status.nextLayer?.id !== nextLayerId) {
				updatedNextLayerId = nextLayerId
			}

			await db.update(Schema.servers).set(superjsonify(Schema.servers, serverState)).where(eq(Schema.servers.id, CONFIG.serverId))
			return { code: 'ok' as const, serverState, updatedNextLayerId }
		})

		if (res.code !== 'ok') return res
		if (res.updatedNextLayerId !== null) await SquadServer.rcon.setNextLayer(opCtx, M.getMiniLayerFromId(res.updatedNextLayerId))
		serverState$.next([res.serverState, args.ctx])
		return res
	} finally {
		release()
	}
}

// -------- utility --------
async function getServerState({ lock }: { lock?: boolean }, ctx: C.Db & C.Log) {
	lock ??= false
	const query = ctx.db.select().from(Schema.servers).where(eq(Schema.servers.id, CONFIG.serverId))
	let serverRaw: any
	if (lock) [serverRaw] = await query.for('update')
	else [serverRaw] = await query
	return M.ServerStateSchema.parse(unsuperjsonify(Schema.servers, serverRaw))
}

async function includeServerStateParts(ctx: C.Db & C.Log, _serverState: M.ServerState): Promise<M.ServerState & M.UserPart> {
	const state = deepClone(_serverState) as M.ServerState & M.UserPart
	state.parts = { users: [] }
	if (state.currentVote?.code === 'ended:aborted' && state.currentVote.abortReason === 'manual') {
		if (state.currentVote.aborter === undefined) throw new Error('aborter is undefined when given abortReason of "manual"')
		const [user] = await ctx.db
			.select()
			.from(Schema.users)
			.where(eq(Schema.users.discordId, BigInt(state.currentVote.aborter)))
		if (user) {
			state.parts.users.push(user)
		} else {
			ctx.log.warn('cannot find user data for vote aborter: %d', state.currentVote.aborter)
		}
	}
	return state
}

// -------- setup router --------
export const serverRouter = router({
	watchServerState: procedure.subscription(watchServerStateUpdates),
	startVote: procedureWithInput(M.StartVoteSchema).mutation(async ({ input, ctx }) => startVote(ctx, input)),
	abortVote: procedureWithInput(z.object({ seqId: z.number() })).mutation(async ({ input, ctx }) => {
		return await abortVote(ctx, ctx.user.discordId, input.seqId)
	}),
	updateQueue: procedureWithInput(M.GenericServerStateUpdateSchema).mutation(updateQueue),
	rollToNextLayer: procedureWithInput(z.object({ seqId: z.number() })).mutation(({ ctx, input }) => rollToNextLayer(input, ctx)),
})
