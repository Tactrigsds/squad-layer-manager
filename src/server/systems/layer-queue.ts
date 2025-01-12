import * as E from 'drizzle-orm/expressions'
import deepEqual from 'fast-deep-equal'
import { BehaviorSubject, distinctUntilChanged, map, mergeMap, of, scan, Subject, Subscription } from 'rxjs'
import * as FB from '@/lib/filter-builders.ts'

import { AsyncExclusiveTaskRunner, distinctDeepEquals, sleep, toAsyncGenerator } from '@/lib/async.ts'
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

import { procedure, router } from '../trpc.server.ts'
import { superjsonify, unsuperjsonify } from '@/lib/drizzle'
import { assertNever } from '@/lib/typeGuards'
import { Parts } from '@/lib/types'
import { BROADCASTS, WARNS } from '@/messages.ts'
import { interval } from 'rxjs'

export let serverStateUpdate$!: BehaviorSubject<[M.LQServerStateUpdate & Partial<Parts<M.UserPart>>, C.Log & C.Db]>
let voteEndTask: Subscription | null = null

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

	// -------- schedule post-roll reminders --------
	interval(1000 * 60 * 10).subscribe(async () => {
		using opCtx = C.pushOperation(systemCtx, 'layer-queue:reminders')
		const serverState = await getServerState({}, opCtx)
		if (serverState.layerQueue.length === 0) {
			await SquadServer.warnAllAdmins(opCtx, WARNS.queue.empty)
		} else if (serverState.layerQueue.length <= CONFIG.lowQueueWarningThreshold) {
			await SquadServer.warnAllAdmins(opCtx, WARNS.queue.lowLayerCount(serverState.layerQueue.length))
		}
	})

	// -------- setup vote state events --------
	if (initialServerState.layerQueue[0]?.vote) {
		voteState = {
			code: 'ready',
			choices: initialServerState.layerQueue[0].vote.choices,
			defaultChoice: initialServerState.layerQueue[0].vote.defaultChoice,
		}
		voteUpdate$.next([opCtx, { state: voteState, source: { type: 'system', event: 'app-startup' } }])
	}

	// -------- Interpret current/next layer updates from the game server for the purposes of syncing it with the queue  --------

	type LayerStatus = { currentLayer: M.PossibleUnknownMiniLayer; nextLayer: M.PossibleUnknownMiniLayer | null }
	type LayerStatusWithPrev = [LayerStatus | null, LayerStatus | null]
	const processLayerStatusRunner = new AsyncExclusiveTaskRunner()
	SquadServer.rcon.serverStatus
		.observe(systemCtx)
		.pipe(
			map((status): LayerStatus => ({ currentLayer: status.currentLayer, nextLayer: status.nextLayer })),
			distinctDeepEquals(),
			scan((withPrev, status): LayerStatusWithPrev => [status, withPrev[0]], [null, null] as LayerStatusWithPrev)
		)
		.subscribe(async ([status, prevStatus]) => {
			if (!status) return

			processLayerStatusRunner.queue[0] = {
				params: [systemCtx, status, prevStatus] as const,
				task: processLayerStatusChange,
			}
			await processLayerStatusRunner.runExclusiveUntilEmpty()
		})

	async function processLayerStatusChange(ctx: C.Log & C.Db, status: LayerStatus, prevStatus: LayerStatus | null) {
		await using opCtx = C.pushOperation(systemCtx, 'layer-queue:process-layer-status-change', {
			startMsgBindings: { status, prevStatus },
		})
		if (prevStatus != null && !deepEqual(status.currentLayer, prevStatus.currentLayer)) {
			if (deepEqual(prevStatus.nextLayer, status.currentLayer)) {
				await handleServerRoll(opCtx)
			} else {
				// AdminChangeLayer was likely run, and queue should remain as-is. set next layer to the next in queue
				await handleAdminChangeLayer(opCtx)
			}
			return
		}
		const serverState = await getServerState({}, opCtx)
		const action = checkForNextLayerChangeActions(status, serverState)
		opCtx.log.debug('checking for overridden next layer: %s', action.code)
		switch (action.code) {
			case 'no-layer-set:no-action':
			case 'unknown-layer-set:no-action':
				break
			case 'layer-set-during-roll:reset':
			case 'null-layer-set:reset': {
				await SquadServer.rcon.setNextLayer(opCtx, M.getMiniLayerFromId(M.getNextLayerId(serverState.layerQueue)!))
				break
			}
			case 'layer-set:override': {
				await pushOverriddenNextLayerToQueue(opCtx)
				break
			}
			default:
				assertNever(action)
		}
	}

	async function handleServerRoll(ctx: C.Log & C.Db) {
		await using opCtx = C.pushOperation(ctx, 'layer-queue:handle-server-roll')
		const serverState = await opCtx.db().transaction(async (tx) => {
			const ctx = { ...opCtx, db: () => tx }
			const serverState = await getServerState({ lock: true }, ctx)
			const layerQueue = serverState.layerQueue
			if (layerQueue.length === 0) {
				ctx.log.warn('No layers in queue to roll to')
				return
			}
			layerQueue.shift()
			await tx
				.update(Schema.servers)
				.set(superjsonify(Schema.servers, { layerQueue, lastRoll: new Date() }))
				.where(E.eq(Schema.servers.id, CONFIG.serverId))
			return serverState
		})
		if (!serverState) return

		serverStateUpdate$.next([{ state: serverState, source: { type: 'system', event: 'server-roll' } }, opCtx])
		if (serverState.layerQueue.length > 0) {
			await SquadServer.rcon.setNextLayer(ctx, M.getMiniLayerFromId(M.getNextLayerId(serverState.layerQueue)!))
		}
	}

	async function handleAdminChangeLayer(ctx: C.Log & C.Db) {
		await using opCtx = C.pushOperation(ctx, 'layer-queue:handle-admin-change-layer')
		// the new current layer was set to something unexpected, so we just handle updating the next layer
		const time = new Date()
		opCtx.tasks.push(
			(async () => {
				const serverState = await getServerState({}, opCtx)
				const nextLayer = M.getNextLayerId(serverState.layerQueue)
				if (!nextLayer) return
				await SquadServer.rcon.setNextLayer(opCtx, M.getMiniLayerFromId(nextLayer))
			})()
		)
		opCtx.tasks.push(
			(async () =>
				await opCtx
					.db()
					.update(Schema.servers)
					.set(superjsonify(Schema.servers, { lastRoll: time }))
					.where(E.eq(Schema.servers.id, CONFIG.serverId)))()
		)
	}

	async function pushOverriddenNextLayerToQueue(ctx: C.Log & C.Db) {
		await using opCtx = C.pushOperation(ctx, 'layer-queue:push-overridden-next-layer')
		// bring layer queue up-to-date by shifting the overridden next layer to the front
		const newState = await opCtx.db().transaction(async (tx) => {
			const ctx = { ...opCtx, db: () => tx }
			const serverState = await getServerState({ lock: true }, ctx)
			const { value: status } = await SquadServer.rcon.serverStatus.get(ctx, { ttl: 50 })
			const action = checkForNextLayerChangeActions(status, serverState)
			// double check we're in the correct state after async
			if (action.code !== 'layer-set:override' || !action.overrideLayerId) return null
			const layerQueue = serverState.layerQueue
			// if the last layer was also set by the gameserver, then we're replacing it
			if (layerQueue[0]?.source === 'gameserver') layerQueue.shift()
			layerQueue.unshift({
				layerId: action.overrideLayerId,
				source: 'gameserver',
			})
			await ctx
				.db()
				.update(Schema.servers)
				.set(superjsonify(Schema.servers, { layerQueue }))
				.where(E.eq(Schema.servers.id, CONFIG.serverId))
			return serverState
		})
		if (!newState) return
		serverStateUpdate$.next([{ state: newState, source: { type: 'system', event: 'next-layer-override' } }, opCtx])
	}

	/**
	 * Determines how to respond to the next layer potentially having been set on the gameserver, bringing it out of sync with the queue
	 */
	function checkForNextLayerChangeActions(status: LayerStatus, serverState: M.LQServerState) {
		if (status.nextLayer === null) return { code: 'null-layer-set:reset' as const }
		if (!status.nextLayer || status.nextLayer.code === 'unknown') return { code: 'unknown-layer-set:no-action' as const }

		const layerQueue = serverState.layerQueue
		const nextLayer = status.nextLayer.layer
		const serverNextLayerId = M.getNextLayerId(layerQueue)
		if (serverNextLayerId === nextLayer.id) return { code: 'no-layer-set:no-action' as const }

		// don't respect the override if the map has rolled recently, as the gameserver probably set it to something random
		if (serverState.lastRoll !== null) {
			const lastRollTs = +serverState.lastRoll
			if ((Date.now() - lastRollTs) / 1000 < 60) return { code: 'layer-set-during-roll:reset' as const }
		}
		return { code: 'layer-set:override' as const, overrideLayerId: serverNextLayerId }
	}

	// -------- invalidate history filters cache on roll --------
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

	setupVoting()
}

