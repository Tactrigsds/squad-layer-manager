import * as Rx from 'rxjs'
import * as z from 'zod'

import * as RxExt from 'slm/lib/rxjs-ext'
import * as Templating from 'slm/lib/templating'
import * as ZU from 'slm/lib/zod-utils'
import type * as P from 'slm/plugin'
import * as Commands from 'slm/plugin/commands'
import * as PluginConfig from 'slm/plugin/config'
import * as Rpc from 'slm/plugin/rpc.server'
import * as Servers from 'slm/plugin/servers'
import * as Instr from 'slm/server/instrumentation'
import * as AppEvents from 'slm/systems/app-events'
import * as Discord from 'slm/systems/discord'
import * as LayerQueue from 'slm/systems/layer-queue'
import * as MatchHistory from 'slm/systems/match-history'
import * as SquadRcon from 'slm/systems/squad-rcon'
import * as SquadServer from 'slm/systems/squad-server'

import * as Activity from './activity.ts'
import * as Criteria from './criteria.ts'
import type manifest from './plugin.ts'
import * as Roll from './roll.ts'

type Ctx = P.ServerCtx<typeof manifest>

const EVALUATE_EVERY_MS = 5_000
const RETRY_BASE_MS = 60_000
const RETRY_CAP_MS = 10 * 60_000

export type Phase =
	| { kind: 'idle' }
	| { kind: 'armed'; deadline: number; seedLayerId: string; followUpLayerId: string }
	| { kind: 'rolling'; seedLayerId: string }
	// `matchId` is the match the roll ended, not the one it started. Held so a stale read of the current
	// match immediately after the roll cannot arm a second time for a match that is already over.
	| { kind: 'done'; seedLayerId: string; at: number; matchId: number | null }
	// an admin said no. The one terminal state: it stands until the next match, because re-arming over
	// somebody's decision thirty seconds later would be obnoxious.
	| { kind: 'cancelled' }
	// an attempt failed at something that may well work next time. Never terminal: the roll is what ends the
	// match, so a failure that waited for the next match would be waiting on itself.
	| { kind: 'retrying'; reason: string; at: number; nextAttempt: number; attempts: number }

export type Status = {
	onTrainingLayer: boolean
	census: Activity.Census | null
	criteria: Criteria.Evaluation | { code: 'err:compile'; message: string } | null
	nextIsSeedLayer: boolean
	seedPool: string
	/** why the plugin could not act even in principle: configuration, not a failed attempt. Follows the config. */
	notReady: string | null
	phase: Phase
}

// The `payload` of each event this plugin records. Shared with the client so its feed renderers read the
// payload instead of parsing the message back out (see client.tsx).
export type EventPayloads = {
	'seed-roll-armed': { seedLayerId: string; followUpLayerId: string } & Activity.Census
	'seed-roll-completed': { seedLayerId: string }
	'seed-roll-cancelled': Record<string, never>
	'seed-roll-failed': { code: string; reason: string; attempts: number; retryIn: string }
}

type ServerState = {
	activity: Activity.Activity
	status: Status
	/** aborts the armed countdown; a cancel and a plugin stop both come through here */
	arming: AbortController | null
}

// Per-server state, held for the plugin's lifetime and dropped by the per-server cleanup. Nothing is
// persisted: the activity clock re-learns itself within a poll or two, and an in-flight countdown that does
// not survive a restart is the safe way for it to not survive one.
const servers = new Map<string, ServerState>()
const update$ = new Rx.Subject<string>()

const INITIAL_STATUS: Status = {
	onTrainingLayer: false,
	census: null,
	criteria: null,
	nextIsSeedLayer: false,
	seedPool: '',
	notReady: null,
	phase: { kind: 'idle' },
}

function patch(serverId: string, status: Partial<Status>) {
	const state = servers.get(serverId)
	if (!state) return
	state.status = { ...state.status, ...status }
	update$.next(serverId)
}

