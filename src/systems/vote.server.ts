import * as Schema from '$root/drizzle/schema'
import { type CleanupTasks, toAsyncGenerator, withAbortSignal } from '@/lib/async'
import { addReleaseTask } from '@/lib/nodejs-reentrant-mutexes'
import * as Obj from '@/lib/object'
import { assertNever } from '@/lib/type-guards'
import type { Parts } from '@/lib/types'
import * as Messages from '@/messages.ts'
import * as CS from '@/models/context-shared'
import * as LL from '@/models/layer-list.models'

import * as SM from '@/models/squad.models'
import type * as USR from '@/models/users.models'
import * as V from '@/models/vote.models.ts'
import * as RBAC from '@/rbac.models'
import { CONFIG } from '@/server/config.ts'
import * as C from '@/server/context.ts'
import * as DB from '@/server/db'
import { initModule } from '@/server/logger'

import orpcBase from '@/server/orpc-base'
import * as LayerQueue from '@/systems/layer-queue.server'
import * as MatchHistory from '@/systems/match-history.server'
import * as Rbac from '@/systems/rbac.server'
import * as SquadRcon from '@/systems/squad-rcon.server'
import * as SquadServer from '@/systems/squad-server.server'
import * as Users from '@/systems/users.server'
import * as Otel from '@opentelemetry/api'
import { Mutex, type MutexInterface, withTimeout } from 'async-mutex'
import * as dateFns from 'date-fns'
import * as E from 'drizzle-orm/expressions'
import * as Rx from 'rxjs'

export type VoteContext = {
	voteEndTask: Rx.Subscription | null
	autostartVoteSub: Rx.Subscription | null
	mtx: MutexInterface
	state: V.VoteState | null
	update$: Rx.Subject<V.VoteStateUpdate>
}

const module = initModule('vote')
let log!: CS.Logger

export function setup() {
	log = module.getLogger()
}

export const router = {
	startVote: orpcBase
		.input(V.StartVoteInputSchema)
		.handler(async ({ input, context: _ctx }) => {
			const ctx = SquadServer.resolveWsClientSliceCtx(_ctx)
			return startVote(ctx, { ...input, initiator: { discordId: ctx.user.discordId } })
		}),

	abortVote: orpcBase.handler(async ({ context: _ctx }) => {
		const ctx = SquadServer.resolveWsClientSliceCtx(_ctx)
		const denyRes = await Rbac.tryDenyPermissionsForUser(ctx, RBAC.perm('vote:manage'))
		if (denyRes) return denyRes
		return await abortVote(ctx, { aborter: { discordId: ctx.user.discordId } })
	}),

	cancelVoteAutostart: orpcBase.handler(async ({ context: _ctx }) => {
		const ctx = SquadServer.resolveWsClientSliceCtx(_ctx)
		const denyRes = await Rbac.tryDenyPermissionsForUser(ctx, RBAC.perm('vote:manage'))
		if (denyRes) return denyRes
		return await cancelVoteAutostart(ctx, { user: { discordId: ctx.user.discordId } })
	}),

	watchUpdates: orpcBase.handler(async function*({ context, signal }) {
		const obs = SquadServer.selectedServerCtx$(context).pipe(
			Rx.switchMap(async function*(ctx) {
				let initialState: (V.VoteState & Parts<USR.UserPart>) | null = null
				const voteState = ctx.vote.state
				if (voteState) {
					const ids = getVoteStateDiscordIds(voteState)
					const users = await Users.buildUsers(
						await ctx.db().select().from(Schema.users).where(E.inArray(Schema.users.discordId, ids)),
					)
					initialState = { ...voteState, parts: { users } }
				}
				yield { code: 'initial-state' as const, state: initialState } satisfies V.VoteStateUpdateOrInitialWithParts
				for await (const update of toAsyncGenerator(ctx.vote.update$)) {
					const withParts = await includeVoteStateUpdatePart(getBaseCtx(), update)
					yield { code: 'update' as const, update: withParts } satisfies V.VoteStateUpdateOrInitialWithParts
				}
			}),
			withAbortSignal(signal!),
		)

		yield* toAsyncGenerator(obs)
	}),
}

export function initVoteContext(cleanup: CleanupTasks) {
	const vote: VoteContext = {
		autostartVoteSub: null,
		voteEndTask: null,
		state: null,
		mtx: withTimeout(new Mutex(), 1_000),

		update$: new Rx.Subject<V.VoteStateUpdate>(),
	}

	cleanup.push(
		vote.update$,
		vote.mtx,
		() => vote.autostartVoteSub,
		() => vote.voteEndTask,
	)

	return vote
}

