import * as Schema from '$root/drizzle/schema'
import { isAbortError, toAsyncGenerator, withAbortSignal } from '@/lib/async'
import type * as Cleanup from '@/lib/cleanup'
import { IsolatedSubject } from '@/lib/isolated-subject'
import { addReleaseTask } from '@/lib/nodejs-reentrant-mutexes'
import * as Obj from '@/lib/object'
import { assertNever } from '@/lib/type-guards'
import type { Parts } from '@/lib/types'
import * as Messages from '@/messages.ts'
import * as AppEvents from '@/models/app-events.models'
import * as CS from '@/models/context-shared'
import * as LL from '@/models/layer-list.models'
import * as ATTRS from '@/models/otel-attrs'
import * as SLL from '@/models/shared-layer-list'
import * as SM from '@/models/squad.models'
import type * as USR from '@/models/users.models'
import * as V from '@/models/vote.models.ts'
import * as RBAC from '@/rbac.models'
import * as C from '@/server/context.ts'
import * as DB from '@/server/db'
import { initModule } from '@/server/logger'
import { getOrpcBase } from '@/server/orpc-base'
import * as CleanupSys from '@/systems/cleanup.server'
import * as LayerQueue from '@/systems/layer-queue.server'
import * as MatchHistory from '@/systems/match-history.server'
import * as Rbac from '@/systems/rbac.server'
import * as SquadRcon from '@/systems/squad-rcon.server'
import * as SquadServer from '@/systems/squad-server.server'
import * as Users from '@/systems/users.server'
import * as Otel from '@opentelemetry/api'
import { Mutex, type MutexInterface, withTimeout } from 'async-mutex'
import * as dateFns from 'date-fns'
import * as E from 'drizzle-orm'
import * as Rx from 'rxjs'
import { z } from 'zod'

export type VoteContext = {
	voteEndTask: Rx.Subscription | null
	autostartVoteSub: Rx.Subscription | null
	mtx: MutexInterface
	state: V.VoteState | null
	update$: Rx.Subject<V.VoteStateUpdate>
}

const module = initModule('vote')
let log!: CS.Logger
const orpcBase = getOrpcBase(module)

export function setup() {
	log = module.getLogger()
}

export const router = {
	startVote: orpcBase
		.meta({ type: 'mutation' })
		.input(V.StartVoteInputSchema)
		.handler(async ({ input, context: _ctx }) => {
			const ctxRes = SquadServer.trySliceCtx(_ctx, input.serverId)
			if (ctxRes.code !== 'ok') return ctxRes
			const ctx = ctxRes.ctx
			return startVote(ctx, { ...input, initiator: { discordId: ctx.user.discordId } })
		}),

	endVoteEarly: orpcBase.meta({ type: 'mutation' }).input(z.object({ serverId: z.string() })).handler(async ({ context: _ctx, input }) => {
		const ctxRes = SquadServer.trySliceCtx(_ctx, input.serverId)
		if (ctxRes.code !== 'ok') return ctxRes
		const ctx = ctxRes.ctx
		const denyRes = await Rbac.tryDenyPermissionsForUser(ctx, RBAC.perm('vote:manage'))
		if (denyRes) return denyRes
		return await endVote(ctx, {
			reason: 'ended-early',
			endedBy: { discordId: ctx.user.discordId },
		})
	}),

	abortVote: orpcBase.meta({ type: 'mutation' }).input(z.object({ serverId: z.string() })).handler(async ({ context: _ctx, input }) => {
		const ctxRes = SquadServer.trySliceCtx(_ctx, input.serverId)
		if (ctxRes.code !== 'ok') return ctxRes
		const ctx = ctxRes.ctx
		const denyRes = await Rbac.tryDenyPermissionsForUser(ctx, RBAC.perm('vote:manage'))
		if (denyRes) return denyRes
		return await abortVote(ctx, { aborter: { discordId: ctx.user.discordId } })
	}),

	cancelVoteAutostart: orpcBase.meta({ type: 'mutation' }).input(z.object({ serverId: z.string() })).handler(
		async ({ context: _ctx, input }) => {
			const ctxRes = SquadServer.trySliceCtx(_ctx, input.serverId)
			if (ctxRes.code !== 'ok') return ctxRes
			const ctx = ctxRes.ctx
			const denyRes = await Rbac.tryDenyPermissionsForUser(ctx, RBAC.perm('vote:manage'))
			if (denyRes) return denyRes
			return await cancelVoteAutostart(ctx, { user: { discordId: ctx.user.discordId } })
		},
	),

	watchUpdates: orpcBase.meta({ logLevel: 'trace' }).input(z.object({ serverId: z.string() })).handler(async function*(
		{ context, signal, input },
	) {
		const obs = SquadServer.sliceStream$(context.wsClientId, input.serverId, (ctx) =>
			Rx.from((async function*() {
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
			})())).pipe(withAbortSignal(signal!))

		yield* toAsyncGenerator(obs)
	}),
}