const os = Rpc.os<typeof manifest>()

export const router = {
	status: os.input(z.object({})).handler(async function* ({ context }) {
		const status$ = Rx.merge(Rx.of(context.serverId), update$).pipe(
			Rx.filter((serverId) => serverId === context.serverId),
			Rx.map(() => servers.get(context.serverId)?.status ?? INITIAL_STATUS),
		)
		yield* RxExt.toAsyncGenerator(status$)
	}),

	cancel: os.input(z.object({})).handler(async ({ context }) => {
		const state = servers.get(context.serverId)
		if (!state?.arming) return { code: 'err:not-armed' as const }
		state.arming.abort()
		await AppEvents.emit(context, 'seed-roll-cancelled', {}, 'seed roll cancelled by an admin')
		return { code: 'ok' as const }
	}),
}

export async function activate(ctx: P.Ctx<typeof manifest>) {
	Rpc.register(ctx, router)

	// The manual counterpart to the criteria: an admin who can end a match can decide it is seeding time. It
	// overrides a cancelled or backed-off phase, which are answers to the automatic path, not to a person asking.
	Commands.register(ctx, {
		name: 'rolltoseed',
		description: 'Roll to a seeding layer now, without waiting for the criteria.',
		triggers: ['rolltoseed'],
		allowedChats: ['admin'],
		permission: 'squad-server:end-match',
		handler: async (sctx) => {
			const state = servers.get(sctx.serverId)
			if (!state) return 'The seed roller is not running on this server.'
			if (state.status.notReady) return state.status.notReady
			const phase = state.status.phase
			if (phase.kind === 'armed') return `Already rolling to ${phase.seedLayerId}. Cancel on the SLM dashboard.`
			if (phase.kind === 'rolling') return 'Already rolling to seed.'
			const census = await takeCensus(sctx, state)
			if (!census) return 'Could not read the server roster, so there is nothing to announce the roll with.'
			// not awaited: arming warns every admin, counts down and then ends the match, which is far longer than
			// a chat command should hold the handler open for. It reports for itself from there.
			void arm(sctx, state, census).catch((err: unknown) => sctx.log.error(err, 'manual seed roll failed'))
			return 'Preparing a seed roll.'
		},
	})

	Servers.setup(ctx, (sctx, cleanup) => {
		const state: ServerState = { activity: Activity.init(), status: { ...INITIAL_STATUS }, arming: null }
		servers.set(sctx.serverId, state)
		cleanup.push(() => {
			state.arming?.abort()
			servers.delete(sctx.serverId)
		})

		cleanup.push(
			SquadServer.events$(sctx)
				.pipe(
					Instr.durableSub('note-activity', { module: sctx.module }, async (event) => {
						Activity.note(state.activity, event, Date.now())
					}),
				)
				.subscribe(),
		)

		// a roll arms at most once per match: a cancel, a failure or a completed roll all stand until the
		// next one, so a criteria expression that stays true cannot re-arm every five seconds
		cleanup.push(
			sctx.matchHistory.finalized$
				.pipe(
					Instr.durableSub('reset-phase', { module: sctx.module }, async () => {
						const phase = state.status.phase
						if (phase.kind === 'armed' || phase.kind === 'rolling') return
						// a completed roll is what finalized this match, so its own finalization must not clear it.
						// evaluate() releases it once the current match is genuinely a different one.
						if (phase.kind === 'done') return
						patch(sctx.serverId, { phase: { kind: 'idle' } })
					}),
				)
				.subscribe(),
		)

		cleanup.push(
			Rx.interval(EVALUATE_EVERY_MS)
				.pipe(Instr.durableSub('evaluate', { module: sctx.module }, async () => await evaluate(sctx, state)))
				.subscribe(),
		)
	})
}

