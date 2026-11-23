import * as Otel from '@opentelemetry/api'
import { Mutex, withTimeout } from 'async-mutex'
import * as dateFns from 'date-fns'

import type * as Cleanup from '@/lib/cleanup'
import { createId } from '@/lib/id'
import { IsolatedSubject } from '@/lib/isolated-subject'
import { addReleaseTask } from '@/lib/nodejs-reentrant-mutexes'
import * as Obj from '@/lib/object-utils'
import * as Prom from '@/lib/promise-utils'
import * as Rx from '@/lib/rxjs'
import { assertNever } from '@/lib/type-guards'
import type { Parts } from '@/lib/types'
import { z } from '@/lib/zod'
import * as V_Msgs from '@/messages/vote.messages'
import * as AppEvents from '@/models/app-events.models'
import * as CS from '@/models/context-shared.models'
import * as LL from '@/models/layer-list.models'
import type * as LQ from '@/models/layer-queue.models'
import type * as L from '@/models/layer.models'
import type * as MH from '@/models/match-history.models'
import type * as Msgs from '@/models/messages.models'
import * as ATTRS from '@/models/otel-attrs.models'
import * as SETTINGS from '@/models/settings.models'
import * as SLL from '@/models/shared-layer-list.models'
import type * as SR from '@/models/squad-rcon.models'
import type * as SQS from '@/models/squad-server.models'
import * as SM from '@/models/squad.models'
import type * as USR from '@/models/users.models'
import * as V from '@/models/vote.models.ts'
import * as C from '@/server/context.ts'
import * as DB from '@/server/db'
import * as Instr from '@/server/instrumentation'
import { initModule } from '@/server/logger'
import { getOrpcBase } from '@/server/orpc-base'
import * as CleanupSys from '@/systems/cleanup.server'
import * as LayerQueue from '@/systems/layer-queue.server'
import * as MatchHistory from '@/systems/match-history.server'
import * as SquadRcon from '@/systems/squad-rcon.server'
import * as SquadServerActions from '@/systems/squad-server-actions.server'
import * as SquadServer from '@/systems/squad-server.server'
import * as Users from '@/systems/users.server'

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
			const ctxRes = await SquadServer.tryCtx(_ctx, input.serverId)
			if (ctxRes.code !== 'ok') return ctxRes
			const ctx = ctxRes.ctx
			return startVote(ctx, { ...input, initiator: { discordId: ctx.user.discordId } })
		}),

	endVoteEarly: orpcBase
		.meta({ type: 'mutation' })
		.input(V.EndVoteInputSchema)
		.handler(async ({ context: _ctx, input }) => {
			const ctxRes = await SquadServer.tryCtx(_ctx, input.serverId)
			if (ctxRes.code !== 'ok') return ctxRes
			const ctx = ctxRes.ctx
			return await endVote(ctx, { voteId: input.voteId, reason: 'ended-early', endedBy: { discordId: ctx.user.discordId } })
		}),

	abortVote: orpcBase
		.meta({ type: 'mutation' })
		.input(V.EndVoteInputSchema)
		.handler(async ({ context: _ctx, input }) => {
			const ctxRes = await SquadServer.tryCtx(_ctx, input.serverId)
			if (ctxRes.code !== 'ok') return ctxRes
			const ctx = ctxRes.ctx
			return await abortVote(ctx, { voteId: input.voteId, aborter: { discordId: ctx.user.discordId } })
		}),

	cancelVoteAutostart: orpcBase
		.meta({ type: 'mutation' })
		.input(z.object({ serverId: z.string() }))
		.handler(async ({ context: _ctx, input }) => {
			const ctxRes = await SquadServer.tryCtx(_ctx, input.serverId)
			if (ctxRes.code !== 'ok') return ctxRes
			const ctx = ctxRes.ctx
			return await cancelVoteAutostart(ctx, { user: { discordId: ctx.user.discordId } })
		}),

	watchSimpleVote: orpcBase
		.meta({ logLevel: 'trace' })
		.input(z.object({ serverId: z.string() }))
		.handler(async function* ({ context, signal, input }) {
			const obs = SquadServer.stream$(context.wsClientId, input.serverId, (ctx) =>
				ctx.vote.simple.update$.pipe(Rx.startWith({ code: 'state', state: ctx.vote.simple.state } satisfies V.SimpleVote.Update)),
			).pipe(Rx.Ext.withAbortSignal(signal!))

			yield* Rx.Ext.toAsyncGenerator(obs)
		}),

	watchUpdates: orpcBase
		.meta({ logLevel: 'trace' })
		.input(z.object({ serverId: z.string() }))
		.handler(async function* ({ context, signal, input }) {
			const obs = SquadServer.stream$(context.wsClientId, input.serverId, (ctx) =>
				ctx.vote.update$.pipe(
					Rx.startWith(null),
					Rx.concatMap(async (update): Promise<V.VoteStateUpdateOrInitialWithParts> => {
						if (update) return { code: 'update', update: await includeVoteStateUpdatePartShared(update) }
						const voteState = ctx.vote.state
						if (!voteState) return { code: 'initial-state', state: null }
						const ids = getVoteStateDiscordIds(voteState)
						const users = await Users.buildUsers(Users.getDbUsers(ctx, ids))
						return { code: 'initial-state', state: { ...voteState, parts: { users } } }
					}),
				),
			).pipe(Rx.Ext.withAbortSignal(signal!))

			yield* Rx.Ext.toAsyncGenerator(obs)
		}),
}

