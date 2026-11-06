/**
 * Talking to the game server: reads, warns, broadcasts and player management. Everything but the
 * connection lifecycle, which the host owns.
 */
import * as AppEvents from '@/models/app-events.models'
import * as MatchHistory from '@/systems/match-history.server'
import type * as PluginsSys from '@/systems/plugins.server'
import * as SquadServerActions from '@/systems/squad-server-actions.server'

export {
	adminRenameSquad,
	broadcast,
	demoteCommander,
	disbandSquad,
	endMatch,
	getCurrentLayer,
	getLayerStatus,
	getNextLayer,
	getPlayer,
	getServerInfo,
	getTeams,
	kickPlayer,
	killPlayers,
	layerStatus$,
	MIN_TTL_MS,
	removeFromSquad,
	serverInfo$,
	setFogOfWar,
	setIngameVotingEnabled,
	setNextLayer,
	splitBroadcast,
	switchPlayers,
	teams$,
	warn,
	warnAll,
	warnAllAdmins,
} from '@/systems/squad-rcon.server'

/**
 * Runs a raw rcon command and returns the server's reply. The audit log and the server's activity feed record each
 * command as an `RCON_COMMAND_RUN` attributed to the plugin, as the server console records an admin's. Prefer the
 * typed functions above where one exists.
 */
export async function execute(ctx: PluginsSys.ServerCtx<any>, command: string) {
	const res = await ctx.rcon.execute(command, { level: 'info', signal: ctx.signal, issuer: ctx.plugin.manifest.name })
	await SquadServerActions.emitAppEvent(
		ctx,
		AppEvents.create<AppEvents.RconCommandRun>({
			type: 'RCON_COMMAND_RUN',
			actor: { type: 'plugin', pluginId: ctx.plugin.id },
			serverId: ctx.serverId,
			matchId: (await MatchHistory.getCurrentMatch(ctx))?.historyEntryId ?? null,
			causeId: null,
			command,
			...(res.code === 'ok' ? {} : { error: res.msg }),
		}),
	)
	return res
}
