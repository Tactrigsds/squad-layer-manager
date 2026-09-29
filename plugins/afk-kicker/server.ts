import * as Rx from 'rxjs'

import * as RxExt from 'slm/lib/rxjs-ext'
import * as Templating from 'slm/lib/templating'
import * as L from 'slm/models/layer'
import type * as P from 'slm/plugin'
import * as PluginConfig from 'slm/plugin/config'
import * as Servers from 'slm/plugin/servers'
import * as Instr from 'slm/server/instrumentation'
import * as SquadRcon from 'slm/systems/squad-rcon'
import * as SquadServer from 'slm/systems/squad-server'

import * as Afk from './afk.ts'
import type manifest from './plugin.ts'

type Ctx = P.ServerCtx<typeof manifest>
type Config = P.Config<typeof manifest>

const EVALUATE_EVERY_MS = 5_000
const FINAL_WARNING_MS = 5_000
// how long a kick counts as a freed slot; see Afk.kicksNeeded
const KICK_SETTLE_MS = 30_000

const REASONS: Record<Afk.Afk['reason'], string> = {
	squadless: 'you have not joined a squad',
	idle: 'you have not done anything for a while',
}

export async function activate(ctx: P.Ctx<typeof manifest>) {
	Servers.setup(ctx, (sctx) => {
		const tracker = Afk.init()

		// tracked whether or not the server is enabled, so switching it on does not start from a blank slate
		sctx.cleanup.push(
			SquadServer.events$(sctx)
				.pipe(
					Instr.durableSub('note-activity', { module: sctx.module }, async (event) => {
						Afk.note(tracker, event, Date.now())
					}),
				)
				.subscribe(),
		)

		// exhaust: a tick that kicks holds on the final warning longer than the interval, and one kick round at a
		// time is what keeps two rounds from picking the same players
		sctx.cleanup.push(
			Rx.interval(EVALUATE_EVERY_MS)
				.pipe(
					Instr.durableSub('evaluate', { module: sctx.module, taskScheduling: 'exhaust' }, async (_, signal) => {
						await evaluate({ ...sctx, signal }, tracker)
					}),
				)
				.subscribe(),
		)
	})
}

type Reading = { afk: Afk.Afk[]; needed: number }

async function read(ctx: Ctx, tracker: Afk.Tracker, cfg: Config): Promise<Reading | null> {
	const info = await SquadRcon.getServerInfo(ctx)
	const teams = SquadServer.getCurrTeams(ctx)
	if (!teams || info.code !== 'ok') return null
	const now = Date.now()
	Afk.observe(tracker, teams.players, now)
	Afk.pruneKicks(tracker, now, KICK_SETTLE_MS)
	const needed = Afk.kicksNeeded(info.data, cfg.targetQueue, tracker.recentKicks.length)
	if (needed === null) {
		ctx.log.warn('server info does not add up, not kicking: %o', info.data)
		return null
	}
	const match = SquadServer.peekCurrentMatch(ctx)
	const gamemode = match ? gamemodeOf(match.layerId) : undefined
	const rule: Afk.Rule =
		gamemode && cfg.idleGamemodes.includes(gamemode)
			? { kind: 'idle', window: cfg.idleWindow }
			: { kind: 'squadless', window: cfg.squadlessWindow }
	return { afk: Afk.afkPlayers(tracker, teams.players, rule, now), needed }
}

async function evaluate(ctx: Ctx, tracker: Afk.Tracker) {
	const cfg = PluginConfig.get(ctx)
	if (!cfg.enabledServers.includes(ctx.serverId)) {
		const roster = SquadServer.getCurrTeams(ctx)?.players
		if (roster) Afk.observe(tracker, roster, Date.now())
		return
	}
	const reading = await read(ctx, tracker, cfg)
	if (!reading) return

	const selected = reading.needed > 0 ? reading.afk.slice(0, reading.needed) : []
	if (reading.needed >= 0) await warnPeriodically(ctx, tracker, cfg, reading.afk.slice(selected.length))
	if (selected.length === 0) return

	const seconds = String(Math.round(FINAL_WARNING_MS / 1000))
	await Promise.all(
		selected.map((afk) =>
			SquadRcon.warn(ctx, afk.player.ids, Templating.renderTemplate(cfg.finalWarning, { reason: REASONS[afk.reason], seconds })),
		),
	)
	await RxExt.firstValueFrom(Rx.timer(FINAL_WARNING_MS), ctx.signal)

	// anyone who came back in the meantime keeps their slot, and a queue that cleared needs nobody gone
	const after = await read(ctx, tracker, cfg)
	if (!after || after.needed <= 0) return
	const stillAfk = new Set(after.afk.map((afk) => afk.id))
	const targets = selected
		.map((afk) => afk.id)
		.filter((id) => stillAfk.has(id))
		.slice(0, after.needed)
	if (targets.length === 0) return

	const now = Date.now()
	for (let i = 0; i < targets.length; i++) tracker.recentKicks.push(now)
	ctx.log.info('kicking %d AFK players, %d needed', targets.length, after.needed)
	await SquadServer.kickPlayers(ctx, targets, cfg.kickReason)
}

async function warnPeriodically(ctx: Ctx, tracker: Afk.Tracker, cfg: Config, afk: Afk.Afk[]) {
	const now = Date.now()
	const due = afk.filter((a) => now - (tracker.lastWarned.get(a.id) ?? 0) >= cfg.warnInterval)
	for (const a of due) tracker.lastWarned.set(a.id, now)
	await Promise.all(
		due.map((a) => SquadRcon.warn(ctx, a.player.ids, Templating.renderTemplate(cfg.warning, { reason: REASONS[a.reason] }))),
	)
}

function gamemodeOf(layerId: string) {
	try {
		return L.toLayer(layerId)?.Gamemode
	} catch {
		return undefined
	}
}
