/**
 * The managed server itself: its live event stream, its current roster and match, ending a match and
 * kicking players.
 *
 * `endMatch` and `kickPlayers` are here rather than on slm/systems/squad-rcon because a bare rcon end or
 * kick is unattributed. The host emits the MATCH_ENDED or PLAYER_KICKED app event and arms the expectation
 * for the server event it produces, which is also why a plugin cannot assemble this itself:
 * slm/systems/app-events only writes PLUGIN_EVENT.
 */
import * as Rx from '@/lib/rxjs'
import * as AAR from '@/models/admin-action-reasons.models'
import type * as CS from '@/models/context-shared'
import type * as SE from '@/models/server-events.models'
import type * as SQS from '@/models/squad-server.models'
import type * as SM from '@/models/squad.models'
import type * as PluginsSys from '@/systems/plugins.server'
import * as SquadServer from '@/systems/squad-server.server'

/** Ends the current match, attributed to the calling plugin, and waits for the round end it produces. */
export async function endMatch(ctx: PluginsSys.ServerCtx<any>) {
	return await SquadServer.endMatchAction(ctx, { type: 'plugin', pluginId: ctx.plugin.id })
}

/** Kicks players, attributed to the calling plugin, under one PLAYER_KICKED app event. `reason` is shown to them. */
export async function kickPlayers(ctx: PluginsSys.ServerCtx<any>, targets: SM.PlayerId[], reason?: string) {
	await tryKickPlayers(ctx, targets, reason)
}

/**
 * `kickPlayers`, returning the players that are gone from the server afterwards. The server refuses to kick some
 * players, such as Squad's developers, and the PLAYER_KICKED app event lists only the players it kicked.
 */
export async function tryKickPlayers(ctx: PluginsSys.ServerCtx<any>, targets: SM.PlayerId[], reason?: string) {
	const applied = reason === undefined ? undefined : AAR.applyCustomReason(reason, {})
	return await SquadServer.kickPlayersAction(ctx, targets, { type: 'plugin', pluginId: ctx.plugin.id }, applied)
}

/**
 * Every server event as it lands: connects, chat, squad changes, kills, round ends. Hot and unbuffered,
 * so a subscriber sees only what happens after it subscribes. Wrap it in `durableSub`.
 */
export function events$(ctx: SQS.Ctx & CS.ServerId): Rx.Observable<SE.Event> {
	return ctx.server.event$.pipe(Rx.map(([_otel, event]) => event))
}

export { getCurrTeams, peekCurrentMatch } from '@/systems/squad-server.server'
