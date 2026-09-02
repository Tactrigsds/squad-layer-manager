// Runs the player-initiated switch queue (see models/switch-requests.models.ts for the rules). Every entry point
// funnels through pass(): apply a mutation, sweep in-flight switches, plan against the live roster, fire what the
// plan allows, then persist and notify. The queue is persisted per match in the servers table so an SLM restart
// mid-match keeps it; it resets on every roll.
import * as Otel from '@opentelemetry/api'
import { Mutex } from 'async-mutex'

import * as Arr from '@/lib/array-utils'
import { IsolatedSubject } from '@/lib/isolated-subject'
import * as Rx from '@/lib/rxjs'
import { assertNever } from '@/lib/type-guards'
import { z } from '@/lib/zod'
import * as SRQ_Msgs from '@/messages/switch-requests.messages'
import * as AppEvents from '@/models/app-events.models'
import type * as CS from '@/models/context-shared'
import * as ATTRS from '@/models/otel-attrs'
import * as PendingEvents from '@/models/pending-events.models'
import * as SE from '@/models/server-events.models'
import type * as SR from '@/models/squad-rcon.models'
import type * as SQS from '@/models/squad-server.models'
import * as SM from '@/models/squad.models'
import * as SRQ from '@/models/switch-requests.models'
import * as TSW from '@/models/teamswaps.models'
import * as RBAC from '@/rbac.models'
import type * as C from '@/server/context'
import * as DB from '@/server/db'
import * as Instr from '@/server/instrumentation'
import { initModule } from '@/server/logger'
import { getOrpcBase } from '@/server/orpc-base'
import * as MatchHistory from '@/systems/match-history.server'
import * as Rbac from '@/systems/rbac.server'
import * as SquadRcon from '@/systems/squad-rcon.server'
import * as SquadServer from '@/systems/squad-server.server'

export const module = initModule('switchRequests')

let log!: CS.Logger

export function setup() {
	log = module.getLogger()
}

// What the queue did, for the dashboard. The counters answer "how much of this is happening and how is it
// resolving"; the wait histogram answers "how long does asking actually cost a player", which is the number that
// says whether instantSwapLead is set sensibly. Queue depth is a gauge, in metrics.server.ts.
const meter = Otel.metrics.getMeter('switch-requests')

const receivedCounter = meter.createCounter(ATTRS.SwitchRequest.RECEIVED, {
	description: 'Switch requests received, by how the command answered them',
})

const fulfilledCounter = meter.createCounter(ATTRS.SwitchRequest.FULFILLED, {
	description: 'Switch requests fulfilled, by the rule that drained them',
})

const droppedCounter = meter.createCounter(ATTRS.SwitchRequest.DROPPED, {
	description: 'Queued switch requests that left the queue without being fulfilled, by reason',
})

const waitHistogram = meter.createHistogram(ATTRS.SwitchRequest.WAIT, {
	description: 'How long a fulfilled switch request waited in the queue',
	unit: 's',
	advice: {
		// a wait spans an immediate swap (sub-second, one poll) to most of a match for a queue that never
		// drains, so the boundaries are spread over minutes rather than the SDK's millisecond-shaped defaults
		explicitBucketBoundaries: [1, 5, 15, 30, 60, 120, 300, 600, 1200, 1800, 3600],
	},
})

// how hard the roster is polled while requests are waiting; the default cadence (rconCacheTTL.teams) applies otherwise
const ACTIVE_POLL_TTL_MS = 1_000
// a fired switch that hasn't shown up in the roster after this long is re-fired
const RETRY_DELAY_MS = 10_000
const MAX_SWITCH_ATTEMPTS = 3

type PassCtx = SRQ.Ctx & C.ManagedServer & C.Db