export const syncVoteStateWithQueueStateInPlace = C.spanOp(
	'sync-vote-state-with-queue-state',
	{ module, mutexes: (ctx) => ctx.vote.mtx },
	async (
		ctx: C.SquadServer & C.Vote & C.MatchHistory,
		oldQueue: LL.List,
		newQueue: LL.List,
	) => {
		if (Obj.deepEqual(oldQueue, newQueue)) return
		const serverId = ctx.serverId
		let newVoteState: V.VoteState | undefined | null

		const oldQueueItem = oldQueue[0] as LL.Item | undefined
		const newQueueItem = newQueue[0]

		// check if we need to set 'ready'. we only want to do this if there's been a meaningul state change that means we have to initialize it or restart the autostart time. Also if we already have a .endingVoteState we don't want to overwrite that here
		const currentMatch = await MatchHistory.getCurrentMatch(ctx)

		const vote = ctx.vote

		if (vote.state?.code === 'in-progress') {
			if (newQueue.some(item => item.itemId === vote.state!.itemId)) return

			// setting to null rather than calling clearVote indicates that a new "ready" vote state might be set instead
			newVoteState = null
		} else if (
			newQueueItem && LL.isVoteItem(newQueueItem) && !newQueueItem.endingVoteState
			&& (!oldQueueItem || newQueueItem.itemId !== oldQueueItem.itemId || !LL.isVoteItem(oldQueueItem))
			&& currentMatch.status !== 'post-game'
		) {
			let autostartTime: Date | undefined
			if (currentMatch.startTime && CONFIG.vote.autoStartVoteDelay) {
				const startTime = dateFns.addMilliseconds(currentMatch.startTime, CONFIG.vote.autoStartVoteDelay)
				if (dateFns.isFuture(startTime)) autostartTime = startTime
				else autostartTime = dateFns.addMinutes(new Date(), 5)
			}
			newVoteState = {
				code: 'ready',
				choiceIds: newQueueItem.choices.map(choice => choice.itemId),
				itemId: newQueueItem.itemId,
				voterType: vote.state?.voterType ?? 'public',
				autostartTime,
			}
		} else if (!newQueueItem || !LL.isVoteItem(newQueueItem)) {
			newVoteState = null
		}

		if (newVoteState || newVoteState === null) {
			const update: V.VoteStateUpdate = {
				state: newVoteState,
				source: { type: 'system', event: 'queue-change' },
			}

			vote.voteEndTask?.unsubscribe()
			vote.voteEndTask = null
			vote.autostartVoteSub?.unsubscribe()
			vote.autostartVoteSub = null
			if (newVoteState?.code === 'ready' && newVoteState.autostartTime && CONFIG.vote.autoStartVoteDelay) {
				log.info('scheduling autostart vote to %s for %s', newVoteState.autostartTime.toISOString(), newVoteState.itemId)
				vote.autostartVoteSub = Rx.of(1).pipe(Rx.delay(dateFns.differenceInMilliseconds(newVoteState.autostartTime, Date.now()))).subscribe(
					() => {
						void startVote(SquadServer.resolveSliceCtx(getBaseCtx(), serverId), { initiator: 'autostart' })
					},
				)
			}
			vote.state = newVoteState
			addReleaseTask(() => vote.update$.next(update))
		}
	},
)

