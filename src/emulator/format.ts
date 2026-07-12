// Renderers for everything the emulated squad server writes: RCON response bodies, RCON
// chat-stream (type 1) packet bodies, and SquadGame.log lines. Formats are transcribed from
// real captures in test/corpus and validated against the app's own matchers by the emulator
// self-check tests; when Squad changes a format, refresh the corpus and fix both together.

export type PlayerLike = {
	eos: string
	steam: string
	// verbatim, including the leading space squad renders for untagged names
	name: string
	teamId: number | null
	squadId: number | null
	isLeader: boolean
	role: string
	controllerId: string
	ip: string
	port: number
}

export type SquadLike = {
	teamId: number
	squadId: number
	name: string
	locked: boolean
	creatorName: string
	creatorEos: string
	creatorSteam: string
}

export type TeamLike = { id: number; name: string }

export type LayerLike = {
	level: string
	layer: string
	// verbatim factions string, e.g. 'RGF+Mechanized PLA+AirAssault' or 'RGF VDV'
	factions: string
	// asset path fragment for the NEW_GAME line, e.g. '/Game/Maps/Sumari/Gameplay_Layers'
	mapDir: string
}

function pad(n: number, w: number) {
	return String(n).padStart(w, '0')
}

// e.g. [2026.07.12-20.56.48:296][931] -- timestamp is UTC, chainID is space-padded to width 3
export function logHeader(time: Date, chainId: number): string {
	const ts = `${time.getUTCFullYear()}.${pad(time.getUTCMonth() + 1, 2)}.${pad(time.getUTCDate(), 2)}`
		+ `-${pad(time.getUTCHours(), 2)}.${pad(time.getUTCMinutes(), 2)}.${pad(time.getUTCSeconds(), 2)}`
		+ `:${pad(time.getUTCMilliseconds(), 3)}`
	return `[${ts}][${String(chainId).padStart(3, ' ')}]`
}

export function idsStr(p: { eos: string; steam: string }): string {
	return `EOS: ${p.eos} steam: ${p.steam}`
}

// ---------- RCON response bodies ----------

export function showCurrentMap(l: LayerLike): string {
	return `Current level is ${l.level}, layer is ${l.layer}, factions ${l.factions}`
}

export function showNextMap(l: LayerLike | null): string {
	if (!l) return ''
	return `Next level is ${l.level}, layer is ${l.layer}, factions ${l.factions}`
}

export function showServerInfo(info: {
	serverName: string
	maxPlayers: number
	playerCount: number
	publicQueue: number
	publicQueueLimit: number
	gameMode: string
	mapName: string
	playTimeSec: number
	nextLayer: LayerLike | null
}): string {
	// field order/extras mirror the tt-scrim-2 capture; the app only consumes a subset
	// (SM.ServerRawInfoSchema) but unknown fields must not break it
	return JSON.stringify({
		MaxPlayers: info.maxPlayers,
		GameMode_s: info.gameMode,
		MapName_s: info.mapName,
		ServerName_s: info.serverName,
		LICENSEDSERVER_b: false,
		PLAYTIME_I: String(info.playTimeSec),
		Flags_I: '7',
		MATCHHOPPER_s: 'TeamDeathmatch',
		MatchTimeout_d: 120,
		SESSIONTEMPLATENAME_s: 'GameSession',
		Password_b: false,
		PlayerCount_I: String(info.playerCount),
		ServerVersion_s: 'v10.5.1.627303.2443',
		PublicQueue_I: String(info.publicQueue),
		PublicQueueLimit_I: String(info.publicQueueLimit),
		ReservedQueue_I: '0',
		BeaconPort_I: '15003',
		TeamTwo_s: 'PLA_S_CombinedArms',
		TeamOne_s: 'USA_S_CombinedArms',
		NextLayer_s: info.nextLayer?.layer ?? '',
		'CurrentModLoadedCount_I': '0',
		'AllModsWhitelisted_b': false,
	})
}