export function initVoteContext(cleanup: Cleanup.Tasks) {
	const vote: V.Ctx.Payload = {
		autostartVoteSub: null,
		voteEndTask: null,
		state: null,
		startedEventId: null,
		mtx: withTimeout(new Mutex(), 5_000),

		update$: new IsolatedSubject<V.VoteStateUpdate>(),
		simple: {
			state: null,
			endTask: null,
			startedEventId: null,
			update$: new IsolatedSubject<V.SimpleVote.Update>(),
		},
	}

	cleanup.push(
		vote.update$,
		vote.simple.update$,
		vote.mtx,
		() => vote.autostartVoteSub,
		() => vote.voteEndTask,
		() => vote.simple.endTask,
	)

	return vote
}

function initiatorActor(ctx: SQS.Ctx, initiator: V.VoteInitiator | 'autostart'): AppEvents.Actor {
	if (V.isPluginInitiator(initiator)) return { type: 'plugin', pluginId: initiator.pluginId }
	return SquadServer.actorFromUser(ctx, initiator)
}

function formatInitiator(initiator: V.VoteInitiator | 'autostart') {
	return V.isPluginInitiator(initiator) ? `plugin:${initiator.pluginId}` : ATTRS.formatUserId(initiator)
}

type WritableVotes = { state: V.VoteState | null; simple: { state: V.SimpleVote.State | null } }

// The only writes to either vote's state. Starting a vote while one runs is a bug in the caller, which should have
// refused through refuseIfVoteRunning, so it throws rather than leave two votes reading the same chat numbers.
function setLayerVoteState(vote: V.Ctx.Payload, state: V.VoteState | null) {
	if (state?.code === 'in-progress') assertNoVoteRunning(vote, state.itemId)
	;(vote as WritableVotes).state = state
}

function setSimpleVoteState(vote: V.Ctx.Payload, state: V.SimpleVote.State | null) {
	if (state?.code === 'in-progress') assertNoVoteRunning(vote, state.voteId)
	;(vote as WritableVotes).simple.state = state
}

function assertNoVoteRunning(vote: V.Ctx.Payload, startingId: string) {
	const running = V.runningVote(vote)
	if (running) throw new Error(`cannot start vote ${startingId} while a ${running} vote is running`)
}

// What a start is refused with while a vote of either kind runs. Callers hold ctx.vote.mtx, so nothing starts between
// this check and their write.
function refuseIfVoteRunning(ctx: V.Ctx & Msgs.Ctx) {
	const running = V.runningVote(ctx.vote)
	switch (running) {
		case null:
			return null
		case 'layer':
			return { code: 'err:vote-in-progress' as const, msg: ctx.tr.text(V_Msgs.start.voteAlreadyInProgress()) }
		case 'simple':
			return { code: 'err:vote-in-progress' as const, msg: ctx.tr.text(V_Msgs.simple.simpleVoteInProgress()) }
		default:
			assertNever(running)
	}
}

export const syncVoteStateWithQueueState = Instr.spanOp(
	'syncVoteStateWithQueueState',
	{ module, mutexes: (ctx) => ctx.vote.mtx },
	async (ctx: SQS.Ctx & V.Ctx & MH.Ctx & SETTINGS.Ctx & CS.AbortSignal, queue: LL.List) => {
		const serverId = ctx.serverId
		let newVoteState: V.VoteState | undefined | null

		const nextUpItem = queue[0]

		// check if we need to set 'ready'. we only want to do this if there's been a meaningul state change that means we have to initialize it or restart the autostart time. Also if we already have a .endingVoteState we don't want to overwrite that here
		const currentMatch = await MatchHistory.getCurrentMatch(ctx)
		const vote = ctx.vote

		if (vote.state?.code === 'in-progress') {
			if (queue.some((item) => item.itemId === vote.state!.itemId)) return

			// setting to null rather than calling clearVote indicates that a new "ready" vote state might be set instead
			newVoteState = null
		} else if (
			nextUpItem &&
			LL.isVoteItem(nextUpItem) &&
			!nextUpItem.endingVoteState &&
			ctx.vote.state?.itemId !== nextUpItem.itemId &&
			currentMatch?.status !== 'post-game'
		) {
			const { autoStartVoteDelay, autoStartVoteCutoff } = ctx.serverSettings.settings.vote
			let autostartTime: Date | undefined
			if (
				currentMatch?.startTime &&
				autoStartVoteDelay &&
				dateFns.isFuture(dateFns.addMilliseconds(currentMatch.startTime, autoStartVoteCutoff))
			) {
				const startTime = dateFns.addMilliseconds(currentMatch.startTime, autoStartVoteDelay)
				if (dateFns.isFuture(startTime)) autostartTime = startTime
				else autostartTime = dateFns.addMinutes(new Date(), 5)
			}
			newVoteState = {
				code: 'ready',
				choiceIds: nextUpItem.choices.map((choice) => choice.itemId),
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
				const itemId = newVoteState.itemId
				log.info('scheduling autostart vote to %s for %s', newVoteState.autostartTime.toISOString(), itemId)
				vote.autostartVoteSub = Rx.of(1)
					.pipe(Rx.delay(dateFns.differenceInMilliseconds(newVoteState.autostartTime, Date.now())))
					.subscribe(() => {
						startVote(SquadServer.resolveCtx(getBaseCtx(), serverId), { kind: 'layer', itemId, initiator: 'autostart' }).catch(
							(err) => {
								if (!Prom.isAbortError(err)) log.error(err)
							},
						)
					})
			}
			setLayerVoteState(vote, newVoteState)
			// Sent once the locks are released, by which time a start holding them may have replaced this state and sent
			// its own update. Sending this one after it would leave watchers with a state the server no longer holds.
			addReleaseTask(() => {
				if (vote.state === newVoteState) vote.update$.next(update)
			})
		}
	},
)

