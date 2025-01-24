import * as E from 'drizzle-orm/expressions'
import deepEqual from 'fast-deep-equal'
import { BehaviorSubject, distinctUntilChanged, from, map, scan, Subject, Subscription } from 'rxjs'
import * as FB from '@/lib/filter-builders.ts'

import { acquireInBlock, AsyncExclusiveTaskRunner, distinctDeepEquals, sleep, toAsyncGenerator } from '@/lib/async.ts'
import { deepClone } from '@/lib/object'
import * as SM from '@/lib/rcon/squad-models'
import * as M from '@/models.ts'
import { CONFIG } from '@/server/config.ts'
import * as RBAC from '@/rbac.models.ts'
import * as Rbac from '@/server/systems/rbac.system.ts'
import * as C from '@/server/context'
import * as DB from '@/server/db.ts'
import { baseLogger } from '@/server/logger.ts'
import * as Schema from '@/server/schema.ts'
import * as SquadServer from '@/server/systems/squad-server'
import * as LayersQuery from '@/server/systems/layer-queries.ts'
import * as WSSessionSys from '@/server/systems/ws-session.ts'

import { procedure, router } from '../trpc.server.ts'
import { superjsonify, unsuperjsonify } from '@/lib/drizzle'
import { assertNever } from '@/lib/typeGuards'
import { Parts } from '@/lib/types'
import { BROADCASTS, WARNS } from '@/messages.ts'
import { interval } from 'rxjs'
import { Mutex } from 'async-mutex'

export let serverStateUpdate$!: BehaviorSubject<[M.LQServerStateUpdate & Partial<Parts<M.UserPart & M.LayerStatusPart>>, C.Log & C.Db]>

let voteEndTask: Subscription | null = null
let voteState: M.VoteState | null = null
const voteStateUpdate$ = new Subject<[C.Log & C.Db, M.VoteStateUpdate]>()

const userPresence: M.UserPresenceState = {}
const userPresenceUpdate$ = new Subject<M.UserPresenceStateUpdate & Parts<M.UserPart>>()

const voteStateMtx = new Mutex()