// -------- voting --------
//
let voteState: M.VoteState | null = null
const voteUpdate$ = new Subject<[C.Log & C.Db, M.VoteStateUpdate]>()
function setupVoting() {
	let previousFirstLayer: M.LayerListItem | null = null
	// -------- initialize/teardown vote state based on the upcoming layer --------
	serverStateUpdate$.pipe().subscribe(([update, ctx]) => {
		if (deepEqual(previousFirstLayer, update.state.layerQueue[0])) return
		const first = update.state.layerQueue[0]
		previousFirstLayer = first
		if (first.vote) {
			// this means that we've chosen a winner and we can safely ignore this update
			if (first.layerId) return
			voteState = {
				code: 'ready',
				choices: first.vote.choices,
				defaultChoice: first.vote.defaultChoice,
			}
			voteUpdate$.next([ctx, { state: voteState, source: { type: 'system', event: 'queue-change' } }])
		} else {
			voteState = null
			voteUpdate$.next([ctx, { state: null, source: { type: 'system', event: 'queue-change' } }])
		}
	})
}

async function* watchVoteStateUpdates({ ctx }: { ctx: C.Log & C.Db }) {
	let initialState: (M.VoteState & Parts<M.UserPart>) | null = null
	if (voteState) {
		const ids = getVoteStateDiscordIds(voteState)
		const users = await ctx.db().select().from(Schema.users).where(E.inArray(Schema.users.discordId, ids))
		initialState = { ...voteState, parts: { users } }
	}
	yield { code: 'initial-state' as const, state: initialState } satisfies M.VoteStateUpdateOrInitialWithParts
	for await (const [ctx, update] of toAsyncGenerator(voteUpdate$)) {
		const withParts = await includeVoteStateUpdatePart(ctx, update)
		yield { code: 'update' as const, update: withParts } satisfies M.VoteStateUpdateOrInitialWithParts
	}
}