export function initContext(ctx: SQS.Ctx & SR.Ctx & C.Db & C.ManagedServerCleanup & CS.AbortSignal) {
	const context: SRQ.Ctx.Payload = {
		state: SRQ.initState(),
		update$: new IsolatedSubject<SRQ.UpdateForClient>(),
		mutex: new Mutex(),
		pendingPlacement: new Set(),
		swapping: new Map(),
		haveReadFromDb: false,
	}
	ctx.cleanup.push(context.update$, context.mutex)

	ctx.cleanup.push(
		ctx.server.event$
			.pipe(
				Rx.filter(
					([, e]) => Arr.includesEnum(PendingEvents.TeamModifyingEventTypes.options, e.type) || e.type === 'TEAMS_POLLED_UPDATE',
				),
				Instr.durableSub('onTeamsModified', { module }, async ([evtCtx, e], signal) => {
					const ctx = SquadServer.eventCtx(evtCtx, signal)
					const sr = ctx.switchRequests
					if (!Arr.includesEnum(PendingEvents.TeamModifyingEventTypes.options, e.type) && e.type !== 'TEAMS_POLLED_UPDATE') return
					if (e.type === 'PLAYER_CONNECTED') {
						const playerId = SM.PlayerIds.getPlayerId(e.player.ids)
						if (e.player.teamId === null) {
							sr.pendingPlacement.add(playerId)
							return
						}
						await pass(ctx, { connector: connectorFor(sr, playerId, e.player.teamId) })
					} else if (e.type === 'PLAYER_RECONCILED') {
						// a roster backfill of a player who was already present: not a fresh arrival, so never a connector
						sr.pendingPlacement.delete(SM.PlayerIds.getPlayerId(e.player.ids))
						await pass(ctx)
					} else if (e.type === 'PLAYER_CHANGED_TEAM') {
						const placed = e.newTeamId != null && sr.pendingPlacement.delete(e.player)
						await pass(ctx, { connector: placed ? connectorFor(sr, e.player, e.newTeamId!) : undefined })
					} else if (e.type === 'PLAYER_DISCONNECTED') {
						sr.pendingPlacement.delete(e.player)
						await pass(ctx, {
							mutate: (state) => {
								state.disconnectedThisMatch.add(e.player)
								const index = state.requests.findIndex((r) => r.playerId === e.player)
								if (index < 0) return
								state.requests.splice(index, 1)
								// dropping it here rather than leaving it to the planner's prune means the planner never
								// sees it, so this is the only place the departure can be counted
								droppedCounter.add(1, { [ATTRS.SquadServer.ID]: ctx.serverId, [ATTRS.SwitchRequest.REASON]: 'disconnected' })
							},
						})
					} else if (e.type === 'NEW_GAME') {
						// only a real roll resets the queue: an 'slm-started' NEW_GAME fires on boot, before the saved
						// queue for the still-current match has been restored (see the RESET arm)
						if (SE.newGameIsRoll(e.source)) await clearForNewGame(ctx)
					} else if (e.type === 'RESET') {
						if (!SE.eventRoster(e)) return
						if (!sr.haveReadFromDb) {
							sr.haveReadFromDb = true
							const match = await MatchHistory.getMatchById(ctx, e.matchId)
							const saved = (await SquadServer.getServerState(ctx)).switchRequests
							if (saved && match && saved.matchHistoryEntryId === match.historyEntryId) {
								await pass(ctx, {
									mutate: (state) => {
										state.requests = [...saved.requests]
										state.disconnectedThisMatch = new Set(saved.disconnected)
									},
								})
								return
							}
						}
						await pass(ctx)
					} else if (e.type === 'TEAMS_POLLED_UPDATE') {
						await pass(ctx)
					} else {
						assertNever(e.type)
					}
				}),
			)
			.subscribe(),
	)

	// Latency: while anything is queued or in flight, hold a low-ttl observer on the shared teams resource. The
	// refetch loop polls at the smallest observer ttl, so this tightens the one deduped ListPlayers cadence, and the
	// regular poll pipeline turns each poll into the events the subscription above reconciles on.
	ctx.cleanup.push(
		context.update$
			.pipe(
				Rx.map((update) => update.requests.length > 0 || update.swapping.length > 0),
				Rx.startWith(false),
				Rx.distinctUntilChanged(),
				Rx.switchMap((active) => (active ? ctx.squadRcon.teams.observe(ctx, { ttl: ACTIVE_POLL_TTL_MS }) : Rx.EMPTY)),
			)
			.subscribe(),
	)

	return context
}