export const startVote = C.spanOp(
	'start',
	{ module, levels: { event: 'info' }, attrs: (_, opts) => opts, mutexes: (ctx) => ctx.vote.mtx },
	async (
		ctx: C.Db & Partial<C.User> & C.SquadServer & C.Vote & C.LayerQueue & C.MatchHistory & C.AdminList,
		opts: V.StartVoteInput & { initiator: USR.GuiOrChatUserId | 'autostart' },
	) => {
		if (ctx.user !== undefined) {
			// @ts-expect-error cringe
			const denyRes = await Rbac.tryDenyPermissionsForUser(ctx, RBAC.perm('vote:manage'))
			if (denyRes) {
				return denyRes
			}
		}

		const statusRes = await ctx.server.layersStatus.get(ctx, { ttl: 10_000 })
		if (statusRes.code !== 'ok') {
			return statusRes
		}
		const currentMatch = await MatchHistory.getCurrentMatch(ctx)
		if (currentMatch.status === 'post-game') {
			return { code: 'err:vote-not-allowed' as const, msg: Messages.WARNS.vote.start.noVoteInPostGame }
		}

		const duration = opts.duration ?? CONFIG.vote.voteDuration
		const res = await DB.runTransaction(ctx, async (ctx) => {
			const serverState = await SquadServer.getServerState(ctx)
			const newServerState = Obj.deepClone(serverState)
			const itemId = opts.itemId ?? newServerState.layerQueue[0]?.itemId
			if (!itemId) {
				return { code: 'err:item-not-found' as const, msg: Messages.WARNS.vote.start.itemNotFound }
			}

			const initiateVoteRes = V.canInitiateVote(
				itemId,
				newServerState.layerQueue,
				opts.voterType ?? 'public',
				ctx.vote.state ?? undefined,
			)

			const msgMap = {
				'err:item-not-found': Messages.WARNS.vote.start.itemNotFound,
				'err:invalid-item-type': Messages.WARNS.vote.start.invalidItemType,
				'err:editing-in-progress': Messages.WARNS.vote.start.editingInProgress,
				'err:public-vote-not-first': Messages.WARNS.vote.start.publicVoteNotFirst,
				'err:vote-in-progress': Messages.WARNS.vote.start.voteAlreadyInProgress,
				'ok': null,
			} satisfies Record<typeof initiateVoteRes['code'], string | null>

			if (initiateVoteRes.code !== 'ok') {
				return {
					code: initiateVoteRes.code,
					msg: msgMap[initiateVoteRes.code]!,
				}
			}

			const item = initiateVoteRes.item
			LL.setEndingVoteStateInPlace(item, null)
			await SquadServer.updateServerState(ctx, newServerState, { event: 'vote-start', type: 'system' })

			const updatedVoteState = {
				code: 'in-progress',
				deadline: Date.now() + duration,
				votes: [],
				initiator: opts.initiator,
				choiceIds: item.choices.map(choice => choice.itemId),
				itemId: item.itemId,
				voterType: opts.voterType ?? 'public',
			} satisfies V.VoteState

			log.info('registering vote deadline')
			const update = {
				state: updatedVoteState,
				source: opts.initiator === 'autostart'
					? { type: 'system', event: 'automatic-start-vote' }
					: {
						type: 'manual',
						event: 'start-vote',
						user: opts.initiator,
					},
			} satisfies V.VoteStateUpdate

			ctx.vote.autostartVoteSub?.unsubscribe()
			ctx.vote.autostartVoteSub = null

			ctx.vote.state = updatedVoteState
			addReleaseTask(() => ctx.vote.update$.next(update))
			registerVoteDeadlineAndReminder$(ctx)
			void broadcastVoteUpdate(
				ctx,
				Messages.BROADCASTS.vote.started(
					ctx.vote.state,
					item,
					duration,
					item.voteConfig?.displayProps ?? CONFIG.vote.voteDisplayProps,
				),
			)

			return { code: 'ok' as const, voteStateUpdate: update }
		})

		return res
	},
)