type StartVoteCtx = C.Db & SQS.Ctx & SR.Ctx.Rcon & V.Ctx & LQ.Ctx & MH.Ctx & SETTINGS.Ctx & CS.AbortSignal & Msgs.Ctx
type StartLayerVoteOpts = Extract<V.StartVoteOpts, { kind: 'layer' }> & { initiator: V.VoteInitiator | 'autostart' }
type StartSimpleVoteOpts = Extract<V.StartVoteOpts, { kind: 'simple' }> & { initiator: V.VoteInitiator }

/**
 * Starts a vote of either kind: the layer vote of a vote item in the queue, or a simple vote between text choices. Only
 * autostart starts a layer vote on its own initiative.
 */
export const startVote = Instr.spanOp(
	'startVote',
	{
		module,
		levels: { event: 'info' },
		attrs: (_, opts) => ({
			[ATTRS.Vote.INITIATOR]: formatInitiator(opts.initiator),
			[ATTRS.Vote.ITEM_ID]: opts.kind === 'layer' ? opts.itemId : undefined,
			[ATTRS.Vote.VOTER_TYPE]: opts.voterType,
		}),
		mutexes: (ctx) => ctx.vote.mtx,
	},
	async (ctx: StartVoteCtx, opts: StartLayerVoteOpts | StartSimpleVoteOpts) => {
		const running = refuseIfVoteRunning(ctx)
		if (running) return running
		switch (opts.kind) {
			case 'layer':
				return await startLayerVote(ctx, opts)
			case 'simple':
				return await startSimpleVote(ctx, opts)
			default:
				assertNever(opts)
		}
	},
)

const startLayerVote = Instr.spanOp('startLayerVote', { module }, async (ctx: StartVoteCtx, opts: StartLayerVoteOpts) => {
	const statusRes = await ctx.squadRcon.layersStatus.get(ctx, { ttl: 10_000 })
	if (statusRes.code !== 'ok') {
		return statusRes
	}
	const currentMatch = await MatchHistory.getCurrentMatch(ctx)
	if (currentMatch?.status === 'post-game') {
		return { code: 'err:vote-not-allowed' as const, msg: ctx.tr.text(V_Msgs.start.noVoteInPostGame()) }
	}

	const layerQueue = LayerQueue.getSavedQueue(ctx)
	const initiateVoteRes = V.canInitiateVote(opts.itemId, layerQueue, opts.voterType ?? 'public', ctx.vote.state ?? undefined)

	const msgMap = {
		'err:item-not-found': ctx.tr.text(V_Msgs.start.itemNotFound()),
		'err:invalid-item-type': ctx.tr.text(V_Msgs.start.invalidItemType()),
		'err:editing-in-progress': ctx.tr.text(V_Msgs.start.editingInProgress()),
		'err:public-vote-not-first': ctx.tr.text(V_Msgs.start.publicVoteNotFirst()),
		'err:vote-in-progress': ctx.tr.text(V_Msgs.start.voteAlreadyInProgress()),
		ok: null,
	} satisfies Record<(typeof initiateVoteRes)['code'], string | null>

	if (initiateVoteRes.code !== 'ok') {
		return {
			code: initiateVoteRes.code,
			msg: msgMap[initiateVoteRes.code]!,
		}
	}

	const item = initiateVoteRes.item
	const duration = opts.duration ?? item.voteConfig?.duration ?? ctx.serverSettings.settings.vote.voteDuration
	await LayerQueue.dispatchOp(ctx, { op: 'set-vote-result', opId: SLL.createOpId(), voteItemId: item.itemId, result: null })

	const updatedVoteState = {
		code: 'in-progress',
		voteId: createId(16),
		deadline: Date.now() + duration,
		votes: [],
		initiator: opts.initiator,
		choiceIds: item.choices.map((choice) => choice.itemId),
		itemId: item.itemId,
		voterType: opts.voterType ?? 'public',
	} satisfies V.VoteState

	log.info('registering vote deadline')
	const update = {
		state: updatedVoteState,
		source:
			opts.initiator === 'autostart'
				? { type: 'system', event: 'automatic-start-vote' }
				: V.isPluginInitiator(opts.initiator)
					? { type: 'plugin', event: 'start-vote', pluginId: opts.initiator.pluginId }
					: { type: 'manual', event: 'start-vote', user: opts.initiator },
	} satisfies V.VoteStateUpdate

	ctx.vote.autostartVoteSub?.unsubscribe()
	ctx.vote.autostartVoteSub = null

	setLayerVoteState(ctx.vote, updatedVoteState)
	// not a release task, so the dashboard does not wait on the rcon broadcast and the app event
	ctx.vote.update$.next(update)
	registerVoteDeadlineAndReminder$(ctx)
	const message = ctx.tr.broadcast(
		V_Msgs.started(
			updatedVoteState.voterType,
			V.voteItemChoices(item, ctx.serverSettings.settings.vote.voteDisplayProps, updatedVoteState.choiceIds).map((c) => c.label),
			duration,
		),
	)
	const voteStarted = AppEvents.create<AppEvents.VoteStarted>({
		type: 'VOTE_STARTED',
		actor: initiatorActor(ctx, opts.initiator),
		serverId: ctx.serverId,
		matchId: currentMatch?.historyEntryId ?? null,
		causeId: null,
		vote: layerVoteSubject(ctx, item, updatedVoteState.choiceIds),
		choiceCount: item.choices.length,
		durationMs: duration,
		voterType: updatedVoteState.voterType,
	})
	await SquadServerActions.emitAppEvent(ctx, voteStarted)
	ctx.vote.startedEventId = voteStarted.id
	await broadcastVoteUpdate(ctx, updatedVoteState, message, voteStarted.id)

	return { code: 'ok' as const, voteStateUpdate: update }
})