export function initVoteContext(cleanup: Cleanup.Tasks) {
	const vote: VoteContext = {
		autostartVoteSub: null,
		voteEndTask: null,
		state: null,
		mtx: withTimeout(new Mutex(), 5_000),

		update$: new IsolatedSubject<V.VoteStateUpdate>(),
	}

	cleanup.push(
		vote.update$,
		vote.mtx,
		() => vote.autostartVoteSub,
		() => vote.voteEndTask,
	)

	return vote
}

export const syncVoteStateWithQueueState = C.spanOp(
	'syncVoteStateWithQueueState',
	{ module, mutexes: (ctx) => ctx.vote.mtx },
	async (
		ctx: C.SquadServer & C.Vote & C.MatchHistory & C.ServerSettings & CS.AbortSignal,
		queue: LL.List,
	) => {
		const serverId = ctx.serverId
		let newVoteState: V.VoteState | undefined | null

		const nextUpItem = queue[0]

		// check if we need to set 'ready'. we only want to do this if there's been a meaningul state change that means we have to initialize it or restart the autostart time. Also if we already have a .endingVoteState we don't want to overwrite that here
		const currentMatch = await MatchHistory.getCurrentMatch(ctx)
		const vote = ctx.vote

		if (vote.state?.code === 'in-progress') {
			if (queue.some(item => item.itemId === vote.state!.itemId)) return

			// setting to null rather than calling clearVote indicates that a new "ready" vote state might be set instead
			newVoteState = null
		} else if (
			nextUpItem && LL.isVoteItem(nextUpItem) && !nextUpItem.endingVoteState
			&& nextUpItem && ctx.vote.state?.itemId !== nextUpItem.itemId
			&& currentMatch.status !== 'post-game'
			&& (!currentMatch.startTime || currentMatch.startTime.getTime() + ctx.serverSettings.settings.vote.autoStartVoteCutoff < Date.now())
		) {
			let autostartTime: Date | undefined
			if (currentMatch.startTime && ctx.serverSettings.settings.vote.autoStartVoteDelay) {
				const startTime = dateFns.addMilliseconds(currentMatch.startTime, ctx.serverSettings.settings.vote.autoStartVoteDelay)
				if (dateFns.isFuture(startTime)) autostartTime = startTime
				else autostartTime = dateFns.addMinutes(new Date(), 5)
			}
			newVoteState = {
				code: 'ready',
				choiceIds: nextUpItem.choices.map(choice => choice.itemId),
				itemId: nextUpItem.itemId,
				voterType: vote.state?.voterType ?? 'public',
				autostartTime,
			}
		} else if (!nextUpItem || !LL.isVoteItem(nextUpItem)) {
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
			if (newVoteState?.code === 'ready' && newVoteState.autostartTime && ctx.serverSettings.settings.vote.autoStartVoteDelay) {
				log.info('scheduling autostart vote to %s for %s', newVoteState.autostartTime.toISOString(), newVoteState.itemId)
				vote.autostartVoteSub = Rx.of(1).pipe(Rx.delay(dateFns.differenceInMilliseconds(newVoteState.autostartTime, Date.now()))).subscribe(
					() => {
						startVote(SquadServer.resolveSliceCtx(getBaseCtx(), serverId), { initiator: 'autostart' }).catch((err) => {
							if (!isAbortError(err)) log.error(err)
						})
					},
				)
			}
			vote.state = newVoteState
			addReleaseTask(() => vote.update$.next(update))
		}
	},
)

