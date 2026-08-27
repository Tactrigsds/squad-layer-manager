import * as Rx from 'rxjs'
import * as z from 'zod'

import * as RxExt from 'slm/lib/rxjs-ext'
import * as Templating from 'slm/lib/templating'
import type * as P from 'slm/plugin'
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

export type Phase =
	| { kind: 'idle' }
	| { kind: 'armed'; deadline: number; seedLayerId: string; followUpLayerId: string }
	| { kind: 'rolling'; seedLayerId: string }
	| { kind: 'done'; seedLayerId: string }
	| { kind: 'cancelled' }
	| { kind: 'blocked'; reason: string }

export type Status = {
	onTrainingLayer: boolean
	census: Activity.Census | null
	criteria: Criteria.Evaluation | { code: 'err:compile'; message: string } | null
	nextIsSeedLayer: boolean
	seedPool: string
	phase: Phase
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
						if (state.status.phase.kind === 'armed' || state.status.phase.kind === 'rolling') return
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

	const teams = await SquadRcon.getTeams(ctx)
	const roster = teams.code === 'ok' ? teams.players : []
	Activity.prune(state.activity, roster)
	const census = teams.code === 'ok' ? Activity.census(state.activity, roster, Date.now(), cfg.afkWindow) : null

	const compiled = Criteria.compile(cfg.criteria)
	const evaluation =
		compiled.code !== 'ok'
			? compiled
			: census
				? compiled.evaluate({ ...census, currentTime: Criteria.timeVars(cfg.timezone, new Date()) })
				: null

	const head = LayerQueue.getSavedQueue(ctx)[0]
	patch(ctx.serverId, {
		onTrainingLayer,
		census,
		criteria: evaluation,
		nextIsSeedLayer: !!head && Roll.isSeedLayer(head.layerId),
		seedPool: cfg.seedPool,
	})

	if (!onTrainingLayer || state.status.phase.kind !== 'idle') return
	if (evaluation?.code !== 'ok' || !evaluation.passed) return
	await arm(ctx, state, census!)
}

async function arm(ctx: Ctx, state: ServerState, census: Activity.Census) {
	const cfg = PluginConfig.get(ctx)
	if (!cfg.editorUserId) {
		patch(ctx.serverId, { phase: { kind: 'blocked', reason: 'No editor discord id configured, so the queue cannot be edited.' } })
		return
	}

	// the queue is prepared before anyone is told, so a failure is reported instead of announced, and a
	// cancel during the countdown leaves a correct queue rather than a half-edited one
	const seed = `${ctx.serverId}:${Date.now()}`
	const prepared = await Roll.prepareQueue(ctx, cfg, seed)
	if (prepared.code !== 'ok') {
		patch(ctx.serverId, { phase: { kind: 'blocked', reason: describePrepareFailure(prepared) } })
		await AppEvents.emit(ctx, 'seed-roll-blocked', { reason: prepared.code }, `seed roll blocked: ${describePrepareFailure(prepared)}`)
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
		patch(ctx.serverId, { phase: { kind: 'blocked', reason: 'The game server never reported the seeding layer as next.' } })
		await AppEvents.emit(ctx, 'seed-roll-blocked', { reason: 'next-layer-timeout' }, 'seed roll blocked: next layer never synced')
		return
	}

	await SquadRcon.broadcast(ctx, Templating.renderTemplate(cfg.broadcast, vars))
	const ended = await SquadServer.endMatch(ctx)
	if (ended.code !== 'ok') {
		patch(ctx.serverId, { phase: { kind: 'blocked', reason: ended.message } })
		await AppEvents.emit(ctx, 'seed-roll-blocked', { reason: ended.code }, `seed roll blocked: ${ended.message}`)
		return
	}
	patch(ctx.serverId, { phase: { kind: 'done', seedLayerId: prepared.seedLayerId } })
	await AppEvents.emit(
		ctx,
		'seed-roll-completed',
		{ seedLayerId: prepared.seedLayerId },
		`rolled to seeding layer ${prepared.seedLayerId}`,
	)
}

function describePrepareFailure(result: Roll.PrepareResult): string {
	switch (result.code) {
		case 'err:unsaved-edits':
			return 'An admin has unsaved queue edits open, so the queue was left alone.'
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