function connectorFor(sr: SRQ.Ctx.Payload, playerId: SM.PlayerId, teamId: SM.TeamId) {
	return sr.state.disconnectedThisMatch.has(playerId) ? undefined : { playerId, teamId }
}

function emitUpdate(ctx: SRQ.Ctx) {
	const sr = ctx.switchRequests
	sr.update$.next({ requests: [...sr.state.requests], swapping: [...sr.swapping.keys()] })
}

async function persist(ctx: PassCtx) {
	const state = ctx.switchRequests.state
	const empty = state.requests.length === 0 && state.disconnectedThisMatch.size === 0
	const saved = empty
		? null
		: {
				requests: state.requests,
				disconnected: [...state.disconnectedThisMatch],
				matchHistoryEntryId: (await MatchHistory.getCurrentMatch(ctx)).historyEntryId,
			}
	await DB.runTransaction(ctx, { redactParams: true }, async (ctx) => {
		await SquadServer.updateServerState(ctx, { switchRequests: saved }, { type: 'system', event: 'switch-requests-saved' })
	})
}

type PassOpts = {
	mutate?: (state: SRQ.State) => void
	connector?: { playerId: SM.PlayerId; teamId: SM.TeamId }
	// who a fulfillment fired by this pass is attributed to; the queue draining on its own is the system's doing
	actor?: AppEvents.Actor
}

const pass = Instr.spanOp(
	'pass',
	{ module, mutexes: (ctx) => ctx.switchRequests.mutex, levels: { event: 'debug' } },
	(ctx: PassCtx, opts?: PassOpts) => passLocked(ctx, opts),
)

function recordWait(ctx: SRQ.Ctx, requestedAt: number | undefined, now: number, via: ATTRS.SwitchRequest.Via) {
	if (requestedAt === undefined) return
	waitHistogram.record(Math.max(0, now - requestedAt) / 1000, {
		[ATTRS.SquadServer.ID]: ctx.serverId,
		[ATTRS.SwitchRequest.VIA]: via,
	})
}

