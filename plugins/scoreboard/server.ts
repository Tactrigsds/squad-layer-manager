import * as Rx from 'rxjs'

import * as L from 'slm/models/layer'
import type * as MH from 'slm/models/match-history'
import type * as P from 'slm/plugin'
import * as PluginConfig from 'slm/plugin/config'
import * as Servers from 'slm/plugin/servers'
import * as Instr from 'slm/server/instrumentation'
import * as SvgRaster from 'slm/server/svg-raster'
import * as AppEvents from 'slm/systems/app-events'
import * as Discord from 'slm/systems/discord'
import * as MatchHistory from 'slm/systems/match-history'
import * as Settings from 'slm/systems/settings'

import * as Embed from './embed.ts'
import type manifest from './plugin.ts'
import * as Stats from './stats.ts'

const SKIPPED_GAMEMODES: ReadonlySet<string | undefined> = new Set(['Seed', 'Training'])

// discord shows an embed image about 400px wide, so 2x keeps the text sharp on a high density display
const CHART_SCALE = 2

export async function activate(ctx: P.Ctx<typeof manifest>) {
	Servers.setup(ctx, (sctx) => {
		sctx.cleanup.push(
			sctx.matchHistory.finalized$
				.pipe(
					Rx.filter(() => PluginConfig.get(sctx).enabledServers.includes(sctx.serverId)),
					Instr.durableSub('postScoreboard', { module: sctx.module }, async ({ matchId }, signal) => {
						await postScoreboard({ ...sctx, signal }, matchId)
					}),
				)
				.subscribe(),
		)
	})
}

async function postScoreboard(sctx: P.ServerCtx<typeof manifest>, matchId: number) {
	const cfg = PluginConfig.get(sctx)
	if (!cfg.channel) return sctx.log.warn('no channel configured, so the scoreboard for match %d was not posted', matchId)
	if (!Discord.isEnabled()) return sctx.log.warn('the discord integration is off, so the scoreboard for match %d was not posted', matchId)

	const match = await MatchHistory.getMatchById(sctx, matchId)
	if (!match || match.status !== 'post-game') return sctx.log.warn('match %d is not a finished match in recent history', matchId)
	if (!isScored(match, cfg.minMatchMinutes)) return

	const events = await MatchHistory.getMatchEvents(sctx, matchId)
	const tally = Stats.tally(events)
	const servers = Settings.listServers()
	const { embeds, charts } = Embed.build({
		cfg,
		match,
		tally,
		serverName: servers.find((server) => server.id === sctx.serverId)?.displayName ?? null,
		showServer: servers.filter((server) => server.enabled && !server.sandbox).length > 1,
	})

	const files: Discord.MessageFile[] = [{ name: Embed.KILLS_CHART_FILE, data: SvgRaster.svgToPng(charts.kills, { scale: CHART_SCALE }) }]
	if (charts.tickets) files.push({ name: Embed.TICKETS_CHART_FILE, data: SvgRaster.svgToPng(charts.tickets, { scale: CHART_SCALE }) })

	const res = await Discord.sendMessage(cfg.channel, { embeds, files })
	if (res.code !== 'ok') return sctx.log.warn('could not post the scoreboard for match %d: %s', matchId, res.msg)
	await AppEvents.emit(
		sctx,
		'scoreboard-posted',
		{ matchId, messageId: res.messageId },
		`Posted the scoreboard for match ${matchId} to Discord`,
	)
}

function isScored(match: MH.PostGameMatchDetails, minMatchMinutes: number) {
	if (SKIPPED_GAMEMODES.has(L.toLayer(match.layerId).Gamemode)) return false
	const minutes = Embed.matchMinutes(match)
	return minutes === null || minutes >= minMatchMinutes
}