export const handleVote = C.spanOp('handle-vote', {
	module,
	attrs: (_, msg) => ({ messageId: msg.message, playerUsername: msg.playerIds.username }),
}, (ctx: C.Db & C.SquadServer & C.Vote & C.LayerQueue & C.AdminList, msg: SM.RconEvents.ChatMessage) => {
	//
	const choiceIdx = parseInt(msg.message.trim())
	const voteState = ctx.vote.state
	if (!voteState) {
		C.setSpanStatus(Otel.SpanStatusCode.ERROR, 'No vote in progress')
		return
	}
	if (voteState.voterType === 'internal' && msg.channelType !== 'ChatAdmin') {
		void SquadRcon.warn(ctx, msg.playerIds, Messages.WARNS.vote.wrongChat('AdminChat'))
		return
	}
	if (choiceIdx <= 0 || choiceIdx > voteState.choiceIds.length) {
		C.setSpanStatus(Otel.SpanStatusCode.ERROR, 'Invalid choice')
		void SquadRcon.warn(ctx, msg.playerIds, Messages.WARNS.vote.invalidChoice)
		return
	}
	if (voteState.code !== 'in-progress') {
		void SquadRcon.warn(ctx, msg.playerIds, Messages.WARNS.vote.noVoteInProgress)
		C.setSpanStatus(Otel.SpanStatusCode.ERROR, 'Vote not in progress')
		return
	}

	const choiceItemId = voteState.choiceIds[choiceIdx - 1]
	SM.PlayerIds.upsert(voteState.votes, ({ playerIds }) => playerIds, { playerIds: msg.playerIds, choice: choiceItemId })
	// voteState.votes[msg.playerIds] = choice
	const update: V.VoteStateUpdate = {
		state: voteState,
		source: {
			type: 'manual',
			event: 'vote',
			user: { steamId: msg.playerIds?.steam?.toString() },
		},
	}

	ctx.vote.update$.next(update)
	void (async () => {
		const serverState = await SquadServer.getServerState(ctx)
		const { item: voteItem } = Obj.destrNullable(LL.findItemById(serverState.layerQueue, voteState.itemId))
		if (!voteItem || !LL.isVoteItem(voteItem)) return
		const choiceLayerId = LL.findItemById(voteItem.choices, choiceItemId)?.item.layerId
		if (!choiceLayerId) return
		void SquadRcon.warn(
			ctx,
			msg.playerIds,
			Messages.WARNS.vote.voteCast(choiceLayerId, voteItem?.voteConfig?.displayProps ?? CONFIG.vote.voteDisplayProps),
		)
	})()
	C.setSpanStatus(Otel.SpanStatusCode.OK)
})

export const abortVote = C.spanOp(
	'abort',
	{ module, levels: { event: 'info' }, attrs: (_, opts) => opts, mutexes: ctx => ctx.vote.mtx },
	async (
		ctx: C.Db & C.SquadServer & C.Vote & C.LayerQueue & C.AdminList,
		opts: { aborter: USR.GuiOrChatUserId },
	) => {
		const voteState = ctx.vote.state
		return await DB.runTransaction(ctx, async (ctx) => {
			if (!voteState || voteState?.code !== 'in-progress') {
				return {
					code: 'err:no-vote-in-progress' as const,
					msg: 'No vote in progress',
				}
			}
			const serverState = await SquadServer.getServerState(ctx)
			const newVoteState: V.EndingVoteState = {
				code: 'ended:aborted',
				...Obj.selectProps(voteState, ['choiceIds', 'itemId', 'voterType', 'votes', 'deadline']),
				aborter: opts.aborter,
			}

			const update: V.VoteStateUpdate = {
				state: null,
				source: {
					type: 'manual',
					user: opts.aborter,
					event: 'abort-vote',
				},
			}
			await broadcastVoteUpdate(ctx, Messages.BROADCASTS.vote.aborted)
			ctx.vote.state = null
			addReleaseTask(() => ctx.vote.update$.next(update))
			ctx.vote.voteEndTask?.unsubscribe()
			ctx.vote.voteEndTask = null
			const layerQueue = Obj.deepClone(serverState.layerQueue)
			const { item } = Obj.destrNullable(LL.findItemById(layerQueue, newVoteState.itemId))
			if (!item || !LL.isVoteItem(item)) throw new Error('vote item not found or is invalid')
			LL.setEndingVoteStateInPlace(item, newVoteState)
			await SquadServer.updateServerState(ctx, { layerQueue }, { event: 'vote-abort', type: 'system' })

			return { code: 'ok' as const }
		})
	},
)

export const cancelVoteAutostart = C.spanOp(
	'cancel-autostart',
	{ module, attrs: (_, opts) => opts, mutexes: (ctx) => ctx.vote.mtx },
	async (ctx: C.Vote, opts: { user: USR.GuiOrChatUserId }) => {
		if (ctx.vote.state?.autostartCancelled) {
			return { code: 'err:autostart-already-cancelled' as const, msg: 'Vote is already cancelled' }
		}
		if (!ctx.vote.state || ctx.vote.state.code !== 'ready' || !ctx.vote.state.autostartTime) {
			return { code: 'err:vote-not-queued' as const, msg: 'No vote is currently scheduled' }
		}

		const newVoteState = Obj.deepClone(ctx.vote.state)
		newVoteState.autostartCancelled = true
		delete newVoteState.autostartTime
		ctx.vote.state = newVoteState

		addReleaseTask(() => {
			ctx.vote.update$.next({
				source: { type: 'manual', user: opts.user, event: 'autostart-cancelled' },
				state: ctx.vote.state,
			})
		})
		return { code: 'ok' as const }
	},
)