// the single reconcile step, mutex held by the caller
async function passLocked(ctx: PassCtx, opts?: PassOpts) {
	const sr = ctx.switchRequests
	const requestsBefore = sr.state.requests.slice()
	const positionsBefore = SRQ.positions(requestsBefore)
	const disconnectedSizeBefore = sr.state.disconnectedThisMatch.size
	const swappingKeysBefore = [...sr.swapping.keys()].join(',')

	opts?.mutate?.(sr.state)

	const now = Date.now()
	const players = SquadServer.getCurrTeams(ctx)?.players
	const roster = players ? SRQ.rosterOf([...players.values()]) : null

	// in-flight sweep: clear what landed (or left), re-fire what stalled, give up on what keeps failing
	const failed: SM.PlayerId[] = []
	const refires: { playerId: SM.PlayerId; causeId: string }[] = []
	if (roster) {
		for (const [playerId, inflight] of sr.swapping) {
			const teamId = roster.get(playerId)
			if (teamId === undefined || teamId === inflight.toTeam) {
				sr.swapping.delete(playerId)
				continue
			}
			if (now - inflight.firedAt < RETRY_DELAY_MS) continue
			if (inflight.attempts >= MAX_SWITCH_ATTEMPTS) {
				sr.swapping.delete(playerId)
				failed.push(playerId)
				log.error('switch request for %s never landed after %d attempts, giving up', playerId, inflight.attempts)
				continue
			}
			inflight.attempts++
			inflight.firedAt = now
			refires.push({ playerId, causeId: inflight.causeId })
		}
	}

	// a teamswap execution in flight owns the board; the next poll re-enters here once it resolves
	let planned: SRQ.Plan | undefined
	if (roster && !ctx.teamswaps.session.state.swapping) {
		planned = SRQ.plan({
			requests: sr.state.requests,
			roster,
			instantSwapLead: ctx.serverSettings.settings.switchRequests.instantSwapLead,
			swapping: new Set(sr.swapping.keys()),
			connector: opts?.connector,
		})
		sr.state.requests = planned.requests
	}

	// requestedAt is only on the pre-plan queue, so the wait of anything fulfilled or dropped below is read here
	const requestedAt = new Map(requestsBefore.map((r) => [r.playerId, r.requestedAt]))

	let movedConnector: SM.PlayerId | undefined
	if (planned && planned.swaps.length > 0) {
		const targets = planned.swaps.map((s) => s.playerId)
		movedConnector = planned.swaps.find((s) => s.via === 'connector' && !planned!.fulfilled.includes(s.playerId))?.playerId
		const appEvent = AppEvents.create<AppEvents.SwitchRequestsFulfilled>({
			type: 'SWITCH_REQUESTS_FULFILLED',
			actor: opts?.actor ?? { type: 'system' },
			serverId: ctx.serverId,
			matchId: (await MatchHistory.getCurrentMatch(ctx)).historyEntryId,
			causeId: null,
			targets: planned.fulfilled,
			movedConnector,
		})
		await SquadServer.emitAppEvent(ctx, appEvent)
		await SquadServer.armTeamChangeAttribution(ctx, targets, appEvent.id)
		for (const swap of planned.swaps) {
			sr.swapping.set(swap.playerId, { toTeam: swap.toTeam, via: swap.via, firedAt: now, attempts: 1, causeId: appEvent.id })
			// the connector's own move is not a fulfilled request, so it is not counted as one
			if (!planned.fulfilled.includes(swap.playerId)) continue
			fulfilledCounter.add(1, { [ATTRS.SquadServer.ID]: ctx.serverId, [ATTRS.SwitchRequest.VIA]: swap.via })
			recordWait(ctx, requestedAt.get(swap.playerId), now, swap.via)
		}
		await SquadRcon.switchPlayers(ctx, targets)
	}
	if (refires.length > 0) {
		for (const refire of refires) {
			// the same switch, already logged: only re-arm attribution for the events the re-fire produces
			await SquadServer.armTeamChangeAttribution(ctx, [refire.playerId], refire.causeId)
		}
		await SquadRcon.switchPlayers(
			ctx,
			refires.map((r) => r.playerId),
		)
	}

	for (const removal of planned?.removed ?? []) {
		droppedCounter.add(1, { [ATTRS.SquadServer.ID]: ctx.serverId, [ATTRS.SwitchRequest.REASON]: removal.reason })
	}
	if (failed.length > 0) {
		droppedCounter.add(failed.length, { [ATTRS.SquadServer.ID]: ctx.serverId, [ATTRS.SwitchRequest.REASON]: 'failed' })
	}

	const requestsChanged =
		sr.state.requests.length !== requestsBefore.length || sr.state.requests.some((r, i) => r.playerId !== requestsBefore[i].playerId)
	const disconnectedChanged = sr.state.disconnectedThisMatch.size !== disconnectedSizeBefore
	if (requestsChanged || disconnectedChanged) await persist(ctx)
	if (requestsChanged || swappingKeysBefore !== [...sr.swapping.keys()].join(',')) emitUpdate(ctx)

	// notifications last, once the state they describe is committed
	if (planned && planned.fulfilled.length > 0) {
		await SquadRcon.warnAll(ctx, planned.fulfilled, SRQ_Msgs.notifySwitched())
	}
	if (movedConnector) {
		await SquadRcon.warnAll(ctx, [movedConnector], SRQ_Msgs.notifyConnectorMoved())
	}
	if (failed.length > 0) {
		await SquadRcon.warnAll(ctx, failed, SRQ_Msgs.notifySwitchFailed())
	}
	if (requestsChanged) {
		const positionsAfter = SRQ.positions(sr.state.requests)
		const moved: { playerId: SM.PlayerId; position: number }[] = []
		for (const [playerId, position] of positionsAfter) {
			const before = positionsBefore.get(playerId)
			if (before !== undefined && before !== position) moved.push({ playerId, position })
		}
		for (const { playerId, position } of moved) {
			await SquadRcon.warn(ctx, playerId, SRQ_Msgs.notifyPositionChanged(position))
		}
	}

	return { planned, failed }
}

