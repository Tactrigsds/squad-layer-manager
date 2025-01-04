import * as E from 'drizzle-orm/expressions'
import deepEqual from 'fast-deep-equal'
import { BehaviorSubject, distinctUntilChanged, map, mergeMap, of, Subject, Subscription } from 'rxjs'
import StringComparison from 'string-comparison'
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
import { Parts } from '@/lib/types'

export let serverStateUpdate$!: BehaviorSubject<[M.LQServerStateUpdate & Partial<Parts<M.UserPart>>, C.Log & C.Db]>
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
	const initialServerState = await opCtx.db().transaction(async (tx) => {
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

		opCtx.log.info('finished setting up server state')
		return M.ServerStateSchema.parse(server)
	})

	const initialStateUpdate: M.LQServerStateUpdate = { state: initialServerState, source: { type: 'system', event: 'app-startup' } }
	serverStateUpdate$ = new BehaviorSubject([initialStateUpdate, systemCtx])
	serverStateUpdate$.subscribe(([state, ctx]) => {
		ctx.log.debug({ seqId: state.state.layerQueueSeqId }, 'pushing server state update')
	})

	// -------- set next layer on server --------
	{
		const nextLayer = M.getNextLayerId(initialStateUpdate.state.layerQueue)
		if (nextLayer) await SquadServer.rcon.setNextLayer(opCtx, M.getMiniLayerFromId(nextLayer))
	}

	// -------- setup vote state events --------
	if (initialServerState.layerQueue[0]?.vote) {
		voteState = {
			code: 'ready',
			choices: initialServerState.layerQueue[0].vote.choices,
			defaultChoice: initialServerState.layerQueue[0].vote.defaultChoice,
		}
		voteUpdate$.next([opCtx, { state: voteState, source: { type: 'system', event: 'app-startup' } }])
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
				if (!status.nextLayer || status.nextLayer.code === 'unknown') return
				const nextLayer = status.nextLayer.layer
				const serverNextLayerId = M.getNextLayerId(serverState.layerQueue)
				if (serverNextLayerId !== nextLayer.id) {
					const layerQueue = deepClone(serverState.layerQueue)
					// if the last layer was also set by the gameserver, then we're replacing it
					if (layerQueue[0]?.source === 'gameserver') layerQueue.shift()
					layerQueue.unshift({
						layerId: nextLayer.id,
						source: 'gameserver',
					})
					await tx.update(Schema.servers).set(superjsonify(Schema.servers, { layerQueue })).where(E.eq(Schema.servers.id, CONFIG.serverId))
					voteState = null
					voteUpdate$.next([_ctx, { state: null, source: { type: 'system', event: 'next-layer-set' } }])
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
		const res = await startVote(ctx, { initiator: { steamId: msg.steamID! } })
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
//
let voteState: M.VoteState | null = null
const voteUpdate$ = new Subject<[C.Log & C.Db, M.VoteStateUpdate]>()

async function* watchVoteStateUpdates() {
	yield { code: 'intial-state' as const, state: voteState }
	for await (const [ctx, update] of toAsyncGenerator(voteUpdate$)) {
		const withParts = await includeVoteStateUpdatePart(ctx, update)
		yield { code: 'update' as const, update: withParts }
	}
}

async function startVote(
	_ctx: C.Log & C.Db & Partial<C.User>,
	opts: { restart?: boolean; durationSeconds?: number; minValidVotes?: number; initiator: M.GuiOrChatUserId }
) {
	await using ctx = C.pushOperation(_ctx, 'layer-queue:vote:start', { startMsgBindings: opts })
	const restart = opts.restart ?? false
	const durationSeconds = opts.durationSeconds ?? CONFIG.defaults.voteDurationSeconds
	const minValidVotes = opts.minValidVotes ?? CONFIG.defaults.minValidVotes
	if (!voteState) {
		return {
			code: 'err:no-vote-exists' as const,
			msg: 'No vote currently exists',
		}
	}
	if (!restart && voteState.code === 'in-progress') {
		return {
			code: 'err:vote-in-progress' as const,
			msg: 'A vote is already in progress',
		}
	}
	if (!restart && voteState.code.startsWith('ended:')) {
		return {
			code: 'err:vote-ended' as const,
			msg: 'The previous vote has ended',
		}
	}
	if (!restart && voteState.code !== 'ready') {
		return {
			code: 'err:vote-not-ready' as const,
			msg: 'Vote is not in a ready state',
		}
	}

	const updatedVoteState = {
		code: 'in-progress',
		choices: voteState.choices,
		defaultChoice: voteState.defaultChoice,
		deadline: Date.now() + durationSeconds * 1000,
		votes: {},
		minValidVotes,
		initiator: opts.initiator,
	} satisfies M.VoteState

	const optionsText = updatedVoteState.choices
		.map((layerId, index) => `${index + 1}: ${DisplayHelpers.toFullLayerNameFromId(layerId)}`)
		.join('\n')

	if (voteEndTask) {
		throw new Error('Tried setting vote while a vote was already active')
	}
	registerVoteDeadline$(ctx, updatedVoteState.deadline)
	const update: M.VoteStateUpdate = {
		state: updatedVoteState,
		source: {
			type: 'manual',
			event: 'start-vote',
			user: opts.initiator,
		},
	}
	voteState = updatedVoteState
	voteUpdate$.next([ctx, update])
	await SquadServer.rcon.broadcast(
		ctx,
		`Voting for next layer has started! Options:\n${optionsText}\nYou have ${durationSeconds} seconds to vote!`
	)

	return { code: 'ok' as const }
}

async function handleVote(msg: SM.ChatMessage, ctx: C.Log & C.Db) {
	await using opCtx = C.pushOperation(ctx, 'layer-queue:vote:handle-vote')
	const choiceIdx = parseInt(msg.message)
	if (choiceIdx <= 0) {
		await SquadServer.rcon.warn(opCtx, msg.playerId, 'Invalid vote choice')
		return
	}
	if (!voteState) {
		return
	}
	if (voteState.code !== 'in-progress') {
		await SquadServer.rcon.warn(opCtx, msg.playerId, 'No vote in progress')
		return
	}
	if (choiceIdx > voteState.choices.length) {
		await SquadServer.rcon.warn(opCtx, msg.playerId, 'Invalid vote choice')
		return
	}

	const updatedVoteState = deepClone(voteState)
	updatedVoteState.votes[msg.playerId] = updatedVoteState.choices[choiceIdx - 1]
	const update: M.VoteStateUpdate = {
		state: updatedVoteState,
		source: {
			type: 'manual',
			event: 'vote',
			user: { steamId: msg.playerId },
		},
	}

	voteState = updatedVoteState
	voteUpdate$.next([opCtx, update])
	await SquadServer.rcon.warn(
		opCtx,
		msg.playerId,
		`You chose
		${DisplayHelpers.toFullLayerNameFromId(updatedVoteState.choices[choiceIdx - 1])}. Thanks for voting!`
	)
}

async function abortVote(ctx: C.Log & C.Db, opts: { aborter: M.GuiOrChatUserId }) {
	await using opCtx = C.pushOperation(ctx, 'layer-queue:vote:abort')

	if (!voteState || voteState?.code !== 'in-progress') {
		return {
			code: 'err:no-vote-in-progress' as const,
		}
	}

	const newVoteState: M.VoteState = {
		choices: voteState.choices,
		defaultChoice: voteState.defaultChoice,
		deadline: voteState.deadline,
		votes: voteState.votes,
		code: 'ended:aborted',
		aborter: opts.aborter,
	}

	const update: M.VoteStateUpdate = {
		state: newVoteState,
		source: { type: 'manual', user: opts.aborter, event: 'abort-vote' },
	}
	voteState = newVoteState
	voteUpdate$.next([ctx, update])
	await SquadServer.rcon.broadcast(opCtx, `Next Layer Vote was aborted.`)
	return { code: 'ok' as const }
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
		if (!voteState || voteState.code !== 'in-progress') {
			return { code: 'err:no-vote-in-progress' as const, currentVote: voteState }
		}
		let newVoteState: M.VoteState
		let voteUpdate: M.VoteStateUpdate
		if (Object.values(voteState.votes).length < voteState.minValidVotes) {
			serverState.layerQueue[0].layerId = voteState.defaultChoice
			newVoteState = {
				code: 'ended:insufficient-votes',
				choices: voteState.choices,
				defaultChoice: voteState.defaultChoice,
				deadline: voteState.deadline,
				votes: voteState.votes,
			}
			voteUpdate = {
				source: { type: 'system', event: 'vote-timeout' },
				state: newVoteState,
			}
		} else {
			const tally = new Map<string, number>()
			let maxVotes: string | null = null
			for (const choice of Object.values(voteState.votes)) {
				tally.set(choice, (tally.get(choice) || 0) + 1)

				if (maxVotes === null || tally.get(choice)! > tally.get(maxVotes)!) {
					maxVotes = choice
				}
			}
			// maxVotes will be set since we have at least one choice if we've got at least one vote
			const result = { choice: maxVotes!, votes: tally.get(maxVotes!)! }
			serverState.layerQueue[0].layerId = result.choice
			newVoteState = {
				choices: voteState.choices,
				defaultChoice: voteState.defaultChoice,
				deadline: voteState.deadline,
				votes: voteState.votes,

				code: 'ended:winner',
				winner: result.choice,
			}
			voteUpdate = {
				source: { type: 'system', event: 'vote-timeout' },
				state: newVoteState,
			}
		}
		await ctx.db().update(Schema.servers).set(superjsonify(Schema.servers, serverState)).where(E.eq(Schema.servers.id, CONFIG.serverId))
		return { code: 'ok' as const, serverState, voteUpdate }
	})
	voteEndTask?.unsubscribe()
	voteEndTask = null
	if (res.code !== 'ok') return res
	const update: M.LQServerStateUpdate = {
		state: res.serverState,
		source: { type: 'system', event: 'vote-timeout' },
	}
	serverStateUpdate$.next([update, ctx])
	voteState = res.voteUpdate.state
	voteUpdate$.next([ctx, res.voteUpdate])
	if (res.voteUpdate.state!.code === 'ended:winner') {
		await SquadServer.rcon.broadcast(
			ctx,
			`Voting has ended! Next layer will be ${DisplayHelpers.toFullLayerName(M.getMiniLayerFromId(res.voteUpdate.state!.winner))}`
		)
	}
	if (res.voteUpdate!.state!.code === 'ended:insufficient-votes') {
		await SquadServer.rcon.broadcast(
			ctx,
			`Voting has ended! Not enough votes to decide outcome. Defaulting to ${DisplayHelpers.toFullLayerName(M.getMiniLayerFromId(res.voteUpdate.state!.defaultChoice))}`
		)
	}
	return res
}