export async function startVote(
	_ctx: C.Log & C.Db & Partial<C.User>,
	opts: { durationSeconds?: number; minValidVotePercentage?: number; initiator: M.GuiOrChatUserId }
) {
	await using ctx = C.pushOperation(_ctx, 'layer-queue:vote:start', { startMsgBindings: opts })
	const { value: status } = await SquadServer.rcon.serverStatus.get(ctx)
	const durationSeconds = opts.durationSeconds ?? CONFIG.defaults.voteDurationSeconds
	const minValidVotePercentage = opts.minValidVotePercentage ?? CONFIG.defaults.minValidVotePercentage
	const minValidVotes = Math.ceil((minValidVotePercentage / 100) * status.playerCount)
	if (!voteState) {
		return {
			code: 'err:no-vote-exists' as const,
			msg: WARNS.vote.start.noVoteConfigured,
		}
	}

	if (voteState.code === 'in-progress') {
		return {
			code: 'err:vote-in-progress' as const,
			msg: WARNS.vote.start.voteAlreadyInProgress,
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
	await SquadServer.rcon.broadcast(ctx, BROADCASTS.vote.started(updatedVoteState.choices))

	return { code: 'ok' as const }
}

export async function handleVote(msg: SM.ChatMessage, ctx: C.Log & C.Db) {
	await using opCtx = C.pushOperation(ctx, 'layer-queue:vote:handle-vote')
	const choiceIdx = parseInt(msg.message.trim())
	if (!voteState) {
		return SquadServer.rcon.warn(opCtx, msg.playerId, WARNS.vote.noVoteInProgress)
	}
	if (choiceIdx <= 0 || choiceIdx > voteState.choices.length) {
		await SquadServer.rcon.warn(opCtx, msg.playerId, WARNS.vote.invalidChoice)
		return
	}
	if (voteState.code !== 'in-progress') {
		await SquadServer.rcon.warn(opCtx, msg.playerId, WARNS.vote.noVoteInProgress)
		return
	}

	const updatedVoteState = deepClone(voteState)
	const choice = updatedVoteState.choices[choiceIdx - 1]
	updatedVoteState.votes[msg.playerId] = choice
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
	await SquadServer.rcon.warn(opCtx, msg.playerId, WARNS.vote.voteCast(choice))
}

export async function abortVote(ctx: C.Log & C.Db, opts: { aborter: M.GuiOrChatUserId }) {
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
	voteEndTask?.unsubscribe()
	voteEndTask = null
	await SquadServer.rcon.broadcast(opCtx, BROADCASTS.vote.aborted(voteState.defaultChoice))
	return { code: 'ok' as const }
}

function registerVoteDeadline$(ctx: C.Log & C.Db, deadline: number) {
	voteEndTask?.unsubscribe()
	voteEndTask = of(0)
		.pipe(mergeMap(() => sleep(Math.max(deadline - Date.now(), 0))))
		.subscribe({
			next: async () => {
				await handleVoteTimeout(ctx)
			},
			complete: () => {
				voteEndTask = null
			},
		})
}

async function handleVoteTimeout(ctx: C.Log & C.Db) {
	await using opCtx = C.pushOperation(ctx, 'layer-queue:vote:handle-timeout')
	const res = await opCtx.db().transaction(async (tx) => {
		const ctx = { ...opCtx, db: () => tx }
		const serverState = deepClone(await getServerState({ lock: true }, ctx))
		if (!voteState || voteState.code !== 'in-progress') {
			return {
				code: 'err:no-vote-in-progress' as const,
				currentVote: voteState,
			}
		}
		let newVoteState: M.VoteState
		let voteUpdate: M.VoteStateUpdate
		let tally: M.Tally | null = null
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
			const { value: status } = await SquadServer.rcon.serverStatus.get(ctx, { ttl: 10_000 })
			tally = M.tallyVotes(voteState, status.playerCount)

			const winner = tally.leaders[Math.floor(Math.random() * tally.leaders.length)]
			serverState.layerQueue[0].layerId = winner
			newVoteState = {
				choices: voteState.choices,
				defaultChoice: voteState.defaultChoice,
				deadline: voteState.deadline,
				votes: voteState.votes,

				code: 'ended:winner',
				winner,
			}
			voteUpdate = {
				source: { type: 'system', event: 'vote-timeout' },
				state: newVoteState,
			}
		}
		await ctx.db().update(Schema.servers).set(superjsonify(Schema.servers, serverState)).where(E.eq(Schema.servers.id, CONFIG.serverId))
		return { code: 'ok' as const, serverState, voteUpdate, tally }
	})
	if (res.code !== 'ok') return res
	const update: M.LQServerStateUpdate = {
		state: res.serverState,
		source: { type: 'system', event: 'vote-timeout' },
	}
	serverStateUpdate$.next([update, ctx])
	voteState = res.voteUpdate.state
	voteUpdate$.next([ctx, res.voteUpdate])
	if (res.voteUpdate.state!.code === 'ended:winner') {
		await SquadServer.rcon.setNextLayer(opCtx, M.getMiniLayerFromId(res.voteUpdate.state!.winner))
		await SquadServer.rcon.broadcast(ctx, BROADCASTS.vote.winnerSelected(res.tally!, res.voteUpdate.state!.winner))
	}
	if (res.voteUpdate!.state!.code === 'ended:insufficient-votes') {
		await SquadServer.rcon.broadcast(ctx, BROADCASTS.vote.insufficientVotes(res.voteUpdate.state!.defaultChoice))
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
async function* watchLayerQueueStateUpdates(args: { ctx: C.Log & C.Db }) {
	for await (const [update] of toAsyncGenerator(serverStateUpdate$)) {
		if (update.parts) {
			yield update
		} else {
			const withParts = await includeServerUpdateParts(args.ctx, update)
			yield withParts
		}
	}
}

async function updateQueue({ input, ctx }: { input: M.UserModifiableServerState; ctx: C.Log & C.Db & C.User }) {
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

	const res: M.LayerListItem[] = []
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
	watchLayerQueueState: procedure.subscription(watchLayerQueueStateUpdates),
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