const clearForNewGame = Instr.spanOp('clearForNewGame', { module, mutexes: (ctx) => ctx.switchRequests.mutex }, async (ctx: PassCtx) => {
	const sr = ctx.switchRequests
	const hadState = sr.state.requests.length > 0 || sr.state.disconnectedThisMatch.size > 0
	if (sr.state.requests.length > 0) {
		droppedCounter.add(sr.state.requests.length, { [ATTRS.SquadServer.ID]: ctx.serverId, [ATTRS.SwitchRequest.REASON]: 'new-game' })
	}
	sr.state = SRQ.initState()
	sr.swapping.clear()
	sr.pendingPlacement.clear()
	if (hadState) {
		await DB.runTransaction(ctx, { redactParams: true }, async (ctx) => {
			await SquadServer.updateServerState(ctx, { switchRequests: null }, { type: 'system', event: 'switch-requests-saved' })
		})
	}
	emitUpdate(ctx)
})

export type RequestSwitchResult =
	| { code: 'ok:switching' }
	| { code: 'ok:queued'; position: number }
	| { code: 'err:already-queued'; position: number }
	| { code: 'err:no-team' }
	| { code: 'err:swap-pending' }

// /switch: enqueue, then let the same pass every roster event runs decide whether the request fires immediately
export const requestSwitch = Instr.spanOp(
	'requestSwitch',
	{ module, mutexes: (ctx) => ctx.switchRequests.mutex },
	async (ctx: PassCtx, sender: SM.Player): Promise<RequestSwitchResult> => {
		const sr = ctx.switchRequests
		const countReceived = (outcome: ATTRS.SwitchRequest.Outcome) =>
			receivedCounter.add(1, { [ATTRS.SquadServer.ID]: ctx.serverId, [ATTRS.SwitchRequest.OUTCOME]: outcome })

		if (sender.teamId === null) {
			countReceived('no-team')
			return { code: 'err:no-team' }
		}
		const playerId = SM.PlayerIds.getPlayerId(sender.ids)
		if (TSW.isSwapPending(ctx.teamswaps.session.state, playerId) || sr.swapping.has(playerId)) {
			countReceived('swap-pending')
			return { code: 'err:swap-pending' }
		}
		const existing = SRQ.position(sr.state.requests, playerId)
		if (existing !== null) {
			countReceived('already-queued')
			return { code: 'err:already-queued', position: existing }
		}

		const fromTeam = sender.teamId
		await passLocked(ctx, {
			mutate: (state) => state.requests.push({ playerId, fromTeam, requestedAt: Date.now() }),
			actor: { type: 'ingame-user', playerId },
		})
		const position = SRQ.position(sr.state.requests, playerId)
		if (position === null) {
			// the pass fired it on the spot, and already counted the fulfillment it drained through
			countReceived('immediate')
			return { code: 'ok:switching' }
		}
		countReceived('queued')
		return { code: 'ok:queued', position }
	},
)

