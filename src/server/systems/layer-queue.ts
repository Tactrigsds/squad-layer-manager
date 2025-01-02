import * as E from 'drizzle-orm/expressions'
import deepEqual from 'fast-deep-equal'
import { BehaviorSubject, distinctUntilChanged, map, mergeMap, of, Subscription } from 'rxjs'
import StringComparison from 'string-comparison'
import { z } from 'zod'
import * as FB from '@/lib/filter-builders.ts'

import { distinctDeepEquals, sleep, toAsyncGenerator } from '@/lib/async.ts'
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
import * as LayersQuery from '@/server/systems/layers-query.ts'

import { procedure, router } from '../trpc'
import { superjsonify, unsuperjsonify } from '@/lib/drizzle'
import { assertNever } from '@/lib/typeGuards'

export let serverStateUpdate$!: BehaviorSubject<[M.LQServerStateUpdate, C.Log & C.Db]>
let voteEndTask: Subscription | null = null

const GENERIC_ERRORS = {
	outOfSyncError() {
		return {
			code: 'err:out-of-sync' as const,
			msg: 'Out of sync with server. Please retry update.',
		}
	},
}

export async function setupLayerQueueAndServerState() {
	const log = baseLogger
	const systemCtx = DB.addPooledDb({ log })

	await using opCtx = C.pushOperation(systemCtx, 'layer-queue:setup', {
		level: 'info',
	})

	// -------- bring server up to date with configuration --------
	console.log('initializing')
	const initialServerState = await opCtx.db().transaction(async (tx) => {
		console.log('setting up server state')
		let [server] = await tx.select().from(Schema.servers).where(E.eq(Schema.servers.id, CONFIG.serverId)).for('update')
		server = server ? (unsuperjsonify(Schema.servers, server) as typeof server) : server
		if (!server) {
			await tx.insert(Schema.servers).values({
				id: CONFIG.serverId,
				displayName: CONFIG.serverDisplayName,
			})
			;[server] = await tx.select().from(Schema.servers).where(E.eq(Schema.servers.id, CONFIG.serverId))
			server = server ? (unsuperjsonify(Schema.servers, server) as typeof server) : server
		}
		if (server.displayName !== CONFIG.serverDisplayName) {
			await tx
				.update(Schema.servers)
				.set({
					displayName: CONFIG.serverDisplayName,
				})
				.where(E.eq(Schema.servers.id, CONFIG.serverId))
			server.displayName = CONFIG.serverDisplayName
		}

		console.log('finished setting up')
		opCtx.log.info('finished setting up server state')
		return M.ServerStateSchema.parse(server)
	})

	const initialStateUpdate: M.LQServerStateUpdate = { state: initialServerState, source: { type: 'system', reason: 'app-startup' } }
	serverStateUpdate$ = new BehaviorSubject([initialStateUpdate, systemCtx])
	serverStateUpdate$.subscribe(([state, ctx]) => {
		ctx.log.info({ state }, 'pushing server state update')
	})

	// -------- set next layer on server if necessary --------
	await opCtx.db().transaction(async (tx) => {
		const ctx = { ...opCtx, db: () => tx }
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
	SquadServer.rcon.serverStatus
		.observe(systemCtx)
		.pipe(distinctDeepEquals())
		.subscribe(async (status) => {
			if (status.nextLayer === null) return
			await systemCtx.db().transaction(async (tx) => {
				// TODO don't call this inside the transaction
				const _ctx = { ...systemCtx, db: () => tx }
				const serverState = await getServerState({ lock: true }, _ctx)
				if (status.nextLayer !== null && serverState.layerQueue[0]?.layerId !== status.nextLayer.id) {
					const layerQueue = deepClone(serverState.layerQueue)
					// if the last layer was also set by the gameserver, then we're replacing it
					if (layerQueue[0]?.source === 'gameserver') layerQueue.shift()
					layerQueue.unshift({
						layerId: status.nextLayer.id,
						source: 'gameserver',
					})
					await tx
						.update(Schema.servers)
						.set(superjsonify(Schema.servers, { layerQueue, currentVote: null }))
						.where(E.eq(Schema.servers.id, CONFIG.serverId))
				}
			})
		})

	// -------- apply history filters cache --------
	{
		SquadServer.rcon.serverStatus
			.observe(systemCtx)
			.pipe(
				distinctDeepEquals(),
				map((status) => status.currentLayer),
				distinctUntilChanged()
			)
			.subscribe(() => {
				LayersQuery.historyFiltersCache.clear()
			})
	}

	SquadServer.rcon.event$.subscribe(async (event) => {
		await using ctx = C.pushOperation({ ...systemCtx, msgEventid: event.type }, 'layer-queue:handle-event')

		if (event.type === 'chat-message' && event.message.message.startsWith(CONFIG.commandPrefix)) {
			await handleCommand(event.message, ctx)
		}

		if (event.type === 'chat-message' && event.message.message.match(/^\d+$/)) {
			await handleVote(event.message, ctx)
		}
	})
}

async function handleCommand(msg: SM.ChatMessage, ctx: C.Log & C.Db) {
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
		const res = await startVote(ctx, { s64UserId: msg.steamID! })
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
async function startVote(_ctx: C.Log & C.Db & Partial<C.User>, opts?: { restart?: boolean; seqId?: number; s64UserId?: string }) {
	await using ctx = C.pushOperation(_ctx, 'layer-queue:vote:start')
	opts ??= {}
	opts.restart ??= false
	const res = await ctx.db().transaction(async (tx) => {
		const txCtx = { ...ctx, db: () => tx }
		const state = await getServerState({ lock: true }, txCtx)
		if (opts.seqId && state.layerQueueSeqId !== opts.seqId) {
			return GENERIC_ERRORS.outOfSyncError()
		}
		if (!state.currentVote) {
			return {
				code: 'err:no-vote-exists' as const,
				msg: 'No vote currently exists',
			}
		}
		if (!opts.restart && state.currentVote.code === 'in-progress') {
			return {
				code: 'err:vote-in-progress' as const,
				msg: 'A vote is already in progress',
			}
		}
		if (!opts.restart && state.currentVote.code.startsWith('ended:')) {
			return {
				code: 'err:vote-ended' as const,
				msg: 'The previous vote has ended',
			}
		}
		if (!opts.restart && state.currentVote.code !== 'ready') {
			return {
				code: 'err:vote-not-ready' as const,
				msg: 'Vote is not in a ready state',
			}
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
		await txCtx.db().update(Schema.servers).set(superjsonify(Schema.servers, state)).where(E.eq(Schema.servers.id, CONFIG.serverId))
		return { code: 'ok' as const, currentVote, serverState: state }
	})
	if (res.code !== 'ok') return res
	const optionsText = res.currentVote.choices
		.map((layerId, index) => `${index + 1}: ${DisplayHelpers.toShortLayerNameFromId(layerId)}`)
		.join('\n')

	ctx.tasks.push(
		SquadServer.rcon.broadcast(
			ctx,
			`Voting for next layer has started! Options:\n${optionsText}\nYou have ${CONFIG.voteDurationSeconds} seconds to vote!`
		)
	)
	if (voteEndTask) {
		throw new Error('Tried setting vote while a vote was already active')
	}
	registerVoteDeadline$(ctx, res.currentVote.deadline)
	const update: M.LQServerStateUpdate = {
		state: res.serverState,
		source: ctx.user
			? { type: 'manual', author: ctx.user.discordId, reason: 'start-vote' }
			: { type: 'chat-command', reason: 'start-vote', s64UserId: opts!.s64UserId! },
	}
	serverStateUpdate$.next([update, _ctx])
	return { code: 'ok' as const }
}

async function handleVote(msg: SM.ChatMessage, ctx: C.Log & C.Db) {
	await using opCtx = C.pushOperation(ctx, 'layer-queue:vote:handle-vote')
	const choiceIdx = parseInt(msg.message)
	await opCtx.db().transaction(async (tx) => {
		const serverState = await getServerState(
			{ lock: true },
			{
				...opCtx,
				db: () => tx,
			}
		)

		const currentVote = serverState.currentVote
		if (!currentVote) {
			return
		}
		if (currentVote.code !== 'in-progress') {
			return
		}

		const updatedVoteState = deepClone(currentVote)
		updatedVoteState.votes[msg.playerId] = updatedVoteState.choices[choiceIdx]
		await tx
			.update(Schema.servers)
			.set(superjsonify(Schema.servers, { currentVote: updatedVoteState }))
			.where(E.eq(Schema.servers.id, CONFIG.serverId))
	})
}

async function abortVote(ctx: C.Log & C.Db & C.User, aborter: bigint, seqId?: number) {
	await using opCtx = C.pushOperation(ctx, 'layer-queue:vote:abort')
	const res = await opCtx.db().transaction(async (tx) => {
		const serverState = deepClone(await getServerState({ lock: true }, { ...opCtx, db: () => tx }))
		if (seqId !== undefined && seqId !== serverState.layerQueueSeqId) {
			return GENERIC_ERRORS.outOfSyncError()
		}
		if (serverState.currentVote?.code !== 'in-progress') {
			return {
				code: 'err:no-vote-in-progress' as const,
				currentVote: serverState.currentVote,
			}
		}
		serverState.currentVote = {
			...M.getVoteTallyProperties(serverState.currentVote),
			code: 'ended:aborted',
			abortReason: 'manual',
			aborter: aborter.toString(),
		}

		serverState.layerQueue[0].layerId = serverState.currentVote.defaultChoice
		serverState.layerQueueSeqId++
		await tx.update(Schema.servers).set(superjsonify(Schema.servers, serverState)).where(E.eq(Schema.servers.id, CONFIG.serverId))
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
	const update: M.LQServerStateUpdate = {
		state: res.serverState,
		source: { type: 'manual', author: ctx.user.discordId, reason: 'abort-vote' },
	}
	serverStateUpdate$.next([update, ctx])
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
	const res = await opCtx.db().transaction(async (tx) => {
		const ctx = { ...opCtx, db: () => tx }
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

		await ctx.db().update(Schema.servers).set(superjsonify(Schema.servers, serverState)).where(E.eq(Schema.servers.id, CONFIG.serverId))
		ctx.log.info('Vote timed out')
		return { code: 'ok' as const, serverState }
	})
	if (res.code === 'ok') {
		const update: M.LQServerStateUpdate = {
			state: res.serverState,
			source: { type: 'system', reason: 'vote-timeout' },
		}
		serverStateUpdate$.next([update, ctx])
	}
	voteEndTask?.unsubscribe()
	voteEndTask = null
	return res
}

// -------- generic actions & data  --------
async function* watchServerStateUpdates(args: { ctx: C.Log & C.Db }) {
	for await (const [update] of toAsyncGenerator(serverStateUpdate$)) {
		const withParts = await includeServerUpdateParts(args.ctx, update)
		args.ctx.log.info(withParts, 'server state update')
		yield withParts
	}
}

async function rollToNextLayer(state: { seqId: number }, ctx: C.Log & C.Db) {
	await using opCtx = C.pushOperation(ctx, 'layer-queue:roll-next')
	const { value: status } = await SquadServer.rcon.serverStatus.get(opCtx, { ttl: 50 })
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
}

async function updateQueue(args: { input: M.MutableServerState; ctx: C.Log & C.Db & C.User }) {
	await using opCtx = C.pushOperation(args.ctx, 'layer-queue:update')
	const res = await opCtx.db().transaction(async (tx) => {
		const serverState = deepClone(await getServerState({ lock: true }, { ...opCtx, db: () => tx }))
		if (args.input.layerQueueSeqId !== serverState.layerQueueSeqId) {
			return {
				code: 'err:out-of-sync' as const,
				message: 'Update is out of sync',
			}
		}

		if (args.input.layerQueue[0] && !deepEqual(args.input.layerQueue[0], serverState.layerQueue[0])) {
			if (serverState.currentVote && serverState.currentVote.code === 'in-progress') {
				return {
					code: 'err:next-layer-changed-while-vote-active' as const,
				}
			}

			if (args.input.layerQueue[0].vote) {
				serverState.currentVote = { code: 'ready' }
			} else {
				serverState.currentVote = null
			}
		}
		serverState.settings = args.input.settings
		serverState.layerQueue = args.input.layerQueue
		serverState.historyFilters = args.input.historyFilters
		serverState.layerQueueSeqId++

		const nextLayerId = serverState.layerQueue?.[0]?.layerId ?? serverState.layerQueue?.[0]?.vote?.defaultChoice ?? null

		await tx.update(Schema.servers).set(superjsonify(Schema.servers, serverState)).where(E.eq(Schema.servers.id, CONFIG.serverId))
		return { code: 'ok' as const, serverState, updatedNextLayerId: nextLayerId }
	})

	if (res.code !== 'ok') return res
	if (res.updatedNextLayerId !== null) {
		await SquadServer.rcon.setNextLayer(opCtx, M.getMiniLayerFromId(res.updatedNextLayerId))
	}
	const update: M.LQServerStateUpdate = {
		state: res.serverState,
		source: { type: 'manual', author: args.ctx.user.discordId, reason: 'edit' },
	}
	serverStateUpdate$.next([update, opCtx])
	return { code: 'ok' as const, serverStateUpdate: await includeServerUpdateParts(opCtx, update) }
}

// -------- utility --------
async function getServerState({ lock }: { lock?: boolean }, ctx: C.Db & C.Log) {
	lock ??= false
	const query = ctx.db().select().from(Schema.servers).where(E.eq(Schema.servers.id, CONFIG.serverId))
	let serverRaw: any
	if (lock) [serverRaw] = await query.for('update')
	else [serverRaw] = await query
	return M.ServerStateSchema.parse(unsuperjsonify(Schema.servers, serverRaw))
}

async function includeServerUpdateParts(
	ctx: C.Db & C.Log,
	_serverStateUpdate: M.LQServerStateUpdate
): Promise<M.LQServerStateUpdate & M.UserPart> {
	const update = deepClone(_serverStateUpdate) as M.LQServerStateUpdate & M.UserPart
	update.parts = { users: [] }
	const state = update.state
	if (state.currentVote?.code === 'ended:aborted' && state.currentVote.abortReason === 'manual') {
		if (state.currentVote.aborter === undefined) {
			throw new Error('aborter is undefined when given abortReason of "manual"')
		}
		const userIds = [BigInt(state.currentVote.aborter)]
		if (update.source.type === 'manual') {
			userIds.push(BigInt(update.source.author))
		}
		const users = await ctx.db().select().from(Schema.users).where(E.inArray(Schema.users.discordId, userIds))
		for (const user of users) {
			update.parts.users.push(user)
		}
	}
	return update
}

async function generateLayerQueueItems(_ctx: C.Log & C.Db, opts: M.GenLayerQueueItemsOptions) {
	await using ctx = C.pushOperation(_ctx, 'layer-queue:generate-layer-items')
	if (opts.numToAdd <= 0) {
		throw new Error('cannot generate layers with count <= 0')
	}

	let pageSize: number
	switch (opts.itemType) {
		case 'layer':
			pageSize = opts.numToAdd
			break
		case 'vote':
			pageSize = opts.numToAdd * opts.numVoteChoices
			break
		default:
			assertNever(opts.itemType)
	}
	const filter = opts.baseFilterId ? FB.applyFilter(opts.baseFilterId) : undefined
	const layers = await LayersQuery.runLayersQuery({
		ctx,
		input: {
			sort: {
				seed: Math.ceil(Math.random() * Number.MAX_SAFE_INTEGER),
				type: 'random',
			},
			pageSize,
			pageIndex: 0,
			filter,
		},
	}).then((r) => r.layers)

	const res: M.LayerQueueItem[] = []
	switch (opts.itemType) {
		case 'layer':
			for (const layer of layers) {
				res.push({ layerId: layer.id, source: 'generated' })
			}
			break
		case 'vote':
			for (let i = 0; i < opts.numToAdd; i++) {
				const choices = layers.slice(i * opts.numVoteChoices, (i + 1) * opts.numVoteChoices).map((l) => l.id)
				res.push({
					vote: { choices, defaultChoice: choices[0] },
					source: 'generated',
				})
			}
			break
		default:
			assertNever(opts.itemType)
	}
	return res
}

// -------- setup router --------
export const layerQueueRouter = router({
	watchServerState: procedure.subscription(watchServerStateUpdates),
	generateLayerQueueItems: procedure
		.input(M.GenLayerQueueItemsOptionsSchema)
		.query(({ input, ctx }) => generateLayerQueueItems(ctx, input)),
	startVote: procedure.input(M.StartVoteSchema).mutation(async ({ input, ctx }) => startVote(ctx, input)),
	abortVote: procedure.input(z.object({ seqId: z.number() })).mutation(async ({ input, ctx }) => {
		return await abortVote(ctx, ctx.user.discordId, input.seqId)
	}),
	updateQueue: procedure.input(M.GenericServerStateUpdateSchema).mutation(updateQueue),
	rollToNextLayer: procedure.input(z.object({ seqId: z.number() })).mutation(({ ctx, input }) => rollToNextLayer(input, ctx)),
})