export const handleVote = Instr.spanOp(
	'handleVote',
	{
		module,
		attrs: (_, msg) => ({ messageId: msg.message, playerUsername: msg.playerIds.username }),
	},
	(
		ctx: C.Db & SQS.Ctx & V.Ctx & LQ.Ctx & SR.Ctx.Rcon & SETTINGS.Ctx & CS.AbortSignal & CS.Deferred & Msgs.Ctx,
		msg: SM.RconEvents.ChatMessage,
	) => {
		//
		const choiceIdx = parseInt(msg.message.trim())
		const voteState = ctx.vote.state
		if (!voteState) {
			Instr.setSpanStatus(Otel.SpanStatusCode.ERROR, 'No vote in progress')
			return
		}
		if (voteState.voterType === 'internal' && msg.channelType !== 'ChatAdmin') {
			CS.defer(ctx, SquadRcon.warn(ctx, msg.playerIds, V_Msgs.wrongChat('AdminChat')))
			return
		}
		if (choiceIdx <= 0 || choiceIdx > voteState.choiceIds.length) {
			Instr.setSpanStatus(Otel.SpanStatusCode.ERROR, 'Invalid choice')
			CS.defer(ctx, SquadRcon.warn(ctx, msg.playerIds, V_Msgs.invalidChoice()))
			return
		}
		if (voteState.code !== 'in-progress') {
			CS.defer(ctx, SquadRcon.warn(ctx, msg.playerIds, V_Msgs.noVoteInProgress()))
			Instr.setSpanStatus(Otel.SpanStatusCode.ERROR, 'Vote not in progress')
			return
		}

		const choiceItemId = voteState.choiceIds[choiceIdx - 1]
		const cast: V.VoteCast = { playerIds: msg.playerIds, choice: choiceItemId }
		SM.PlayerIds.upsert(voteState.votes, ({ playerIds }) => playerIds, cast)
		const update: V.VoteStateUpdate = {
			state: voteState,
			cast,
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
				const [choice] = V.voteItemChoices(voteItem, ctx.serverSettings.settings.vote.voteDisplayProps, [choiceItemId])
				if (!choice) return
				await SquadRcon.warn(ctx, msg.playerIds, V_Msgs.voteCast(choice.label))
			})(),
		)
		Instr.setSpanStatus(Otel.SpanStatusCode.OK)
	},
)

const abortLayerVote = Instr.spanOp(
	'abortLayerVote',
	{ module },
	async (
		ctx: C.Db & SR.Ctx.Rcon & SQS.Ctx & MH.Ctx & V.Ctx & LQ.Ctx & SETTINGS.Ctx & CS.AbortSignal & Msgs.Ctx,
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
		setLayerVoteState(ctx.vote, null)
		ctx.vote.startedEventId = null
		ctx.vote.voteEndTask?.unsubscribe()
		ctx.vote.voteEndTask = null
		// not a release task, so the dashboard does not wait on the app event. Sent once the queue holds the result.
		try {
			await LayerQueue.dispatchOp(ctx, {
				op: 'set-vote-result',
				voteItemId: newVoteState.itemId,
				result: newVoteState,
				opId: SLL.createOpId(),
			})
		} finally {
			ctx.vote.update$.next(update)
		}

		const { item: abortedItem } = Obj.destrNullable(LL.findItemById(LayerQueue.getSavedQueue(ctx), newVoteState.itemId))
		const voteAborted = AppEvents.create<AppEvents.VoteAborted>({
			type: 'VOTE_ABORTED',
			actor: SquadServer.actorFromUser(ctx, opts.aborter),
			serverId: ctx.serverId,
			matchId: (await MatchHistory.getCurrentMatch(ctx))?.historyEntryId ?? null,
			causeId: null,
			vote:
				abortedItem && LL.isVoteItem(abortedItem)
					? layerVoteSubject(ctx, abortedItem, newVoteState.choiceIds)
					: { kind: 'layer', itemId: newVoteState.itemId },
			voterType: newVoteState.voterType,
		})
		await SquadServerActions.emitAppEvent(ctx, voteAborted)
		await broadcastVoteUpdate(ctx, newVoteState, ctx.tr.broadcast(V_Msgs.aborted()), voteAborted.id)

		return { code: 'ok' as const }
	},
)

export const cancelVoteAutostart = Instr.spanOp(
	'cancelVoteAutostart',
	{
		module,
		attrs: (_, opts) => ({ [ATTRS.Vote.CANCELLED_BY]: ATTRS.formatUserId(opts.user) }),
		mutexes: (ctx) => ctx.vote.mtx,
	},
	async (ctx: V.Ctx, opts: { user: USR.GuiOrChatUserId }) => {
		if (ctx.vote.state?.autostartCancelled) {
			return { code: 'err:autostart-already-cancelled' as const, msg: 'Vote is already cancelled' }
		}
		if (!ctx.vote.state || ctx.vote.state.code !== 'ready' || !ctx.vote.state.autostartTime) {
			return { code: 'err:vote-not-queued' as const, msg: 'No vote is currently scheduled' }
		}

		ctx.vote.autostartVoteSub?.unsubscribe()
		ctx.vote.autostartVoteSub = null

		const newVoteState = Obj.deepClone(ctx.vote.state)
		newVoteState.autostartCancelled = true
		delete newVoteState.autostartTime
		setLayerVoteState(ctx.vote, newVoteState)

		addReleaseTask(() => {
			ctx.vote.update$.next({
				source: { type: 'manual', user: opts.user, event: 'autostart-cancelled' },
				state: ctx.vote.state,
			})
		})
		return { code: 'ok' as const }
	},
)

// The reminders and the deadline of a running vote, as one subscription. Each callback is handed a ctx resolved for its
// own run, and returns early when the vote it was scheduled for is gone.
type EndVoteCtx = C.Db & SQS.Ctx & V.Ctx & LQ.Ctx & MH.Ctx & SR.Ctx.Rcon & SETTINGS.Ctx & CS.AbortSignal & Msgs.Ctx

