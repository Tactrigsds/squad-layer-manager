/**
 * Talking to the game server: reads, warns, broadcasts and player management. Everything but the
 * connection lifecycle, which the host owns.
 */
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
	removeFromSquad,
	setFogOfWar,
	setIngameVotingEnabled,
	setNextLayer,
	splitBroadcast,
	switchPlayers,
	warn,
	warnAll,
	warnAllAdmins,
} from '@/systems/squad-rcon.server'