export async function setupLayerQueueAndServerState() {
	const log = baseLogger
	const systemCtx = DB.addPooledDb({ log })

	await using opCtx = C.pushOperation(systemCtx, 'layer-queue:setup', {
		level: 'info',
	})

	// -------- bring server up to date with configuration --------
	await DB.runTransaction(opCtx, async (ctx) => {
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

		const initialServerState = M.ServerStateSchema.parse(server)
		const initialStateUpdate: M.LQServerStateUpdate = { state: initialServerState, source: { type: 'system', event: 'app-startup' } }
		const withParts = await includeLQServerUpdateParts(opCtx, initialStateUpdate)
		// idk why this cast on ctx is necessary
		serverStateUpdate$ = new BehaviorSubject([withParts, ctx as C.Log & C.Db] as const)

		// -------- initialize vote state --------
		const update = getVoteStateUpdatesFromQueueUpdate([], initialServerState.layerQueue, voteState)
		if (update.code === 'ok') {
			voteState = update.update.state
			voteStateUpdate$.next([ctx, update.update])
		}

		{
			// -------- set next layer on server --------
			const nextLayer = M.getNextLayerId(initialStateUpdate.state.layerQueue)
			if (nextLayer) await SquadServer.rcon.setNextLayer(opCtx, M.getMiniLayerFromId(nextLayer))
		}
	})

	serverStateUpdate$.subscribe(([state, ctx]) => {
		ctx.log.debug({ seqId: state.state.layerQueueSeqId }, 'pushing server state update')
	})

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

	async function processLayerStatusChange(baseCtx: C.Log & C.Db, status: LayerStatus, prevStatus: LayerStatus | null) {
		await using ctx = C.pushOperation(baseCtx, 'layer-queue:process-layer-status-change', {
			startMsgBindings: { status, prevStatus },
		})
		if (prevStatus != null && !deepEqual(status.currentLayer, prevStatus.currentLayer)) {
			await DB.runTransaction(ctx, async (ctx) => {
				const serverState = await getServerState({ lock: true }, ctx)
				if (status.currentLayer.code === 'known' && M.getNextLayerId(serverState.layerQueue) === status.currentLayer.layer.id) {
					// new current layer was expected, so we just need to roll
					await handleServerRoll(ctx, serverState)
				} else {
					await handleAdminChangeLayer(ctx, serverState)
				}
			})
			return
		}
		const serverState = await getServerState({}, ctx)
		const action = checkForNextLayerChangeActions(status, serverState)
		ctx.log.debug('checking for overridden next layer: %s', action.code)
		switch (action.code) {
			case 'no-layer-set:no-action':
			case 'unknown-layer-set:no-action':
				break
			case 'layer-set-during-roll:reset':
			case 'layer-set-during-vote:reset':
			case 'layer-set:reset':
			case 'null-layer-set:reset': {
				const nextLayerId = M.getNextLayerId(serverState.layerQueue)
				if (!nextLayerId) {
					ctx.log.warn("Layer was set at an unexpected time, but no next layer is in the queue. I don't think this can happen")
					return
				}
				await SquadServer.rcon.setNextLayer(ctx, M.getMiniLayerFromId(nextLayerId))
				break
			}
			default:
				assertNever(action)
		}
	}

	async function handleServerRoll(baseCtx: C.Log & C.Db & C.Tx, prevServerState: M.LQServerState) {
		await using ctx = C.pushOperation(baseCtx, 'layer-queue:handle-server-roll')
		// eslint-disable-next-line @typescript-eslint/no-unused-vars
		using acquired = await acquireInBlock(voteStateMtx)
		const serverState = deepClone(prevServerState)
		const layerQueue = serverState.layerQueue
		if (prevServerState.layerQueue.length === 0) {
			ctx.log.warn('No layers in queue to roll to')
			return
		}
		layerQueue.shift()
		const updateRes = getVoteStateUpdatesFromQueueUpdate(prevServerState.layerQueue, layerQueue, voteState, true)
		switch (updateRes.code) {
			case 'noop':
			case 'err:queue-change-during-vote':
				break
			case 'ok':
				voteState = updateRes.update.state
				voteStateUpdate$.next([ctx, updateRes.update])
				break
			default:
				assertNever(updateRes)
		}
		serverState.lastRoll = new Date()
		await ctx.db().update(Schema.servers).set(superjsonify(Schema.servers, serverState)).where(E.eq(Schema.servers.id, CONFIG.serverId))
		const nextLayer = M.getNextLayerId(layerQueue)
		if (nextLayer) {
			await SquadServer.rcon.setNextLayer(ctx, M.getMiniLayerFromId(nextLayer))
		}
		serverStateUpdate$.next([{ state: serverState, source: { type: 'system', event: 'server-roll' } }, ctx])
	}

	async function handleAdminChangeLayer(baseCtx: C.Log & C.Db & C.Tx, serverState: M.LQServerState) {
		await using ctx = C.pushOperation(baseCtx, 'layer-queue:handle-admin-change-layer')
		// the new current layer was set to something unexpected, so we just handle updating the next layer
		const time = new Date()
		ctx.tasks.push(
			(async () => {
				const nextLayer = M.getNextLayerId(serverState.layerQueue)
				if (!nextLayer) return
				await SquadServer.rcon.setNextLayer(ctx, M.getMiniLayerFromId(nextLayer))
			})()
		)
		serverState.lastRoll = time
		ctx.tasks.push(
			(async () =>
				await ctx
					.db()
					.update(Schema.servers)
					.set(superjsonify(Schema.servers, { lastRoll: time }))
					.where(E.eq(Schema.servers.id, CONFIG.serverId)))()
		)

		serverStateUpdate$.next([{ state: serverState, source: { type: 'system', event: 'admin-change-layer' } }, ctx])
	}

	/**
	 * Determines how to respond to the next layer potentially having been set on the gameserver, bringing it out of sync with the queue
	 * This function isn't super necessarry atm as we don't allow AdminSetNextLayer overrides in any case anymore, but leaving here in case we want to change this later.
	 */
	function checkForNextLayerChangeActions(status: LayerStatus, serverState: M.LQServerState, voteState: M.VoteState | null = null) {
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
		if (voteState?.code === 'in-progress') return { code: 'layer-set-during-vote:reset' as const }
		return { code: 'layer-set:reset' as const, overrideLayerId: serverNextLayerId }
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

	// -------- take editing user out of editing slot on disconnect --------
	WSSessionSys.disconnect$.subscribe(async (ctx) => {
		if (userPresence.editState && userPresence.editState.wsClientId === ctx.wsClientId) {
			delete userPresence.editState
			userPresenceUpdate$.next({ event: 'edit-end', state: userPresence, parts: { users: [] } })
		}
	})
}

// -------- voting --------
//
function getVoteStateUpdatesFromQueueUpdate(lastQueue: M.LayerQueue, newQueue: M.LayerQueue, voteState: M.VoteState | null, force = false) {
	const lastQueueItem = lastQueue[0] as M.LayerListItem | undefined
	const newQueueItem = newQueue[0]

	if (!lastQueueItem?.vote && !newQueueItem?.vote) return { code: 'noop' as const }

	if (!deepEqual(lastQueueItem, newQueueItem) && voteState?.code === 'in-progress' && !force) {
		return { code: 'err:queue-change-during-vote' as const }
	}

	if (lastQueueItem?.vote && !newQueueItem.vote) {
		return { code: 'ok' as const, update: { state: null, source: { type: 'system', event: 'queue-change' } } satisfies M.VoteStateUpdate }
	}

	if (newQueueItem.vote && !deepEqual(lastQueueItem?.vote, newQueueItem.vote)) {
		return {
			code: 'ok' as const,
			update: {
				state: {
					code: 'ready',
					choices: newQueueItem.vote.choices,
					defaultChoice: newQueueItem.vote.defaultChoice,
				},
				source: { type: 'system', event: 'queue-change' },
			} satisfies M.VoteStateUpdate,
		}
	}

	return { code: 'noop' as const }
}

async function* watchVoteStateUpdates({ ctx }: { ctx: C.Log & C.Db }) {
	let initialState: (M.VoteState & Parts<M.UserPart>) | null = null
	if (voteState) {
		const ids = getVoteStateDiscordIds(voteState)
		const users = await ctx.db().select().from(Schema.users).where(E.inArray(Schema.users.discordId, ids))
		initialState = { ...voteState, parts: { users } }
	}
	yield { code: 'initial-state' as const, state: initialState } satisfies M.VoteStateUpdateOrInitialWithParts
	for await (const [ctx, update] of toAsyncGenerator(voteStateUpdate$)) {
		const withParts = await includeVoteStateUpdatePart(ctx, update)
		yield { code: 'update' as const, update: withParts } satisfies M.VoteStateUpdateOrInitialWithParts
	}
}

export async function startVote(
	_ctx: C.Log & C.Db & Partial<C.User>,
	opts: { durationSeconds?: number; minValidVotePercentage?: number; initiator: M.GuiOrChatUserId }
) {
	await using ctx = C.pushOperation(_ctx, 'layer-queue:vote:start', { startMsgBindings: opts })

	if (ctx.user) {
		const denyRes = await Rbac.tryDenyPermissionsForUser(ctx, ctx.user.discordId, { check: 'all', permits: [RBAC.perm('vote:manage')] })
		if (denyRes) return denyRes
	}

	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	using acquired = await acquireInBlock(voteStateMtx)
	const { value: status } = await SquadServer.rcon.serverStatus.get(ctx, { ttl: 10_000 })

	const res = await DB.runTransaction(ctx, async (ctx) => {
		const durationSeconds = opts.durationSeconds ?? CONFIG.defaults.voteDurationSeconds
		const minValidVotePercentage = opts.minValidVotePercentage ?? CONFIG.defaults.minValidVotePercentage
		const minValidVotes = Math.ceil((minValidVotePercentage / 100) * Math.max(status.playerCount, 1))
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

		{
			const serverState = await getServerState({ lock: true }, ctx)
			if (serverState.layerQueue[0].layerId) {
				delete serverState.layerQueue[0].layerId
				await ctx
					.db()
					.update(Schema.servers)
					.set(superjsonify(Schema.servers, { layerQueue: serverState.layerQueue }))
					.where(E.eq(Schema.servers.id, CONFIG.serverId))
			}
			serverStateUpdate$.next([{ state: serverState, source: { type: 'system', event: 'vote-start' } }, ctx])
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

		ctx.log.info('registering vote deadline')
		const update = {
			state: updatedVoteState,
			source: {
				type: 'manual',
				event: 'start-vote',
				user: opts.initiator,
			},
		} satisfies M.VoteStateUpdate

		return { code: 'ok' as const, voteStateUpdate: update }
	})
	if (res.code !== 'ok') return res

	voteState = res.voteStateUpdate.state
	voteStateUpdate$.next([ctx, res.voteStateUpdate])
	registerVoteDeadlineAndReminder$(ctx)
	await SquadServer.rcon.broadcast(
		ctx,
		BROADCASTS.vote.started(
			res.voteStateUpdate.state.choices,
			res.voteStateUpdate.state.defaultChoice,
			res.voteStateUpdate.state.deadline - Date.now()
		)
	)

	return res
}

export async function handleVote(msg: SM.ChatMessage, ctx: C.Log & C.Db) {
	await using opCtx = C.pushOperation(ctx, 'layer-queue:vote:handle-vote')
	// no need to acquire vote mutex here, this is a safe operation
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

	const choice = voteState.choices[choiceIdx - 1]
	voteState.votes[msg.playerId] = choice
	const update: M.VoteStateUpdate = {
		state: voteState,
		source: {
			type: 'manual',
			event: 'vote',
			user: { steamId: msg.playerId },
		},
	}

	voteStateUpdate$.next([opCtx, update])
	await SquadServer.rcon.warn(opCtx, msg.playerId, WARNS.vote.voteCast(choice))
}

export async function abortVote(ctx: C.Log & C.Db, opts: { aborter: M.GuiOrChatUserId }) {
	await using opCtx = C.pushOperation(ctx, 'layer-queue:vote:abort')

	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	using acquired = await acquireInBlock(voteStateMtx)

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
	voteStateUpdate$.next([ctx, update])
	voteEndTask?.unsubscribe()
	voteEndTask = null
	await SquadServer.rcon.broadcast(opCtx, BROADCASTS.vote.aborted(voteState.defaultChoice))
	return { code: 'ok' as const }
}

function registerVoteDeadlineAndReminder$(ctx: C.Log & C.Db) {
	voteEndTask?.unsubscribe()
	voteEndTask = new Subscription()

	if (!voteState || voteState.code !== 'in-progress') return

	const waitTime = Math.max(0, voteState.deadline - CONFIG.remindVoteThresholdSeconds * 1000 - Date.now())
	if (waitTime > 0) {
		voteEndTask.add(
			from(sleep(waitTime)).subscribe(async () => {
				if (!voteState || voteState.code !== 'in-progress') return
				const timeLeft = voteState.deadline - Date.now()
				await SquadServer.rcon.broadcast(ctx, BROADCASTS.vote.voteReminder(timeLeft, voteState.choices))
			})
		)
	}

	// add timeout handling
	voteEndTask.add(
		from(sleep(Math.max(voteState.deadline - Date.now(), 0))).subscribe({
			next: async () => {
				await handleVoteTimeout(ctx)
			},
			complete: () => {
				ctx.log.info('vote deadline reached')
				voteEndTask = null
			},
		})
	)
}

async function handleVoteTimeout(ctx: C.Log & C.Db) {
	await using opCtx = C.pushOperation(ctx, 'layer-queue:vote:handle-timeout')

	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	using acquired = await acquireInBlock(voteStateMtx)
	const res = await DB.runTransaction(opCtx, async (ctx) => {
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
	voteStateUpdate$.next([ctx, res.voteUpdate])
	if (res.voteUpdate.state!.code === 'ended:winner') {
		await SquadServer.rcon.setNextLayer(ctx, M.getMiniLayerFromId(res.voteUpdate.state!.winner))
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

// -------- user presence --------
export async function startEditing({ ctx }: { ctx: C.TrpcRequest }) {
	const denyRes = await Rbac.tryDenyPermissionsForUser(ctx, ctx.user.discordId, {
		check: 'any',
		permits: [RBAC.perm('queue:write'), RBAC.perm('settings:write')],
	})
	if (denyRes) return denyRes
	if (userPresence.editState) {
		return { code: 'err:already-editing' as const, userPresence }
	}
	userPresence.editState = {
		startTime: Date.now(),
		userId: ctx.user.discordId,
		wsClientId: ctx.wsClientId,
	}
	const update: M.UserPresenceStateUpdate & Parts<M.UserPart> = {
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
	const update: M.UserPresenceStateUpdate & Parts<M.UserPart> = {
		event: 'edit-end',
		state: userPresence,
		parts: {
			users: [ctx.user],
		},
	}
	userPresenceUpdate$.next(update)
	return { code: 'ok' as const }
}

export async function* watchUserPresence({ ctx }: { ctx: C.Log & C.Db }) {
	const users: M.User[] = []
	if (userPresence.editState) {
		const [user] = await ctx.db().select().from(Schema.users).where(E.eq(Schema.users.discordId, userPresence.editState.userId))
		users.push(user)
	}
	yield { code: 'initial-state' as const, state: userPresence, parts: { users } } satisfies any & Parts<M.UserPart>
	for await (const update of toAsyncGenerator(userPresenceUpdate$)) {
		yield { code: 'update' as const, update }
	}
}

// -------- generic actions & data  --------
async function* watchLayerQueueStateUpdates(args: { ctx: C.Log & C.Db }) {
	for await (const [update] of toAsyncGenerator(serverStateUpdate$)) {
		if (update.parts) {
			yield update
		} else {
			const withParts = await includeLQServerUpdateParts(args.ctx, update)
			yield withParts
		}
	}
}

async function updateQueue({ input, ctx: baseCtx }: { input: M.UserModifiableServerState; ctx: C.TrpcRequest }) {
	await using ctx = C.pushOperation(baseCtx, 'layer-queue:update')
	input = deepClone(input)
	const res = await DB.runTransaction(ctx, async (ctx) => {
		const serverStatePrev = await getServerState({ lock: true }, ctx)
		const serverState = deepClone(serverStatePrev)
		if (input.layerQueueSeqId !== serverState.layerQueueSeqId) {
			return {
				code: 'err:out-of-sync' as const,
				message: 'Update is out of sync',
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

		// in case we've voted for a layer that has been shuffled to the back
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

		await ctx.db().update(Schema.servers).set(superjsonify(Schema.servers, serverState)).where(E.eq(Schema.servers.id, CONFIG.serverId))
		endEditing({ ctx })

		return { code: 'ok' as const, serverState }
	})
	if (res.code !== 'ok') return res

	const nextLayerId = M.getNextLayerId(res.serverState.layerQueue)
	if (nextLayerId) {
		await SquadServer.rcon.setNextLayer(ctx, M.getMiniLayerFromId(nextLayerId))
	}

	const update: M.LQServerStateUpdate = {
		state: res.serverState,
		source: { type: 'manual', user: { discordId: ctx.user.discordId }, event: 'edit' },
	}
	const withParts = await includeLQServerUpdateParts(ctx, update)
	serverStateUpdate$.next([withParts, ctx])
	return { code: 'ok' as const, serverStateUpdate: withParts }
}

// -------- utility --------
export async function getServerState({ lock }: { lock?: boolean }, ctx: C.Db & C.Log) {
	lock ??= false
	const query = ctx.db().select().from(Schema.servers).where(E.eq(Schema.servers.id, CONFIG.serverId))
	let serverRaw: any
	if (lock) [serverRaw] = await query.for('update')
	else [serverRaw] = await query
	return M.ServerStateSchema.parse(unsuperjsonify(Schema.servers, serverRaw))
}

export async function peekNext(ctx: C.Db & C.Log) {
	const serverState = await getServerState({}, ctx)
	return serverState.layerQueue[0] ?? null
}

async function includeLQServerUpdateParts(
	ctx: C.Db & C.Log,
	_serverStateUpdate: M.LQServerStateUpdate
): Promise<M.LQServerStateUpdate & Partial<Parts<M.UserPart & M.LayerStatusPart>>> {
	const userPartPromise = includeUserPartForLQServerUpdate(ctx, _serverStateUpdate)
	const layerStatusPartPromise = includeLayerStatusPart(ctx, _serverStateUpdate)
	return {
		..._serverStateUpdate,
		parts: {
			...(await userPartPromise),
			...(await layerStatusPartPromise),
		},
	}
}

async function includeUserPartForLQServerUpdate(ctx: C.Db & C.Log, update: M.LQServerStateUpdate) {
	const part: M.UserPart = { users: [] as M.User[] }
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
		part.users.push(user)
	}
	return part
}

async function includeLayerStatusPart(ctx: C.Db & C.Log, update: M.LQServerStateUpdate) {
	const part: M.LayerStatusPart = { layerInPoolState: new Map() }

	if (!update.state.settings.queue.poolFilterId) return part

	const layerIds: Set<string> = new Set()
	for (const item of update.state.layerQueue) {
		if (item.layerId) layerIds.add(item.layerId)
		if (item.vote) item.vote.choices.forEach((c) => layerIds.add(c))
	}

	const inPoolRes = await LayersQuery.areLayersInPool({
		ctx,
		input: { layers: Array.from(layerIds), poolFilterId: update.state.settings.queue.poolFilterId },
	})

	switch (inPoolRes.code) {
		case 'err:not-found':
		case 'err:pool-filter-not-set':
			return part
		case 'ok':
			break
		default:
			assertNever(inPoolRes)
	}

	for (const result of inPoolRes.results) {
		part.layerInPoolState.set(M.getLayerStatusId(result.id, update.state.settings.queue.poolFilterId!), {
			inPool: result.matchesFilter,
		})
	}

	return part
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
	const layers = await LayersQuery.queryLayers({
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
		const denyRes = await Rbac.tryDenyPermissionsForUser(ctx, ctx.user.discordId, { check: 'all', permits: [RBAC.perm('vote:manage')] })
		if (denyRes) return denyRes
		return await abortVote(ctx, { aborter: { discordId: ctx.user.discordId } })
	}),

	startEditing: procedure.mutation(startEditing),
	endEditing: procedure.mutation(endEditing),
	watchUserPresence: procedure.subscription(watchUserPresence),

	updateQueue: procedure.input(M.GenericServerStateUpdateSchema).mutation(updateQueue),
})