// The running vote, when it is the one the caller named. One that ended or was replaced since the caller looked is
// refused rather than acted on in its place.
function namedRunningVote(
	ctx: V.Ctx & Msgs.Ctx,
	voteId: string,
): { code: 'ok'; kind: V.RunningVote } | { code: 'err:no-vote-in-progress' | 'err:vote-changed'; msg: string } {
	const kind = V.runningVote(ctx.vote)
	if (!kind) return { code: 'err:no-vote-in-progress' as const, msg: ctx.tr.text(V_Msgs.noVoteInProgress()) }
	if (V.runningVoteId(ctx.vote) !== voteId) return { code: 'err:vote-changed' as const, msg: ctx.tr.text(V_Msgs.voteChanged()) }
	return { code: 'ok' as const, kind }
}

/** Ends the running vote named by `voteId`, layer or simple, and announces its result. */
export const endVote = Instr.spanOp(
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
		ctx: EndVoteCtx,
		opts: { voteId: string } & ({ reason: 'vote-timeout' } | { reason: 'ended-early'; endedBy: USR.GuiOrChatUserId }),
	) => {
		const running = namedRunningVote(ctx, opts.voteId)
		if (running.code !== 'ok') return running
		switch (running.kind) {
			case 'layer':
				return await endLayerVote(ctx, opts)
			case 'simple':
				return await endSimpleVote(ctx, opts)
			default:
				assertNever(running.kind)
		}
	},
)

/** Aborts the running vote named by `voteId`, layer or simple, without a result. */
export const abortVote = Instr.spanOp(
	'abortVote',
	{
		module,
		levels: { event: 'info' },
		attrs: (_, opts) => ({ [ATTRS.Vote.ABORTER]: ATTRS.formatUserId(opts.aborter) }),
		mutexes: (ctx) => ctx.vote.mtx,
	},
	async (ctx: EndVoteCtx, opts: { voteId: string; aborter: USR.GuiOrChatUserId }) => {
		const running = namedRunningVote(ctx, opts.voteId)
		if (running.code !== 'ok') return running
		switch (running.kind) {
			case 'layer':
				return await abortLayerVote(ctx, opts)
			case 'simple':
				return await abortSimpleVote(ctx, opts)
			default:
				assertNever(running.kind)
		}
	},
)

function scheduleVoteTimers(
	ctx: SETTINGS.Ctx,
	opts: {
		deadline: number
		voterType: V.VoterType
		label: string
		remind: (timeLeft: number, finalReminder: boolean, signal: AbortSignal) => Promise<void>
		end: () => Promise<void>
	},
) {
	const sub = new Rx.Subscription()
	const currentTime = Date.now()
	const settings = ctx.serverSettings.settings.vote
	const finalReminderWaitTime = Math.max(0, opts.deadline - settings.finalVoteReminder - currentTime)
	const regularReminderInterval = opts.voterType === 'internal' ? settings.internalVoteReminderInterval : settings.voteReminderInterval
	const finalReminderBuffer = finalReminderWaitTime - regularReminderInterval

	sub.add(
		Rx.interval(regularReminderInterval)
			.pipe(
				Rx.takeUntil(Rx.timer(finalReminderBuffer)),
				Instr.durableSub(`regular-${opts.label}-reminders`, { module }, async (_, signal) => {
					await opts.remind(opts.deadline - Date.now(), false, signal)
				}),
			)
			.subscribe(),
	)

	if (finalReminderWaitTime > 0) {
		sub.add(
			Rx.timer(finalReminderWaitTime)
				.pipe(
					Instr.durableSub(`final-${opts.label}-reminder`, { module }, async (_, signal) => {
						await opts.remind(settings.finalVoteReminder, true, signal)
					}),
				)
				.subscribe(),
		)
	}

	sub.add(
		Rx.timer(Math.max(opts.deadline - currentTime, 0)).subscribe({
			next: async () => {
				await opts.end()
			},
			complete: () => {
				log.info('%s deadline reached', opts.label)
			},
		}),
	)
	return sub
}

function registerVoteDeadlineAndReminder$(ctx: C.Db & SQS.Ctx & V.Ctx & SETTINGS.Ctx) {
	const serverId = ctx.serverId
	ctx.vote.voteEndTask?.unsubscribe()
	ctx.vote.voteEndTask = null

	if (!ctx.vote.state || ctx.vote.state.code !== 'in-progress') return
	const voteId = ctx.vote.state.voteId
	ctx.vote.voteEndTask = scheduleVoteTimers(ctx, {
		deadline: ctx.vote.state.deadline,
		voterType: ctx.vote.state.voterType,
		label: 'vote',
		remind: async (timeLeft, finalReminder, signal) => {
			const ctx = SquadServer.resolveCtx({ ...getBaseCtx(), signal }, serverId)
			if (V.runningVoteId(ctx.vote) !== voteId || ctx.vote.state?.code !== 'in-progress') return
			const serverState = SquadServer.getServerState(ctx)
			if (!SETTINGS.remindersEnabled(serverState.settings)) return
			const { item: voteItem } = Obj.destrNullable(LL.findItemById(serverState.layerQueue, ctx.vote.state.itemId))
			if (!voteItem || !LL.isVoteItem(voteItem)) return
			const msg = ctx.tr.broadcast(
				V_Msgs.voteReminder(
					V.voteItemChoices(voteItem, ctx.serverSettings.settings.vote.voteDisplayProps, ctx.vote.state.choiceIds).map((c) => c.label),
					timeLeft,
					finalReminder,
				),
			)
			await broadcastVoteUpdate(ctx, ctx.vote.state, msg, ctx.vote.startedEventId, { onlyNotifyNonVotingAdmins: true })
		},
		end: async () => {
			await endVote(SquadServer.resolveCtx(getBaseCtx(), serverId), { voteId, reason: 'vote-timeout' })
		},
	})
}