async function includeVoteStateUpdatePart(ctx: C.Log & C.Db, update: M.VoteStateUpdate) {
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
	const withParts: M.VoteStateUpdate & Parts<M.UserPart> = { ...update, parts: { users } }
	return withParts
}
function getVoteStateDiscordIds(state: M.VoteState) {
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

// -------- generic actions & data  --------
async function* watchServerStateUpdates(args: { ctx: C.Log & C.Db }) {
	for await (const [update] of toAsyncGenerator(serverStateUpdate$)) {
		if (update.parts) {
			yield update
		} else {
			const withParts = await includeServerUpdateParts(args.ctx, update)
			yield withParts
		}
	}
}

async function updateQueue({ input, ctx }: { input: M.MutableServerState; ctx: C.Log & C.Db & C.User }) {
	input = deepClone(input)
	await using opCtx = C.pushOperation(ctx, 'layer-queue:update')
	const res = await opCtx.db().transaction(async (tx) => {
		const serverState = deepClone(await getServerState({ lock: true }, { ...opCtx, db: () => tx }))
		if (input.layerQueueSeqId !== serverState.layerQueueSeqId) {
			return {
				code: 'err:out-of-sync' as const,
				message: 'Update is out of sync',
			}
		}

		let newVoteState: M.VoteState | null | undefined
		if (input.layerQueue[0] && !deepEqual(input.layerQueue[0], serverState.layerQueue[0])) {
			if (voteState && voteState.code === 'in-progress') {
				return {
					code: 'err:next-layer-changed-while-vote-active' as const,
				}
			}

			if (input.layerQueue[0].vote) {
				const layerVoteDetails = input.layerQueue[0].vote
				newVoteState = { code: 'ready', choices: layerVoteDetails.choices, defaultChoice: layerVoteDetails.defaultChoice }
			} else {
				newVoteState = null
			}
		}
		// in case we have voted for a layer that has been shuffled to the back
		for (let i = 1; i < input.layerQueue.length; i++) {
			const item = input.layerQueue[i]
			if (item.vote && item.layerId) {
				delete item.layerId
			}
		}
		serverState.settings = input.settings
		serverState.layerQueue = input.layerQueue
		serverState.historyFilters = input.historyFilters
		serverState.layerQueueSeqId++

		const nextLayerId = serverState.layerQueue?.[0]?.layerId ?? serverState.layerQueue?.[0]?.vote?.defaultChoice ?? null

		await tx.update(Schema.servers).set(superjsonify(Schema.servers, serverState)).where(E.eq(Schema.servers.id, CONFIG.serverId))
		return { code: 'ok' as const, serverState, updatedNextLayerId: nextLayerId, newVoteState }
	})

	if (res.code !== 'ok') return res
	if (res.updatedNextLayerId !== null) {
		await SquadServer.rcon.setNextLayer(opCtx, M.getMiniLayerFromId(res.updatedNextLayerId))
	}
	const update: M.LQServerStateUpdate = {
		state: res.serverState,
		source: { type: 'manual', user: { discordId: ctx.user.discordId }, event: 'edit' },
	}
	const withParts = await includeServerUpdateParts(ctx, update)
	serverStateUpdate$.next([withParts, opCtx])
	if (res.newVoteState !== undefined) {
		voteState = res.newVoteState
		voteUpdate$.next([
			opCtx,
			{ state: voteState, source: { type: 'manual', event: 'queue-change', user: { discordId: opCtx.user.discordId } } },
		])
	}
	return { code: 'ok' as const, serverStateUpdate: withParts }
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
): Promise<M.LQServerStateUpdate & Parts<M.UserPart>> {
	const update = { ...deepClone(_serverStateUpdate), parts: { users: [] } } as M.LQServerStateUpdate & Parts<M.UserPart>
	const state = update.state
	const userIds: bigint[] = []
	if (update.source.type === 'manual' && update.source.user.discordId) {
		userIds.push(BigInt(update.source.user.discordId))
	}
	for (const item of state.layerQueue) {
		if (item.lastModifiedBy) userIds.push(BigInt(item.lastModifiedBy))
	}

	let users: Schema.User[] = []
	if (userIds.length > 0) {
		users = await ctx.db().select().from(Schema.users).where(E.inArray(Schema.users.discordId, userIds))
	}
	for (const user of users) {
		update.parts.users.push(user)
	}
	return update
}

async function generateLayerQueueItems(_ctx: C.Log & C.Db & C.User, opts: M.GenLayerQueueItemsOptions) {
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
					lastModifiedBy: ctx.user.discordId,
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
	watchVoteStateUpdates: procedure.subscription(watchVoteStateUpdates),
	generateLayerQueueItems: procedure
		.input(M.GenLayerQueueItemsOptionsSchema)
		.query(({ input, ctx }) => generateLayerQueueItems(ctx, input)),
	startVote: procedure
		.input(M.StartVoteInputSchema)
		.mutation(async ({ input, ctx }) => startVote(ctx, { ...input, initiator: { discordId: ctx.user.discordId } })),
	abortVote: procedure.mutation(async ({ ctx }) => {
		return await abortVote(ctx, { aborter: { discordId: ctx.user.discordId } })
	}),
	updateQueue: procedure.input(M.GenericServerStateUpdateSchema).mutation(updateQueue),
})
