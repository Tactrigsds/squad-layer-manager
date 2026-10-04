/**
 * Who SLM counts as idle on a server: the same rule the population chart draws.
 *
 * A player in a squad or in a vehicle is never idle. Anyone else is idle once a threshold has passed since their last
 * activity: a chat message, a squad or team change, a role or vehicle change, a kill, wound or death on either end,
 * or a vehicle or deployable they destroyed. Anything an admin or SLM did to the player does not count. A player
 * counts as active when SLM first sees them, and every clock starts again at a new game.
 *
 * The threshold defaults to the one set under Player Activity in SLM's settings.
 */

import * as Activity from '@/models/player-activity.models'
import type * as SQS from '@/models/squad-server.models'
import type * as SM from '@/models/squad.models'
import * as Settings from '@/systems/settings.server'
import * as SquadServer from '@/systems/squad-server.server'

export type IdlePlayer = { id: SM.PlayerId; player: SM.Player; lastActive: number }

/** The idle threshold set under Player Activity in SLM's settings, in ms. */
export function idleThresholdMs(): number {
	return Activity.thresholdMs(Settings.GLOBAL_SETTINGS.playerActivity)
}

/** When a player on the server last did something, in ms since the epoch. Undefined when they are not on it. */
export function lastActive(ctx: SQS.Ctx, playerId: SM.PlayerId): number | undefined {
	return ctx.server.activity.lastActive.get(playerId)
}

/** Whether a player on the server counts as idle at `now`. False when they are not on it. */
export function isIdle(ctx: SQS.Ctx, playerId: SM.PlayerId, thresholdMs = idleThresholdMs(), now = Date.now()): boolean {
	const player = SquadServer.getCurrTeams(ctx)?.players.get(playerId)
	return !!player && Activity.isIdle(player, lastActive(ctx, playerId), now, thresholdMs)
}

/** Every idle player on the server at `now`, longest idle first. */
export function idlePlayers(ctx: SQS.Ctx, thresholdMs = idleThresholdMs(), now = Date.now()): IdlePlayer[] {
	const roster = SquadServer.getCurrTeams(ctx)?.players
	if (!roster) return []
	const out: IdlePlayer[] = []
	for (const [id, player] of roster) {
		const since = lastActive(ctx, id)
		if (since !== undefined && Activity.isIdle(player, since, now, thresholdMs)) out.push({ id, player, lastActive: since })
	}
	return out.sort((a, b) => a.lastActive - b.lastActive)
}