const endLayerVote = Instr.spanOp(
	'endLayerVote',
	{ module },
	async (
		ctx: C.Db & SQS.Ctx & V.Ctx & LQ.Ctx & MH.Ctx & SR.Ctx.Rcon & SETTINGS.Ctx & CS.AbortSignal & Msgs.Ctx,
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
		let winnerLayerId: L.LayerId | null = null
		if (Object.values(ctx.vote.state.votes).length === 0) {
			endingVoteState = {
				code: 'ended:insufficient-votes',
				endedEarly: opts.reason === 'ended-early' ? opts.endedBy : undefined,
				...Obj.selectProps(ctx.vote.state, ['choiceIds', 'itemId', 'deadline', 'votes', 'voterType']),
			}
		} else {
			const serverInfoRes = await ctx.squadRcon.serverInfo.get(ctx, { ttl: 0 })
			if (serverInfoRes.code !== 'ok') return serverInfoRes

			const serverInfo = serverInfoRes.data

			tally = V.tallyVotes(ctx.vote.state, serverInfo.playerCount)
			Instr.setSpanOpAttrs({ tally })

			const winnerId = tally.leaders[Math.floor(Math.random() * tally.leaders.length)]
			const winnerChoice = listItem.choices.find((c) => c.itemId === winnerId)
			endingVoteState = {
				code: 'ended:winner',
				endedEarly: opts.reason === 'ended-early' ? opts.endedBy : undefined,
				...Obj.selectProps(ctx.vote.state, ['choiceIds', 'itemId', 'deadline', 'votes', 'voterType']),
				winnerId,
			}
			// listItem is the saved queue's own object, so it is not written to: set-vote-result derives the winning
			// layerId itself, and a write here would reach the QUEUE_UPDATED prevList, which then fails to parse
			winnerLayerId = winnerChoice?.layerId ?? null
		}

		setLayerVoteState(ctx.vote, null)
		const update: V.VoteStateUpdate = {
			state: null,
			source: { type: 'system', event: opts.reason },
		}
		// not a release task, so the dashboard does not wait on the rcon broadcasts. Sent once the queue holds the result.
		try {
			await LayerQueue.dispatchOp(ctx, {
				op: 'set-vote-result',
				opId: SLL.createOpId(),
				result: endingVoteState,
				voteItemId: endingVoteState.itemId,
			})
		} finally {
			ctx.vote.update$.next(update)
		}

		const choices = V.voteItemChoices(listItem, ctx.serverSettings.settings.vote.voteDisplayProps, endingVoteState.choiceIds)
		const voteEnded = AppEvents.create<AppEvents.VoteEnded>({
			type: 'VOTE_ENDED',
			actor: SquadServer.actorFromUser(ctx, opts.reason === 'ended-early' ? opts.endedBy : undefined),
			serverId: ctx.serverId,
			matchId: (await MatchHistory.getCurrentMatch(ctx))?.historyEntryId ?? null,
			causeId: null,
			vote: {
				...layerVoteSubject(ctx, listItem, endingVoteState.choiceIds),
				winnerLayerId,
				winnerLabel:
					endingVoteState.code === 'ended:winner' ? choices.find((c) => c.id === endingVoteState.winnerId)?.label : undefined,
				// the tally is keyed by queue item id, which means nothing once the item is gone: resolve it to layers
				tally: tally
					? listItem.choices.map((choice) => ({ layerId: choice.layerId, votes: tally!.totals.get(choice.itemId) ?? 0 }))
					: undefined,
			},
			reason: opts.reason,
			totalVotes: tally?.totalVotes,
			turnoutPercentage: tally?.turnoutPercentage,
			voterType: endingVoteState.voterType,
		})
		await SquadServerActions.emitAppEvent(ctx, voteEnded)
		ctx.vote.startedEventId = null
		if (endingVoteState.code === 'ended:winner') {
			await broadcastVoteUpdate(
				ctx,
				endingVoteState,
				ctx.tr.broadcast(V_Msgs.winnerSelected(tally!, choices, endingVoteState.winnerId, opts.reason === 'ended-early')),
				voteEnded.id,
			)
		}
		if (endingVoteState.code === 'ended:insufficient-votes') {
			await broadcastVoteUpdate(ctx, endingVoteState, ctx.tr.broadcast(V_Msgs.insufficientVotes(choices[0]?.label)), voteEnded.id)
		}
		return { code: 'ok' as const, endingVoteState, tally }
	},
)

// What a vote's app events record about a layer vote: its item, and its choices as layers and as players saw them.
function layerVoteSubject(ctx: SETTINGS.Ctx, item: LL.VoteItem, choiceIds: string[]) {
	const choices = V.voteItemChoices(item, ctx.serverSettings.settings.vote.voteDisplayProps, choiceIds)
	return {
		kind: 'layer' as const,
		itemId: item.itemId,
		choices: choiceIds.flatMap((id) => item.choices.find((c) => c.itemId === id)?.layerId ?? []),
		labels: choices.map((c) => c.label),
	}
}

function simpleVoteSubject(state: V.SimpleVote.State) {
	return { kind: 'simple' as const, voteId: state.voteId, choices: state.choices }
}

// -------- simple votes --------

type SimpleVoteCtx = C.Db & SQS.Ctx & SR.Ctx.Rcon & V.Ctx & MH.Ctx & SETTINGS.Ctx & CS.AbortSignal & Msgs.Ctx

