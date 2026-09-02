import * as Rx from 'rxjs'
// import * as CS from 'slm/server/

import * as Templating from 'slm/lib/templating'
import * as L from 'slm/models/layer'
import type * as P from 'slm/plugin'
import * as PluginConfig from 'slm/plugin/config'
import * as Servers from 'slm/plugin/servers'
import * as Instr from 'slm/server/instrumentation'
import * as MatchHistory from 'slm/systems/match-history'
import * as SquadRcon from 'slm/systems/squad-rcon'
import * as SquadServer from 'slm/systems/squad-server'

import type manifest from './plugin.ts'

export async function activate(ctx: P.Ctx<typeof manifest>) {
	Servers.setup(ctx, (ctx) => {
		const cfg = PluginConfig.get(ctx)
		if (!cfg.enabledServers.includes(ctx.serverId)) return

		const baseCtx = ctx
		ctx.cleanup.push(
			ctx.server.event$
				.pipe(
					Rx.filter(([ctx, e]) => e.type === 'PLAYER_WOUNDED' && e.variant === 'teamkill'),
					Instr.durableSub('notifyTeamkills', { module: ctx.module }, async ([_ctx, e], signal) => {
						const ctx = { ...baseCtx, signal: signal }
						if (e.type !== 'PLAYER_WOUNDED') return
						const match = await MatchHistory.getCurrentMatch(ctx)
						const layer = L.toLayer(match.layerId)
						// don't warn in training mode
						if (layer.Gamemode === 'Training') return
						const players = SquadServer.getCurrTeams(ctx)?.players
						if (!players) return
						const attacker = players.get(e.attacker)
						const victim = players.get(e.victim)
						if (!attacker || !victim) return
						const rendered = Templating.renderTemplate(cfg.template, {
							attacker: attacker.ids.username,
							weapon: e.weapon ?? '<unknown>',
						})
						await SquadRcon.warn(ctx, victim.ids, rendered)
					}),
				)
				.subscribe(),
		)
	})
}