function registerVoteDeadlineAndReminder$(ctx: C.Db & C.SquadServer & C.Vote) {
	const serverId = ctx.serverId
	ctx.vote.voteEndTask?.unsubscribe()

	if (!ctx.vote.state || ctx.vote.state.code !== 'in-progress') return
	ctx.vote.voteEndTask = new Rx.Subscription()

	const currentTime = Date.now()
	const finalReminderWaitTime = Math.max(0, ctx.vote.state.deadline - CONFIG.vote.finalVoteReminder - currentTime)
	const regularReminderInterval = ctx.vote.state.voterType === 'internal'
		? CONFIG.vote.internalVoteReminderInterval
		: CONFIG.vote.voteReminderInterval
	const finalReminderBuffer = finalReminderWaitTime - regularReminderInterval

	// -------- schedule regular reminders --------
	ctx.vote.voteEndTask.add(
		Rx.interval(regularReminderInterval)
			.pipe(
				Rx.takeUntil(Rx.timer(finalReminderBuffer)),
				C.durableSub('regular-vote-reminders', { module }, async () => {
					const ctx = SquadServer.resolveSliceCtx(getBaseCtx(), serverId)
					if (!ctx.vote.state || ctx.vote.state.code !== 'in-progress') return
					const timeLeft = ctx.vote.state.deadline - Date.now()
					const serverState = await SquadServer.getServerState(ctx)
					const { item: voteItem } = Obj.destrNullable(LL.findItemById(serverState.layerQueue, ctx.vote.state.itemId))
					if (!voteItem || !LL.isVoteItem(voteItem)) return
					const msg = Messages.BROADCASTS.vote.voteReminder(
						ctx.vote.state,
						voteItem,
						timeLeft,
						false,
						voteItem.voteConfig?.displayProps ?? CONFIG.vote.voteDisplayProps,
					)
					await broadcastVoteUpdate(ctx, msg, { onlyNotifyNonVotingAdmins: true })
				}),
			)
			.subscribe(),
	)

	// -------- schedule final reminder --------
	if (finalReminderWaitTime > 0) {
		ctx.vote.voteEndTask.add(
			Rx.timer(finalReminderWaitTime).pipe(
				C.durableSub('final-vote-reminder', { module }, async () => {
					const ctx = SquadServer.resolveSliceCtx(getBaseCtx(), serverId)
					if (!ctx.vote.state || ctx.vote.state.code !== 'in-progress') return
					const serverState = await SquadServer.getServerState(ctx)
					const { item: voteItem } = Obj.destrNullable(LL.findItemById(serverState.layerQueue, ctx.vote.state.itemId))
					if (!voteItem || !LL.isVoteItem(voteItem)) return
					const msg = Messages.BROADCASTS.vote.voteReminder(
						ctx.vote.state,
						voteItem,
						CONFIG.vote.finalVoteReminder,
						true,
						voteItem.voteConfig?.displayProps ?? CONFIG.vote.voteDisplayProps,
					)
					await broadcastVoteUpdate(ctx, msg, { onlyNotifyNonVotingAdmins: true, repeatWarn: false })
				}),
			).subscribe(),
		)
	}

	// -------- schedule timeout handling --------
	ctx.vote.voteEndTask.add(
		Rx.timer(Math.max(ctx.vote.state.deadline - currentTime, 0)).subscribe({
			next: async () => {
				await handleVoteTimeout(SquadServer.resolveSliceCtx(getBaseCtx(), serverId))
			},
			complete: () => {
				log.info('vote deadline reached')
				ctx.vote.voteEndTask = null
			},
		}),
	)
}