const evaluate = async (ctx: Ctx, state: ServerState) => {
	const cfg = PluginConfig.get(ctx)
	const current = await MatchHistory.getCurrentMatch(ctx)
	const onTrainingLayer = !!current && Roll.isTrainingLayer(current.layerId)

	const census = await takeCensus(ctx, state)

	const compiled = Criteria.compile(cfg.criteria)
	const evaluation =
		compiled.code !== 'ok'
			? compiled
			: census
				? compiled.evaluate({ ...census, currentTime: Criteria.timeVars(cfg.timezone, new Date()) })
				: null

	// a roll ends the match, and the current match can still read as the old one for a tick afterwards.
	// Holding 'done' until the id actually moves is what stops a second arm for a match already over.
	if (state.status.phase.kind === 'done' && current?.historyEntryId !== state.status.phase.matchId) {
		patch(ctx.serverId, { phase: { kind: 'idle' } })
	}

	const head = LayerQueue.getSavedQueue(ctx)[0]
	const now = Date.now()
	patch(ctx.serverId, {
		onTrainingLayer,
		census,
		criteria: evaluation,
		nextIsSeedLayer: !!head && Roll.isSeedLayer(head.layerId),
		seedPool: cfg.seedPool,
		notReady: readiness(cfg, compiled),
	})

	if (!onTrainingLayer || state.status.notReady) return
	if (!canArm(state.status.phase, now)) return
	if (evaluation?.code !== 'ok' || !evaluation.passed) return
	await arm(ctx, state, census!)
}

// The roster read the criteria and the announcement both run off. Null when rcon could not be reached, which the
// criteria treat as "cannot say" rather than as an empty server.
async function takeCensus(ctx: Ctx, state: ServerState): Promise<Activity.Census | null> {
	const teams = await SquadRcon.getTeams(ctx)
	const roster = teams.code === 'ok' ? teams.players : []
	Activity.prune(state.activity, roster)
	if (teams.code !== 'ok') return null
	return Activity.census(state.activity, roster, Date.now(), PluginConfig.get(ctx).afkWindow)
}

/**
 * What stops the plugin acting at all, as opposed to an attempt that failed. Recomputed every tick, so
 * fixing the config clears it without anybody restarting anything.
 */
function readiness(cfg: { seedPool: string; followUpPool: string }, compiled: Criteria.Compiled): string | null {
	if (compiled.code !== 'ok') return `The criteria will not compile: ${compiled.message}`
	if (!cfg.seedPool) return 'No seeding pool is configured, so there is nothing to draw a seeding layer from.'
	if (!cfg.followUpPool) return 'No follow-up pool is configured, so there is nothing to queue behind the seeding layer.'
	return null
}

function canArm(phase: Phase, now: number): boolean {
	if (phase.kind === 'idle') return true
	return phase.kind === 'retrying' && now >= phase.nextAttempt
}

// doubling from a minute, capped, so a server that will not sync is retried occasionally rather than every
// five seconds, and a transient failure is retried soon
function retryAfter(phase: Phase, reason: string): Extract<Phase, { kind: 'retrying' }> {
	const attempts = phase.kind === 'retrying' ? phase.attempts + 1 : 1
	const now = Date.now()
	return { kind: 'retrying', reason, at: now, attempts, nextAttempt: now + Math.min(RETRY_BASE_MS * 2 ** (attempts - 1), RETRY_CAP_MS) }
}