export const cancelSwitch = Instr.spanOp(
	'cancelSwitch',
	{ module, mutexes: (ctx) => ctx.switchRequests.mutex },
	async (ctx: PassCtx, playerId: SM.PlayerId): Promise<{ code: 'ok' } | { code: 'err:not-queued' }> => {
		const sr = ctx.switchRequests
		if (!SRQ.requestFor(sr.state.requests, playerId)) return { code: 'err:not-queued' }
		droppedCounter.add(1, { [ATTRS.SquadServer.ID]: ctx.serverId, [ATTRS.SwitchRequest.REASON]: 'cancelled' })
		await passLocked(ctx, {
			mutate: (state) => {
				const index = state.requests.findIndex((r) => r.playerId === playerId)
				if (index >= 0) state.requests.splice(index, 1)
			},
		})
		return { code: 'ok' }
	},
)

// the window's per-row "switch now": an admin fulfilling one request out of turn
export const switchNow = Instr.spanOp(
	'switchNow',
	{ module, mutexes: (ctx) => ctx.switchRequests.mutex },
	async (ctx: PassCtx, playerId: SM.PlayerId, actor: AppEvents.Actor): Promise<{ code: 'ok' } | { code: 'err:not-queued' }> => {
		const sr = ctx.switchRequests
		const request = SRQ.requestFor(sr.state.requests, playerId)
		if (!request) return { code: 'err:not-queued' }

		const appEvent = AppEvents.create<AppEvents.SwitchRequestsFulfilled>({
			type: 'SWITCH_REQUESTS_FULFILLED',
			actor,
			serverId: ctx.serverId,
			matchId: (await MatchHistory.getCurrentMatch(ctx)).historyEntryId,
			causeId: null,
			targets: [playerId],
		})
		await SquadServer.emitAppEvent(ctx, appEvent)
		await SquadServer.armTeamChangeAttribution(ctx, [playerId], appEvent.id)
		const firedAt = Date.now()
		sr.swapping.set(playerId, {
			toTeam: SM.oppositeTeamId(request.fromTeam),
			via: 'capacity',
			firedAt,
			attempts: 1,
			causeId: appEvent.id,
		})
		fulfilledCounter.add(1, { [ATTRS.SquadServer.ID]: ctx.serverId, [ATTRS.SwitchRequest.VIA]: 'admin' })
		recordWait(ctx, request.requestedAt, firedAt, 'admin')
		await SquadRcon.switchPlayers(ctx, [playerId])
		// drop the fulfilled request; everyone behind them moves up and pass() reports the new positions
		await passLocked(ctx, {
			mutate: (state) => {
				const index = state.requests.findIndex((r) => r.playerId === playerId)
				if (index >= 0) state.requests.splice(index, 1)
			},
		})
		await SquadRcon.warnAll(ctx, [playerId], SRQ_Msgs.notifySwitched())
		return { code: 'ok' }
	},
)

const orpcBase = getOrpcBase(module)
export const orpcRouter = {
	watchUpdates: orpcBase
		.meta({ logLevel: 'trace' })
		.input(z.object({ serverId: z.string() }))
		.handler(async function* watchUpdates({ context, signal, input }) {
			const obs = SquadServer.stream$(context.wsClientId, input.serverId, (ctx) => {
				const init: SRQ.UpdateForClient = {
					requests: [...ctx.switchRequests.state.requests],
					swapping: [...ctx.switchRequests.swapping.keys()],
				}
				return ctx.switchRequests.update$.pipe(Rx.startWith(init))
			}).pipe(Rx.Ext.withAbortSignal(signal!))
			yield* Rx.Ext.toAsyncGenerator(obs)
		}),

	switchNow: orpcBase
		.meta({ type: 'mutation' })
		.input(z.object({ serverId: z.string(), playerId: SM.PlayerIdSchema }))
		.handler(async ({ context, input }) => {
			const ctxRes = await SquadServer.tryCtx(context, input.serverId)
			if (ctxRes.code !== 'ok') return ctxRes
			const ctx = ctxRes.ctx
			const denyRes = await Rbac.tryDenyPermissionsForUser(ctx, RBAC.perm('squad-server:manage-players', { serverId: ctx.serverId }))
			if (denyRes) return denyRes
			return await switchNow(ctx, input.playerId, { type: 'slm-user', userId: ctx.user.discordId })
		}),
}
