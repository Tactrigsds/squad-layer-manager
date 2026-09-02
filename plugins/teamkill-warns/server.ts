import * as Rx from 'rxjs'

import * as Templating from 'slm/lib/templating'
import * as L from 'slm/models/layer'
import type * as P from 'slm/plugin'
import * as PluginConfig from 'slm/plugin/config'
import * as Servers from 'slm/plugin/servers'
import * as Instr from 'slm/server/instrumentation'
import * as SquadRcon from 'slm/systems/squad-rcon'
import * as SquadServer from 'slm/systems/squad-server'

import type manifest from './plugin.ts'

export async function activate(ctx: P.Ctx<typeof manifest>) {
	Servers.setup(ctx, (sctx) => {
		sctx.cleanup.push(
			sctx.server.event$
				.pipe(
					Rx.filter(([_ctx, e]) => e.type === 'PLAYER_WOUNDED' && e.variant === 'teamkill'),
					Instr.durableSub('notifyTeamkills', { module: sctx.module }, async ([_ctx, e], signal) => {
						if (e.type !== 'PLAYER_WOUNDED') return
						// re-read per event: config edits take effect without restarting the plugin
						const cfg = PluginConfig.get(sctx)
						if (!cfg.enabledServers.includes(sctx.serverId)) return
						const match = SquadServer.peekCurrentMatch(sctx)
						if (!match || isTrainingLayer(match.layerId)) return
						const players = SquadServer.getCurrTeams(sctx)?.players
						if (!players) return
						const attacker = players.get(e.attacker)
						const victim = players.get(e.victim)
						if (!attacker || !victim) return
						const rendered = Templating.renderTemplate(cfg.template, {
							attacker: attacker.ids.username,
							weapon: e.weapon ?? 'an unknown weapon',
						})
						await SquadRcon.warn({ ...sctx, signal }, victim.ids, rendered)
					}),
				)
				.subscribe(),
		)
	})
}

function isTrainingLayer(layerId: string) {
	try {
		return L.toLayer(layerId)?.Gamemode === 'Training'
	} catch {
		// an id this build cannot parse is not a training layer, and a teamkill is no place to fail over it
		return false
	}
}