export function listPlayers(players: PlayerLike[], disconnected: PlayerLike[]): string {
	const lines = ['----- Active Players -----']
	let id = 0
	for (const p of players) {
		lines.push(
			`ID: ${id++} | Online IDs: ${idsStr(p)} | Name: ${p.name} | Team ID: ${p.teamId ?? 'N/A'} | Squad ID: ${
				p.squadId ?? 'N/A'
			} | Is Leader: ${p.isLeader ? 'True' : 'False'} | Role: ${p.role}`,
		)
	}
	lines.push('----- Recently Disconnected Players [Max of 15] -----')
	for (const p of disconnected.slice(-15)) {
		lines.push(`ID: ${id++} | Online IDs: ${idsStr(p)} | Since Disconnect: 00m.30s | Name: ${p.name}`)
	}
	return lines.join('\n')
}

export function listSquads(teams: TeamLike[], squads: SquadLike[]): string {
	const lines = ['----- Active Squads -----']
	for (const team of teams) {
		lines.push(`Team ID: ${team.id} (${team.name})`)
		for (const s of squads.filter((s) => s.teamId === team.id)) {
			lines.push(
				`ID: ${s.squadId} | Name: ${s.name} | Size: 1 | Locked: ${
					s.locked ? 'True' : 'False'
				} | Creator Name: ${s.creatorName.trim()} | Creator Online IDs: ${idsStr({ eos: s.creatorEos, steam: s.creatorSteam })}`,
			)
		}
	}
	return lines.join('\n')
}

export function listDisconnectedPlayers(): string {
	return '----- Recently Disconnected Players [Max of 15] -----'
}

export function missingArgument(usage: string, command: string): string {
	return `Missing argument 0: (${usage}). Use "ShowCommandInfo ${command}" to get info on this command.`
}

// ---------- chat-stream (type 1) packet bodies ----------

export type ChatChannel = 'ChatAll' | 'ChatTeam' | 'ChatSquad' | 'ChatAdmin'

export function chatMessage(channel: ChatChannel, p: PlayerLike, message: string): string {
	return `[${channel}] [Online IDs:${idsStr(p)}] ${p.name} : ${message}`
}

export function playerWarnedBody(name: string, reason: string): string {
	return `Remote admin has warned player ${name}. Message was "${reason}"`
}

export function squadCreatedBody(p: PlayerLike, squadId: number, squadName: string, teamName: string): string {
	return `${p.name.trim()} (Online IDs:${idsStr(p)}) has created Squad ${squadId} (Squad Name: ${squadName}) on ${teamName}`
}

export function squadRenamedBody(squadId: number, teamId: number, oldName: string, newName: string): string {
	return `Remote admin renamed squad ${squadId} on team ${teamId}, named "${oldName}", to "${newName}"`
}

export function possessedAdminCamBody(p: PlayerLike): string {
	// note the lowercase 'Ids' -- the real packet differs from the unpossessed variant
	return `[Online Ids:${idsStr(p)}] ${p.name.trim()} has possessed admin camera.`
}

export function unpossessedAdminCamBody(p: PlayerLike): string {
	return `[Online IDs:${idsStr(p)}] ${p.name.trim()} has unpossessed admin camera.`
}

export function playerBannedBody(playerId: number, p: PlayerLike, interval: string): string {
	return `Banned player ${playerId}. [Online IDs=${idsStr(p)}] ${p.name} for interval ${interval}`
}

// ---------- log lines (without header) ----------

export const RCON_SOURCE = 'RCON'

export function playerSource(p: PlayerLike, playerId = 0): string {
	return `player ${playerId}. [Online IDs= ${idsStr(p)}] ${p.name}`
}

export function logAdminCommand(body: string, source: string = RCON_SOURCE): string {
	return `LogSquad: ADMIN COMMAND: ${body} from ${source}`
}

export function logNewGame(l: LayerLike): string {
	return `LogWorld: Bringing World ${l.mapDir}/${l.layer}.${l.layer} up for play (max tick rate 64) at 2026.07.12-15.57.19`
}

export function logMapSet(layerCmdArgs: string, source?: string): string {
	return logAdminCommand(`Set next layer to ${layerCmdArgs}`, source)
}

export function logLayerChanged(layerCmdArgs: string, source?: string): string {
	return logAdminCommand(`Change layer to ${layerCmdArgs}`, source)
}

export function logBroadcast(message: string, source?: string): string {
	return logAdminCommand(`Message broadcasted <${message}>`, source)
}

export function logMatchEnded(source?: string): string {
	return logAdminCommand('Match ended', source)
}