async function arm(ctx: Ctx, state: ServerState, census: Activity.Census) {
	const cfg = PluginConfig.get(ctx)
	// the queue is prepared before anyone is told, so a failure is reported instead of announced, and a
	// cancel during the countdown leaves a correct queue rather than a half-edited one
	const seed = `${ctx.serverId}:${Date.now()}`
	const prepared = await Roll.prepareQueue(ctx, cfg, seed)
	if (prepared.code !== 'ok') {
		await fail(ctx, state, prepared.code, describePrepareFailure(prepared))
		return
	}

	const abort = new AbortController()
	state.arming = abort
	const deadline = Date.now() + cfg.countdown
	patch(ctx.serverId, { phase: { kind: 'armed', deadline, seedLayerId: prepared.seedLayerId, followUpLayerId: prepared.followUpLayerId } })

	const vars = {
		layer: prepared.seedLayerId,
		seconds: String(Math.round(cfg.countdown / 1000)),
		population: String(census.population),
		activePopulation: String(census.activePopulation),
		server: ctx.serverId,
	}
	await AppEvents.emit(
		ctx,
		'seed-roll-armed',
		{ seedLayerId: prepared.seedLayerId, followUpLayerId: prepared.followUpLayerId, ...census },
		`rolling to seed (${prepared.seedLayerId}) in ${vars.seconds}s`,
	)
	await SquadRcon.warnAllAdmins(ctx, Templating.renderTemplate(cfg.adminWarning, vars))
	if (cfg.discordChannel) {
		const res = await Discord.postMessage(cfg.discordChannel, Templating.renderTemplate(cfg.discordMessage, vars))
		if (res.code !== 'ok') ctx.log.warn('discord announcement failed: %s', res.code)
	}

	const cancelled = await sleep(cfg.countdown, AbortSignal.any([abort.signal, ctx.signal]))
	state.arming = null
	if (cancelled) {
		patch(ctx.serverId, { phase: { kind: 'cancelled' } })
		return
	}

	patch(ctx.serverId, { phase: { kind: 'rolling', seedLayerId: prepared.seedLayerId } })
	if (!(await Roll.waitForNextLayer(ctx, prepared.seedLayerId))) {
		await fail(ctx, state, 'next-layer-timeout', 'The game server never reported the seeding layer as next.')
		return
	}

	await SquadRcon.broadcast(ctx, Templating.renderTemplate(cfg.broadcast, vars))
	const ended = await SquadServer.endMatch(ctx)
	if (ended.code !== 'ok') {
		await fail(ctx, state, ended.code, ended.message)
		return
	}
	const rolled = await MatchHistory.getCurrentMatch(ctx)
	patch(ctx.serverId, {
		phase: { kind: 'done', seedLayerId: prepared.seedLayerId, at: Date.now(), matchId: rolled?.historyEntryId ?? null },
	})
	await AppEvents.emit(
		ctx,
		'seed-roll-completed',
		{ seedLayerId: prepared.seedLayerId },
		`rolled to seeding layer ${prepared.seedLayerId}`,
	)
}

/** Records a failed attempt and schedules the next one. */
async function fail(ctx: Ctx, state: ServerState, code: string, reason: string) {
	const phase = retryAfter(state.status.phase, reason)
	patch(ctx.serverId, { phase })
	const retryIn = ZU.formatDurationApprox(phase.nextAttempt - phase.at)
	await AppEvents.emit(
		ctx,
		'seed-roll-failed',
		{ code, reason, attempts: phase.attempts, retryIn },
		`seed roll failed: ${reason} Retrying in ${retryIn}.`,
	)
}

function describePrepareFailure(result: Roll.PrepareResult): string {
	switch (result.code) {
		case 'err:unsaved-edits':
			return 'An admin has unsaved queue edits open, so the queue was left alone.'
		case 'err:no-pool':
			return `No ${result.pool} pool is configured, so there is nothing to draw from.`
		case 'err:empty-pool':
			return `The ${result.pool} pool matched no layers.`
		case 'err:queue':
			return `The queue edit failed (${result.message}).`
		default:
			return 'Unknown failure.'
	}
}

/** Resolves true when aborted rather than throwing, since a cancel is an outcome here and not an error. */
function sleep(ms: number, signal: AbortSignal): Promise<boolean> {
	return new Promise((resolve) => {
		if (signal.aborted) return resolve(true)
		const timer = setTimeout(() => {
			signal.removeEventListener('abort', onAbort)
			resolve(false)
		}, ms)
		function onAbort() {
			clearTimeout(timer)
			resolve(true)
		}
		signal.addEventListener('abort', onAbort, { once: true })
	})
}