export const startVote = C.spanOp(
	'startVote',
	{
		module,
		levels: { event: 'info' },
		attrs: (_, opts) => ({
			[ATTRS.Vote.INITIATOR]: ATTRS.formatUserId(opts.initiator),
			[ATTRS.Vote.ITEM_ID]: opts.itemId,
			[ATTRS.Vote.VOTER_TYPE]: opts.voterType,
		}),
		mutexes: (ctx) => ctx.vote.mtx,
	},
	async (
		ctx:
			& C.Db
			& Partial<C.User>
			& C.SquadServer
			& C.Rcon
			& C.Vote
			& C.LayerQueue
			& C.MatchHistory
			& C.ServerSettings
			& CS.AbortSignal,
		opts: Omit<V.StartVoteInput, 'serverId'> & { initiator: USR.GuiOrChatUserId | 'autostart' },
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

		const duration = opts.duration ?? ctx.serverSettings.settings.vote.voteDuration
		const layerQueue = LayerQueue.getSavedQueue(ctx)
		const itemId = opts.itemId ?? layerQueue[0]?.itemId
		if (!itemId) {
			return { code: 'err:item-not-found' as const, msg: Messages.WARNS.vote.start.itemNotFound }
		}

		const initiateVoteRes = V.canInitiateVote(
			itemId,
			layerQueue,
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
		await LayerQueue.dispatchOp(ctx, { op: 'set-vote-result', opId: SLL.createOpId(), voteItemId: item.itemId, result: null })

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
		await broadcastVoteUpdate(
			ctx,
			updatedVoteState,
			Messages.BROADCASTS.vote.started(
				ctx.vote.state,
				item,
				duration,
				item.voteConfig?.displayProps ?? ctx.serverSettings.settings.vote.voteDisplayProps,
			),
		)

		await SquadServer.emitAppEvent(
			ctx,
			AppEvents.create<AppEvents.VoteStarted>({
				type: 'VOTE_STARTED',
				actor: SquadServer.actorFromUser(ctx, opts.initiator),
				serverId: ctx.serverId,
				matchId: currentMatch.historyEntryId,
				causeId: null,
				choiceCount: item.choices.length,
				choices: item.choices.map(choice => choice.layerId),
				durationMs: duration,
			}),
		)

		return { code: 'ok' as const, voteStateUpdate: update }
	},
)

export const handleVote = C.spanOp(
	'handleVote',
	{
		module,
		attrs: (_, msg) => ({ messageId: msg.message, playerUsername: msg.playerIds.username }),
	},
	(
		ctx: C.Db & C.SquadServer & C.Vote & C.LayerQueue & C.Rcon & C.ServerSettings & CS.AbortSignal & CS.Deferred,
		msg: SM.RconEvents.ChatMessage,
	) => {
		//
		const choiceIdx = parseInt(msg.message.trim())
		const voteState = ctx.vote.state
		if (!voteState) {
			C.setSpanStatus(Otel.SpanStatusCode.ERROR, 'No vote in progress')
			return
		}
		if (voteState.voterType === 'internal' && msg.channelType !== 'ChatAdmin') {
			CS.defer(ctx, SquadRcon.warn(ctx, msg.playerIds, Messages.WARNS.vote.wrongChat('AdminChat')))
			return
		}
		if (choiceIdx <= 0 || choiceIdx > voteState.choiceIds.length) {
			C.setSpanStatus(Otel.SpanStatusCode.ERROR, 'Invalid choice')
			CS.defer(ctx, SquadRcon.warn(ctx, msg.playerIds, Messages.WARNS.vote.invalidChoice))
			return
		}
		if (voteState.code !== 'in-progress') {
			CS.defer(ctx, SquadRcon.warn(ctx, msg.playerIds, Messages.WARNS.vote.noVoteInProgress))
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
		CS.defer(
			ctx,
			(async () => {
				const layerQueue = LayerQueue.getSavedQueue(ctx)
				const { item: voteItem } = Obj.destrNullable(LL.findItemById(layerQueue, voteState.itemId))
				if (!voteItem || !LL.isVoteItem(voteItem)) return
				const choiceLayerId = LL.findItemById(voteItem.choices, choiceItemId)?.item.layerId
				if (!choiceLayerId) return
				await SquadRcon.warn(
					ctx,
					msg.playerIds,
					Messages.WARNS.vote.voteCast(
						choiceLayerId,
						voteItem?.voteConfig?.displayProps ?? ctx.serverSettings.settings.vote.voteDisplayProps,
					),
				)
			})(),
		)
		C.setSpanStatus(Otel.SpanStatusCode.OK)
	},
)

export const abortVote = C.spanOp(
	'abortVote',
	{
		module,
		levels: { event: 'info' },
		attrs: (_, opts) => ({ [ATTRS.Vote.ABORTER]: ATTRS.formatUserId(opts.aborter) }),
		mutexes: ctx => ctx.vote.mtx,
	},
	async (
		ctx: C.Db & C.Rcon & C.SquadServer & C.MatchHistory & C.Vote & C.LayerQueue & C.ServerSettings & CS.AbortSignal,
		opts: { aborter: USR.GuiOrChatUserId },
	) => {
		const voteState = ctx.vote.state

		if (!voteState || voteState?.code !== 'in-progress') {
			return {
				code: 'err:no-vote-in-progress' as const,
				msg: 'No vote in progress',
			}
		}
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
		await broadcastVoteUpdate(ctx, newVoteState, Messages.BROADCASTS.vote.aborted)
		ctx.vote.state = null
		addReleaseTask(() => ctx.vote.update$.next(update))
		ctx.vote.voteEndTask?.unsubscribe()
		ctx.vote.voteEndTask = null
		await LayerQueue.dispatchOp(ctx, {
			op: 'set-vote-result',
			voteItemId: newVoteState.itemId,
			result: newVoteState,
			opId: SLL.createOpId(),
		})

		await SquadServer.emitAppEvent(
			ctx,
			AppEvents.create<AppEvents.VoteAborted>({
				type: 'VOTE_ABORTED',
				actor: SquadServer.actorFromUser(ctx, opts.aborter),
				serverId: ctx.serverId,
				matchId: (await MatchHistory.getCurrentMatch(ctx)).historyEntryId,
				causeId: null,
			}),
		)

		return { code: 'ok' as const }
	},
)

export const cancelVoteAutostart = C.spanOp(
	'cancelVoteAutostart',
	{
		module,
		attrs: (_, opts) => ({ [ATTRS.Vote.CANCELLED_BY]: ATTRS.formatUserId(opts.user) }),
		mutexes: (ctx) => ctx.vote.mtx,
	},
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

function registerVoteDeadlineAndReminder$(ctx: C.Db & C.SquadServer & C.Vote & C.ServerSettings) {
	const serverId = ctx.serverId
	ctx.vote.voteEndTask?.unsubscribe()

	if (!ctx.vote.state || ctx.vote.state.code !== 'in-progress') return
	ctx.vote.voteEndTask = new Rx.Subscription()

	const currentTime = Date.now()
	const finalReminderWaitTime = Math.max(0, ctx.vote.state.deadline - ctx.serverSettings.settings.vote.finalVoteReminder - currentTime)
	const regularReminderInterval = ctx.vote.state.voterType === 'internal'
		? ctx.serverSettings.settings.vote.internalVoteReminderInterval
		: ctx.serverSettings.settings.vote.voteReminderInterval
	const finalReminderBuffer = finalReminderWaitTime - regularReminderInterval

	// -------- schedule regular reminders --------
	ctx.vote.voteEndTask.add(
		Rx.interval(regularReminderInterval)
			.pipe(
				Rx.takeUntil(Rx.timer(finalReminderBuffer)),
				C.durableSub('regular-vote-reminders', { module }, async (_, signal) => {
					const ctx = SquadServer.resolveSliceCtx({ ...getBaseCtx(), signal }, serverId)
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
						voteItem.voteConfig?.displayProps ?? ctx.serverSettings.settings.vote.voteDisplayProps,
					)
					await broadcastVoteUpdate(ctx, ctx.vote.state, msg, { onlyNotifyNonVotingAdmins: true })
				}),
			)
			.subscribe(),
	)

	// -------- schedule final reminder --------
	if (finalReminderWaitTime > 0) {
		ctx.vote.voteEndTask.add(
			Rx.timer(finalReminderWaitTime).pipe(
				C.durableSub('final-vote-reminder', { module }, async (_, signal) => {
					const ctx = SquadServer.resolveSliceCtx({ ...getBaseCtx(), signal }, serverId)
					if (!ctx.vote.state || ctx.vote.state.code !== 'in-progress') return
					const serverState = await SquadServer.getServerState(ctx)
					const { item: voteItem } = Obj.destrNullable(LL.findItemById(serverState.layerQueue, ctx.vote.state.itemId))
					if (!voteItem || !LL.isVoteItem(voteItem)) return
					const msg = Messages.BROADCASTS.vote.voteReminder(
						ctx.vote.state,
						voteItem,
						ctx.serverSettings.settings.vote.finalVoteReminder,
						true,
						voteItem.voteConfig?.displayProps ?? ctx.serverSettings.settings.vote.voteDisplayProps,
					)
					await broadcastVoteUpdate(ctx, ctx.vote.state, msg, { onlyNotifyNonVotingAdmins: true })
				}),
			).subscribe(),
		)
	}

	// -------- schedule timeout handling --------
	ctx.vote.voteEndTask.add(
		Rx.timer(Math.max(ctx.vote.state.deadline - currentTime, 0)).subscribe({
			next: async () => {
				await endVote(SquadServer.resolveSliceCtx(getBaseCtx(), serverId), { reason: 'vote-timeout' })
			},
			complete: () => {
				log.info('vote deadline reached')
				ctx.vote.voteEndTask = null
			},
		}),
	)
}

export const endVote = C.spanOp(
	'endVote',
	{
		module,
		levels: { event: 'info' },
		mutexes: (ctx) => ctx.vote.mtx,
		attrs: (_, opts) => ({
			[ATTRS.Vote.END_REASON]: opts.reason,
			[ATTRS.Vote.ENDED_BY]: opts.reason === 'ended-early' ? ATTRS.formatUserId(opts.endedBy) : undefined,
		}),
	},
	async (
		ctx: C.Db & C.SquadServer & C.Vote & C.LayerQueue & C.MatchHistory & C.Rcon & C.ServerSettings & CS.AbortSignal,
		opts: { reason: 'vote-timeout' } | { reason: 'ended-early'; endedBy: USR.GuiOrChatUserId },
	) => {
		if (!ctx.vote.state || ctx.vote.state.code !== 'in-progress') {
			return {
				code: 'err:no-vote-in-progress' as const,
				msg: 'No vote in progress',
				currentVote: ctx.vote.state,
			}
		}
		const { item: listItem } = Obj.destrNullable(LL.findItemById(LayerQueue.getSavedQueue(ctx), ctx.vote.state.itemId))
		if (!listItem || !LL.isVoteItem(listItem)) throw new Error('Invalid vote item')
		let endingVoteState: V.EndingVoteState
		let tally: V.Tally | null = null
		if (Object.values(ctx.vote.state.votes).length === 0) {
			endingVoteState = {
				code: 'ended:insufficient-votes',
				endedEarly: opts.reason === 'ended-early' ? opts.endedBy : undefined,
				...Obj.selectProps(ctx.vote.state, ['choiceIds', 'itemId', 'deadline', 'votes', 'voterType']),
			}
		} else {
			const serverInfoRes = await ctx.server.serverInfo.get(ctx, { ttl: 0 })
			if (serverInfoRes.code !== 'ok') return serverInfoRes

			const serverInfo = serverInfoRes.data

			tally = V.tallyVotes(ctx.vote.state, serverInfo.playerCount)
			C.setSpanOpAttrs({ tally })

			const winnerId = tally.leaders[Math.floor(Math.random() * tally.leaders.length)]
			const winnerChoice = listItem.choices.find(c => c.itemId === winnerId)
			endingVoteState = {
				code: 'ended:winner',
				endedEarly: opts.reason === 'ended-early' ? opts.endedBy : undefined,
				...Obj.selectProps(ctx.vote.state, ['choiceIds', 'itemId', 'deadline', 'votes', 'voterType']),
				winnerId,
			}
			if (winnerChoice) listItem.layerId = winnerChoice.layerId
		}

		ctx.vote.state = null
		const update: V.VoteStateUpdate = {
			state: null,
			source: { type: 'system', event: opts.reason },
		}
		await LayerQueue.dispatchOp(ctx, {
			op: 'set-vote-result',
			opId: SLL.createOpId(),
			result: endingVoteState,
			voteItemId: endingVoteState.itemId,
		})

		const displayProps = listItem.voteConfig?.displayProps ?? ctx.serverSettings.settings.vote.voteDisplayProps
		if (endingVoteState.code === 'ended:winner') {
			await broadcastVoteUpdate(
				ctx,
				endingVoteState,
				Messages.BROADCASTS.vote.winnerSelected(tally!, listItem, endingVoteState.winnerId, displayProps, opts.reason === 'ended-early'),
			)
		}
		if (endingVoteState.code === 'ended:insufficient-votes') {
			await broadcastVoteUpdate(ctx, endingVoteState, Messages.BROADCASTS.vote.insufficientVotes(listItem, displayProps))
		}
		await SquadServer.emitAppEvent(
			ctx,
			AppEvents.create<AppEvents.VoteEnded>({
				type: 'VOTE_ENDED',
				actor: SquadServer.actorFromUser(ctx, opts.reason === 'ended-early' ? opts.endedBy : undefined),
				serverId: ctx.serverId,
				matchId: (await MatchHistory.getCurrentMatch(ctx)).historyEntryId,
				causeId: null,
				reason: opts.reason,
				winnerLayerId: endingVoteState.code === 'ended:winner' ? listItem.layerId : null,
				// the tally is keyed by queue item id, which means nothing once the item is gone: resolve it to layers
				tally: tally
					? listItem.choices.map(choice => ({ layerId: choice.layerId, votes: tally!.totals.get(choice.itemId) ?? 0 }))
					: undefined,
				totalVotes: tally?.totalVotes,
				turnoutPercentage: tally?.turnoutPercentage,
			}),
		)
		addReleaseTask(() => ctx.vote.update$.next(update))
		return { code: 'ok' as const, endingVoteState, tally }
	},
)

async function broadcastVoteUpdate(
	ctx: C.SquadServer & C.Vote & C.Rcon & CS.AbortSignal,
	voteState: V.VoteState | V.EndingVoteState,
	msg: string,
	opts?: { onlyNotifyNonVotingAdmins?: boolean },
) {
	switch (voteState.voterType) {
		case 'public':
			await SquadRcon.broadcast(ctx, msg)
			break
		case 'internal':
			{
				await SquadRcon.warnAllAdmins(
					ctx,
					({ player }) => {
						if (!opts?.onlyNotifyNonVotingAdmins) return msg
						if (!V.isVoteStateWithVoteData(voteState)) return
						if (SM.PlayerIds.find(voteState.votes, ({ playerIds }) => playerIds, player.ids)) return
						return msg
					},
				)
			}
			break
		default:
			assertNever(voteState.voterType)
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
	return C.initMutexStore(DB.addPooledDb({ ...CS.init(), signal: CleanupSys.shutdownSignal }))
}