export function logRoundEnded(): string {
	return 'LogGameState: Match State Changed from InProgress to WaitingPostMatch'
}

export function logRoundDecided(kind: 'won' | 'lost', team: TeamLike, faction: string, tickets: number, l: LayerLike): string {
	return `LogSquadGameEvents: Display: Team ${team.id}, ${team.name} ( ${faction} ) has ${kind} the match with ${tickets} Tickets on layer ${l.layer} (level ${l.level})!`
}

export function logPlayerConnected(p: PlayerLike, l: LayerLike): string {
	return `LogSquad: PostLogin: NewPlayer: BP_PlayerController_C ${l.mapDir}/${l.layer}.${l.layer}:PersistentLevel.${p.controllerId} (IP: ${p.ip} | Online IDs: ${
		idsStr(p)
	})`
}

export function logJoinSucceeded(p: PlayerLike): string {
	return `LogNet: Join succeeded: ${p.name.trim()}`
}

export function logAddedToTeam(p: PlayerLike, teamId: number): string {
	return `LogSquad: Player ${p.name} has been added to Team ${teamId}`
}

export function logPlayerDisconnected(p: PlayerLike): string {
	return `LogNet: UNetDriver::RemoveClientConnection - Removed address ${p.ip}:${p.port} from MappedClientConnections for: `
		+ `[UNetConnection] RemoteAddr: ${p.ip}:${p.port}, Name: RedpointEOSIpNetConnection_2147249600, `
		+ `Driver: Name:GameNetDriver Def:GameNetDriver RedpointEOSNetDriver_2147482319, IsServer: YES, `
		+ `PC: ${p.controllerId}, Owner: ${p.controllerId}, UniqueId: RedpointEOS:${p.eos}`
}

export function logForcedTeamChange(p: PlayerLike, playerId: number, source?: string): string {
	return logAdminCommand(`Forced team change for ${playerSource(p, playerId)}`, source)
}

export function logKickingPlayer(p: PlayerLike, reason: string): string {
	return `LogOnlineGame: Display: Kicking player: ${p.name} ; Reason = Kicked from the server: ${reason}`
}

export function logPlayerKicked(p: PlayerLike, playerId: number, source?: string): string {
	return logAdminCommand(`Kicked ${playerSource(p, playerId)}`, source)
}

export function logSquadDisbanded(squadId: number, teamId: number, name: string, source?: string): string {
	return logAdminCommand(`Remote admin disbanded squad ${squadId} on team ${teamId}, named "${name}"`, source)
}

export function logRemovedFromSquad(p: PlayerLike, source?: string): string {
	return logAdminCommand(`Player ${p.name} was removed from squad`, source)
}

export function logPlayerWarned(name: string, reason: string, source?: string): string {
	return logAdminCommand(playerWarnedBody(name, reason), source)
}

export function logSquadRenamed(squadId: number, teamId: number, oldName: string, newName: string, source?: string): string {
	return logAdminCommand(squadRenamedBody(squadId, teamId, oldName, newName), source)
}

export function logPlayerRestarted(p: PlayerLike): string {
	return `LogSquadTrace: [DedicatedServer]RestartPlayer(): On Server PC=${p.name.trim()} Spawn=nullptr DeployRole=${p.role}`
}

export function logWound(victim: PlayerLike, attacker: PlayerLike, damage: number, weapon: string): string {
	return `LogSquadTrace: [DedicatedServer]Wound(): Player: ${victim.name.trim()} KillingDamage=${
		damage.toFixed(6)
	} from ${attacker.controllerId} (Online IDs: ${idsStr(attacker)} | Controller ID: ${attacker.controllerId}) caused by ${weapon}`
}

export function logDie(victim: PlayerLike, attacker: PlayerLike, damage: number, weapon: string): string {
	// 'Contoller' [sic] -- the real Die() line carries this typo, and the app's regex expects it
	return `LogSquadTrace: [DedicatedServer]Die(): Player: ${victim.name.trim()} KillingDamage=${
		damage.toFixed(6)
	} from ${attacker.controllerId} (Online IDs: ${idsStr(attacker)} | Contoller ID: ${attacker.controllerId}) caused by ${weapon}`
}

export function logTickRate(rate: number): string {
	return `LogSquad: USQGameState: Server Tick Rate: ${rate.toFixed(2)}`
}