const startSimpleVote = Instr.spanOp('startSimpleVote', { module }, async (ctx: SimpleVoteCtx, opts: StartSimpleVoteOpts) => {
	const choicesError = V.SimpleVote.validateChoices(opts.choices)
	if (choicesError) return { code: choicesError.code, msg: ctx.tr.text(V_Msgs.simpleChoicesError(choicesError)) }

	const duration = opts.duration ?? ctx.serverSettings.settings.vote.voteDuration
	const state: V.SimpleVote.InProgress = {
		code: 'in-progress',
		voteId: createId(16),
		voterType: opts.voterType ?? 'public',
		choices: opts.choices,
		votes: [],
		deadline: Date.now() + duration,
		initiator: opts.initiator,
	}
	setSimpleVoteState(ctx.vote, state)
	ctx.vote.simple.update$.next({ code: 'state', state })
	registerSimpleVoteDeadline(ctx)

	const started = AppEvents.create<AppEvents.VoteStarted>({
		type: 'VOTE_STARTED',
		actor: initiatorActor(ctx, opts.initiator),
		serverId: ctx.serverId,
		matchId: (await MatchHistory.getCurrentMatch(ctx))?.historyEntryId ?? null,
		causeId: null,
		vote: simpleVoteSubject(state),
		choiceCount: state.choices.length,
		durationMs: duration,
		voterType: state.voterType,
	})
	await SquadServerActions.emitAppEvent(ctx, started)
	ctx.vote.simple.startedEventId = started.id
	await broadcastVoteUpdate(ctx, state, ctx.tr.broadcast(V_Msgs.simple.started(state.voterType, state.choices, duration)), started.id)
	return { code: 'ok' as const }
})

export const handleSimpleVote = Instr.spanOp(
	'handleSimpleVote',
	{
		module,
		attrs: (_, msg) => ({ messageId: msg.message, playerUsername: msg.playerIds.username }),
	},
	(ctx: SQS.Ctx & V.Ctx & SR.Ctx.Rcon & CS.AbortSignal & CS.Deferred & Msgs.Ctx, msg: SM.RconEvents.ChatMessage) => {
		const state = ctx.vote.simple.state
		if (state?.code !== 'in-progress') {
			Instr.setSpanStatus(Otel.SpanStatusCode.ERROR, 'No simple vote in progress')
			return
		}
		if (state.voterType === 'internal' && msg.channelType !== 'ChatAdmin') {
			CS.defer(ctx, SquadRcon.warn(ctx, msg.playerIds, V_Msgs.wrongChat('AdminChat')))
			return
		}
		const choiceIdx = parseInt(msg.message.trim())
		const choice = state.choices[choiceIdx - 1]
		if (choiceIdx <= 0 || choice === undefined) {
			Instr.setSpanStatus(Otel.SpanStatusCode.ERROR, 'Invalid choice')
			CS.defer(ctx, SquadRcon.warn(ctx, msg.playerIds, V_Msgs.invalidChoice()))
			return
		}
		const cast: V.VoteCast = { playerIds: msg.playerIds, choice }
		SM.PlayerIds.upsert(state.votes, ({ playerIds }) => playerIds, cast)
		ctx.vote.simple.update$.next({ code: 'cast', voteId: state.voteId, cast })
		CS.defer(ctx, SquadRcon.warn(ctx, msg.playerIds, V_Msgs.voteCast(choice)))
		Instr.setSpanStatus(Otel.SpanStatusCode.OK)
	},
)

const endSimpleVote = Instr.spanOp(
	'endSimpleVote',
	{ module },
	async (ctx: SimpleVoteCtx, opts: { reason: 'vote-timeout' } | { reason: 'ended-early'; endedBy: USR.GuiOrChatUserId }) => {
		const state = ctx.vote.simple.state
		if (state?.code !== 'in-progress') return { code: 'err:no-vote-in-progress' as const, msg: ctx.tr.text(V_Msgs.noVoteInProgress()) }
		const endedEarly = opts.reason === 'ended-early' ? opts.endedBy : undefined

		let tally: V.Tally | null = null
		let ended: V.SimpleVote.Ended
		if (state.votes.length === 0) {
			ended = { ...state, code: 'ended:insufficient-votes', endedEarly, endedAt: Date.now() }
		} else {
			const serverInfoRes = await ctx.squadRcon.serverInfo.get(ctx, { ttl: 0 })
			if (serverInfoRes.code !== 'ok') return serverInfoRes
			tally = V.SimpleVote.tally(state, serverInfoRes.data.playerCount)
			Instr.setSpanOpAttrs({ tally })
			const winner = tally.leaders[Math.floor(Math.random() * tally.leaders.length)]
			ended = { ...state, code: 'ended:winner', winner, endedEarly, endedAt: Date.now() }
		}
		ctx.vote.simple.endTask?.unsubscribe()
		ctx.vote.simple.endTask = null
		setSimpleVoteState(ctx.vote, ended)
		ctx.vote.simple.update$.next({ code: 'state', state: ended })

		const endedEvent = AppEvents.create<AppEvents.VoteEnded>({
			type: 'VOTE_ENDED',
			actor: SquadServer.actorFromUser(ctx, endedEarly),
			serverId: ctx.serverId,
			matchId: (await MatchHistory.getCurrentMatch(ctx))?.historyEntryId ?? null,
			causeId: null,
			vote: {
				...simpleVoteSubject(state),
				winner: ended.code === 'ended:winner' ? ended.winner : null,
				tally: state.choices.map((choice) => ({ choice, votes: tally?.totals.get(choice) ?? 0 })),
			},
			reason: opts.reason,
			totalVotes: state.votes.length,
			turnoutPercentage: tally?.turnoutPercentage,
			voterType: state.voterType,
		})
		await SquadServerActions.emitAppEvent(ctx, endedEvent)
		ctx.vote.simple.startedEventId = null
		const msg =
			ended.code === 'ended:winner'
				? V_Msgs.winnerSelected(tally!, V.simpleVoteView(state).choices, ended.winner, opts.reason === 'ended-early')
				: V_Msgs.insufficientVotes()
		await broadcastVoteUpdate(ctx, ended, ctx.tr.broadcast(msg), endedEvent.id)
		return { code: 'ok' as const }
	},
)