const handleVoteTimeout = C.spanOp(
	'handle-timeout',
	{ module, levels: { event: 'info' }, mutexes: (ctx) => ctx.vote.mtx },
	async (ctx: C.Db & C.SquadServer & C.Vote & C.LayerQueue & C.MatchHistory & C.AdminList) => {
		const res = await DB.runTransaction(ctx, async (ctx) => {
			if (!ctx.vote.state || ctx.vote.state.code !== 'in-progress') {
				return {
					code: 'err:no-vote-in-progress' as const,
					msg: 'No vote in progress',
					currentVote: ctx.vote.state,
				}
			}
			const serverState = Obj.deepClone(await SquadServer.getServerState(ctx))
			const { item: listItem } = Obj.destrNullable(LL.findItemById(serverState.layerQueue, ctx.vote.state.itemId))
			if (!listItem || !LL.isVoteItem(listItem)) throw new Error('Invalid vote item')
			let endingVoteState: V.EndingVoteState
			let tally: V.Tally | null = null
			if (Object.values(ctx.vote.state.votes).length === 0) {
				endingVoteState = {
					code: 'ended:insufficient-votes',
					...Obj.selectProps(ctx.vote.state, ['choiceIds', 'itemId', 'deadline', 'votes', 'voterType']),
				}
			} else {
				const serverInfoRes = await ctx.server.serverInfo.get(ctx, { ttl: 10_000 })
				if (serverInfoRes.code !== 'ok') return serverInfoRes

				const serverInfo = serverInfoRes.data

				tally = V.tallyVotes(ctx.vote.state, serverInfo.playerCount)
				C.setSpanOpAttrs({ tally })

				const winnerId = tally.leaders[Math.floor(Math.random() * tally.leaders.length)]
				const winnerChoice = listItem.choices.find(c => c.itemId === winnerId)
				endingVoteState = {
					code: 'ended:winner',
					...Obj.selectProps(ctx.vote.state, ['choiceIds', 'itemId', 'deadline', 'votes', 'voterType']),
					winnerId,
				}
				if (winnerChoice) listItem.layerId = winnerChoice.layerId
			}
			LL.setEndingVoteStateInPlace(listItem, endingVoteState)
			const displayProps = listItem.voteConfig?.displayProps ?? CONFIG.vote.voteDisplayProps
			if (endingVoteState.code === 'ended:winner') {
				await broadcastVoteUpdate(ctx, Messages.BROADCASTS.vote.winnerSelected(tally!, listItem, endingVoteState.winnerId, displayProps), {
					repeatWarn: false,
				})
			}
			if (endingVoteState.code === 'ended:insufficient-votes') {
				await broadcastVoteUpdate(ctx, Messages.BROADCASTS.vote.insufficientVotes(listItem, displayProps), {
					repeatWarn: false,
				})
			}
			ctx.vote.state = null
			const update: V.VoteStateUpdate = {
				state: null,
				source: { type: 'system', event: 'vote-timeout' },
			}
			addReleaseTask(() => ctx.vote.update$.next(update))

			await LayerQueue.syncNextLayerInPlace(ctx, serverState, { skipDbWrite: true })
			await SquadServer.updateServerState(ctx, serverState, { type: 'system', event: 'vote-timeout' })
			return { code: 'ok' as const, endingVoteState, tally }
		})
		return res
	},
)

async function broadcastVoteUpdate(
	ctx: C.SquadServer & C.Vote & C.AdminList,
	msg: string,
	opts?: { onlyNotifyNonVotingAdmins?: boolean; repeatWarn?: boolean },
) {
	if (!ctx.vote.state) return
	switch (ctx.vote.state.voterType) {
		case 'public':
			await SquadRcon.broadcast(ctx, msg)
			break
		case 'internal':
			{
				await SquadRcon.warnAllAdmins(
					ctx,
					({ player }) => {
						if (!ctx.vote.state || !opts?.onlyNotifyNonVotingAdmins) return msg
						if (!V.isVoteStateWithVoteData(ctx.vote.state)) return
						if (SM.PlayerIds.find(ctx.vote.state.votes, ({ playerIds }) => playerIds, player.ids)) return
						return msg
					},
				)
			}
			break
		default:
			assertNever(ctx.vote.state.voterType)
	}
}

async function includeVoteStateUpdatePart(ctx: C.Db, update: V.VoteStateUpdate) {
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
	const dbUsers = await ctx.db().select().from(Schema.users).where(E.inArray(Schema.users.discordId, discordIdsArray))
	const users = await Promise.all(dbUsers.map(user => Users.buildUser(user)))
	const withParts: V.VoteStateUpdate & Parts<USR.UserPart> = { ...update, parts: { users } }
	return withParts
}

function getVoteStateDiscordIds(state: V.VoteState) {
	const discordIds: bigint[] = []
	switch (state.code) {
		case 'ready': {
			break
		}
		case 'in-progress': {
			if (typeof state.initiator === 'object' && state.initiator.discordId) discordIds.push(state.initiator.discordId)
			break
		}
		default:
			assertNever(state)
	}
	return discordIds
}

function getBaseCtx() {
	return C.initMutexStore(DB.addPooledDb(CS.init()))
}