const abortSimpleVote = Instr.spanOp('abortSimpleVote', { module }, async (ctx: SimpleVoteCtx, opts: { aborter: USR.GuiOrChatUserId }) => {
	const state = ctx.vote.simple.state
	if (state?.code !== 'in-progress') return { code: 'err:no-vote-in-progress' as const, msg: ctx.tr.text(V_Msgs.noVoteInProgress()) }
	const aborted: V.SimpleVote.Ended = { ...state, code: 'ended:aborted', aborter: opts.aborter, endedAt: Date.now() }
	ctx.vote.simple.endTask?.unsubscribe()
	ctx.vote.simple.endTask = null
	setSimpleVoteState(ctx.vote, aborted)
	ctx.vote.simple.startedEventId = null
	ctx.vote.simple.update$.next({ code: 'state', state: aborted })

	const abortedEvent = AppEvents.create<AppEvents.VoteAborted>({
		type: 'VOTE_ABORTED',
		actor: SquadServer.actorFromUser(ctx, opts.aborter),
		serverId: ctx.serverId,
		matchId: (await MatchHistory.getCurrentMatch(ctx))?.historyEntryId ?? null,
		causeId: null,
		vote: simpleVoteSubject(state),
		voterType: state.voterType,
	})
	await SquadServerActions.emitAppEvent(ctx, abortedEvent)
	await broadcastVoteUpdate(ctx, aborted, ctx.tr.broadcast(V_Msgs.aborted()), abortedEvent.id)
	return { code: 'ok' as const }
})

function registerSimpleVoteDeadline(ctx: SQS.Ctx & V.Ctx & SETTINGS.Ctx) {
	const serverId = ctx.serverId
	ctx.vote.simple.endTask?.unsubscribe()
	ctx.vote.simple.endTask = null
	const state = ctx.vote.simple.state
	if (state?.code !== 'in-progress') return
	ctx.vote.simple.endTask = scheduleVoteTimers(ctx, {
		deadline: state.deadline,
		voterType: state.voterType,
		label: 'simple-vote',
		remind: async (timeLeft, finalReminder, signal) => {
			const ctx = SquadServer.resolveCtx({ ...getBaseCtx(), signal }, serverId)
			const current = ctx.vote.simple.state
			if (current?.code !== 'in-progress' || current.voteId !== state.voteId) return
			if (!SETTINGS.remindersEnabled(SquadServer.getServerState(ctx).settings)) return
			const msg = ctx.tr.broadcast(V_Msgs.voteReminder(current.choices, timeLeft, finalReminder))
			await broadcastVoteUpdate(ctx, current, msg, ctx.vote.simple.startedEventId, { onlyNotifyNonVotingAdmins: true })
		},
		end: async () => {
			await endVote(SquadServer.resolveCtx(getBaseCtx(), serverId), { voteId: state.voteId, reason: 'vote-timeout' })
		},
	})
}

// Announces a vote of either kind to its voters: the server for a public vote, the admins in game for an internal one.
async function broadcastVoteUpdate(
	ctx: SQS.Ctx & SR.Ctx.Rcon & CS.AbortSignal & Msgs.Ctx,
	voteState: { voterType: V.VoterType; votes?: V.VoteCast[] },
	msg: string,
	// the vote's app event, which the broadcast the server logs folds under in the feed
	attributeTo: AppEvents.AppEventId | null,
	opts?: { onlyNotifyNonVotingAdmins?: boolean },
) {
	switch (voteState.voterType) {
		case 'public':
			if (attributeTo) await SquadServerActions.attributeBroadcast(ctx, msg, attributeTo)
			await SquadRcon.broadcast(ctx, msg)
			break
		case 'internal':
			{
				await SquadRcon.warnAllAdmins(ctx, ({ player }) => {
					if (!opts?.onlyNotifyNonVotingAdmins) return msg
					if (!voteState.votes) return
					if (SM.PlayerIds.find(voteState.votes, ({ playerIds }) => playerIds, player.ids)) return
					return msg
				})
			}
			break
		default:
			assertNever(voteState.voterType)
	}
}

// every watcher is handed the same update object, so the user lookup runs once per update rather than once per watcher
const sharedUpdateParts = new WeakMap<V.VoteStateUpdate, ReturnType<typeof includeVoteStateUpdatePart>>()
function includeVoteStateUpdatePartShared(
	update: V.VoteStateUpdate,
): Promise<(V.VoteStateUpdate & Parts<USR.UserPart>) | V.VoteCastUpdate> {
	// a cast names no SLM user, so there is nothing to look up
	if (update.cast) return Promise.resolve({ cast: update.cast, source: update.source })
	let withParts = sharedUpdateParts.get(update)
	if (!withParts) {
		withParts = includeVoteStateUpdatePart(getBaseCtx(), update)
		sharedUpdateParts.set(update, withParts)
	}
	return withParts
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
	const dbUsers = Users.getDbUsers(ctx, discordIdsArray)
	const users = await Users.buildUsers(dbUsers)
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
			if (typeof state.initiator === 'object' && !V.isPluginInitiator(state.initiator) && state.initiator.discordId) {
				discordIds.push(state.initiator.discordId)
			}
			break
		}
		default:
			assertNever(state)
	}
	return discordIds
}

function getBaseCtx() {
	return C.initMutexStore(DB.withDb({ ...CS.init(), signal: CleanupSys.shutdownSignal }))
}
