import * as Fmt from './format'

// The emulated squad server's world: one mutable model that both protocol frontends render
// from, so RCON responses, chat-stream packets and log lines can never disagree with each
// other. High-level actions (join, chat, endMatch, ...) mutate state and emit on the sinks;
// handleCommand implements the RCON command surface over the same state.

export type WorldSinks = {
	chatPacket: (body: string) => void
	logLine: (line: string) => void
	// AdminChangeLayer travels asynchronously on a real server; the facade schedules the
	// endMatch/startNewGame transition when this fires
	layerChangeRequested?: (layer: Fmt.LayerLike) => void
}

export type WorldOptions = {
	serverName?: string
	maxPlayers?: number
	// injectable for deterministic scenarios
	now?: () => Date
	currentLayer?: Fmt.LayerLike
	nextLayer?: Fmt.LayerLike | null
	// when set, AdminSetNextLayer/AdminChangeLayer reject layers outside this list (for testing
	// error paths). Default: accept any layer, since the app generates from the full layer db.
	knownLayers?: string[]
}

export type EmuPlayer = Fmt.PlayerLike

const DEFAULT_CURRENT: Fmt.LayerLike = {
	level: 'Harju',
	layer: 'Harju_RAAS_v1',
	factions: 'RGF+Mechanized PLA+AirAssault',
	mapDir: '/Harju/Maps/Gameplay_Layers',
}

const COMMAND_USAGE: Record<string, string> = {
	AdminWarn: 'NameOrEOSId',
	AdminKick: 'NameOrSteamId',
	AdminBan: 'NameOrSteamId',
	AdminBroadcast: 'Message',
	AdminSetNextLayer: 'LayerName Faction1+Type Faction2+Type',
	AdminChangeLayer: 'LayerName Faction1+Type Faction2+Type',
	AdminForceTeamChange: 'NameOrSteamId',
	AdminRemovePlayerFromSquad: 'PlayerName',
	AdminDemoteCommander: 'PlayerName',
	AdminDisbandSquad: 'TeamNumber = [1|2]',
	AdminRenameSquad: 'TeamNumber = [1|2]',
}

const COMMAND_INFO: Record<string, string> = {
	AdminWarn: '\nAdminWarn "<NameOrEOSId>" <WarnReason>\n\n         Warns a player from the server for being abusive.\n',
	AdminRenameSquad: '\nAdminRenameSquad <TeamNumber = [1|2]> <SquadIndex>\n\n         Renames the specified Squad\n',
	AdminChangeLayer:
		'\nAdminChangeLayer <LayerName Faction1+Type Faction2+Type>\n\n         Change the layer and travel to it immediately\n',
	AdminSetNextLayer: '\nAdminSetNextLayer <LayerName Faction1+Type Faction2+Type>\n\n         Set the next layer\n',
}

let nextControllerId = 2147400000
let nextIpOctet = 1

export function makePlayer(opts: Partial<EmuPlayer> & { name: string }): EmuPlayer {
	const eos = opts.eos ?? `0002${Math.random().toString(16).slice(2).padEnd(28, '0').slice(0, 28)}`
	const steam = opts.steam ?? `7656119${Math.floor(1000000000 + Math.random() * 8999999999)}`
	return {
		eos,
		steam,
		name: opts.name,
		teamId: opts.teamId ?? null,
		squadId: opts.squadId ?? null,
		isLeader: opts.isLeader ?? false,
		role: opts.role ?? 'USA_Rifleman_01',
		controllerId: opts.controllerId ?? `BP_PlayerController_C_${nextControllerId++}`,
		ip: opts.ip ?? `198.51.100.${((nextIpOctet++ - 1) % 254) + 1}`,
		port: opts.port ?? 50000 + Math.floor(Math.random() * 10000),
	}
}

type EmuSquad = {
	teamId: number
	squadId: number
	name: string
	locked: boolean
	creator: EmuPlayer
}

export class World {
	serverName: string
	maxPlayers: number
	teams: Fmt.TeamLike[] = [
		{ id: 1, name: '205th Separate Motor Rifle Brigade' },
		{ id: 2, name: '161st Air Assault Brigade' },
	]
	currentLayer: Fmt.LayerLike
	nextLayer: Fmt.LayerLike | null
	knownLayers: Set<string> | null
	players = new Map<string, EmuPlayer>()
	disconnected: EmuPlayer[] = []
	squads: EmuSquad[] = []
	matchStartedAt: Date | null = null
	publicQueue = 0
	publicQueueLimit = 25
	fogOfWar: 'on' | 'off' = 'on'
	// A roll reassigns players to the other team index. This is what SLM's team model assumes: it
	// norms team ids to sides A/B keyed on the match ordinal's parity, so a player's side is only
	// stable across matches if their raw team flips with it. Teamswitches queued for the next map
	// depend on it -- without the swap the app finds them already on the side they asked for.
	swapTeamsOnRoll = true

	#sinks: WorldSinks
	#now: () => Date
	#chainId = 100

	constructor(sinks: WorldSinks, opts: WorldOptions = {}) {
		this.#sinks = sinks
		this.#now = opts.now ?? (() => new Date())
		this.serverName = opts.serverName ?? 'SLM Emulated Squad Server'
		this.maxPlayers = opts.maxPlayers ?? 100
		this.currentLayer = opts.currentLayer ?? { ...DEFAULT_CURRENT }
		this.nextLayer = opts.nextLayer !== undefined ? opts.nextLayer : {
			level: 'Sumari Bala',
			layer: 'Sumari_Seed_v1',
			factions: 'RGF VDV',
			mapDir: '/Game/Maps/Sumari/Gameplay_Layers',
		}
		this.knownLayers = opts.knownLayers ? new Set(opts.knownLayers) : null
	}

	// each logical action gets one chainID, like a real server frame
	#log(...lines: string[]) {
		const header = Fmt.logHeader(this.#now(), this.#chainId = (this.#chainId + 1) % 1000)
		for (const line of lines) this.#sinks.logLine(`${header}${line}`)
	}

	#chat(body: string) {
		this.#sinks.chatPacket(body)
	}

	playerList(): EmuPlayer[] {
		return [...this.players.values()]
	}

	playerIdOf(p: EmuPlayer): number {
		return this.playerList().indexOf(p)
	}

	findPlayer(nameOrEosId: string): EmuPlayer | null {
		const q = nameOrEosId.trim()
		for (const p of this.players.values()) {
			if (p.eos === q || p.name.trim() === q) return p
		}
		return null
	}

	findSquad(teamId: number, squadId: number): EmuSquad | null {
		return this.squads.find((s) => s.teamId === teamId && s.squadId === squadId) ?? null
	}

	// ---------- high-level actions (the scenario-driving API) ----------

	connectPlayer(p: EmuPlayer): EmuPlayer {
		if (p.teamId === null) {
			const count = (id: number) => this.playerList().filter((x) => x.teamId === id).length
			p.teamId = count(1) <= count(2) ? 1 : 2
		}
		this.players.set(p.eos, p)
		// one chainID for the whole join chain, like the real server frame
		this.#log(
			Fmt.logPlayerConnected(p, this.currentLayer),
			Fmt.logJoinSucceeded(p),
			Fmt.logAddedToTeam(p, p.teamId),
		)
		return p
	}

	disconnectPlayer(p: EmuPlayer) {
		this.players.delete(p.eos)
		if (p.squadId !== null) this.#dropFromSquad(p)
		this.disconnected.push(p)
		this.#log(Fmt.logPlayerDisconnected(p))
	}

	chat(p: EmuPlayer, channel: Fmt.ChatChannel, message: string) {
		this.#chat(Fmt.chatMessage(channel, p, message))
	}

	createSquad(p: EmuPlayer, name: string): EmuSquad {
		const teamId = p.teamId ?? 1
		const squadId = Math.max(0, ...this.squads.filter((s) => s.teamId === teamId).map((s) => s.squadId)) + 1
		const squad: EmuSquad = { teamId, squadId, name, locked: false, creator: p }
		this.squads.push(squad)
		p.squadId = squadId
		p.isLeader = true
		const teamName = this.teams.find((t) => t.id === teamId)!.name
		this.#chat(Fmt.squadCreatedBody(p, squadId, name, teamName))
		this.#log(`LogSquad: ${Fmt.squadCreatedBody(p, squadId, name, teamName)}`)
		return squad
	}

	leaveSquad(p: EmuPlayer) {
		this.#dropFromSquad(p)
	}

	possessAdminCam(p: EmuPlayer) {
		this.#chat(Fmt.possessedAdminCamBody(p))
	}

	unpossessAdminCam(p: EmuPlayer) {
		this.#chat(Fmt.unpossessedAdminCamBody(p))
	}

	woundPlayer(victim: EmuPlayer, attacker: EmuPlayer, weapon = 'BP_M4_M68') {
		this.#log(Fmt.logWound(victim, attacker, 60, weapon))
	}

	killPlayer(victim: EmuPlayer, attacker: EmuPlayer, weapon = 'BP_M4_M68') {
		this.#log(Fmt.logDie(victim, attacker, 100, weapon))
	}

	reportTickRate(rate: number) {
		this.#log(Fmt.logTickRate(rate))
	}

	endMatch(opts?: { winnerTeamId?: number; source?: string }) {
		const winner = this.teams.find((t) => t.id === (opts?.winnerTeamId ?? 1))!
		const loser = this.teams.find((t) => t.id !== winner.id)!
		const lines = [
			Fmt.logRoundEnded(),
			Fmt.logRoundDecided('won', winner, winner.name, 300, this.currentLayer),
			Fmt.logRoundDecided('lost', loser, loser.name, 0, this.currentLayer),
		]
		if (opts?.source) lines.push(Fmt.logMatchEnded(opts.source))
		this.#log(...lines)
	}

	startNewGame(layer?: Fmt.LayerLike) {
		if (layer) this.nextLayer = layer
		const target = this.nextLayer ?? this.currentLayer

		// the real sequence: the server travels through a transition map, then brings up the destination.
		// The app watches for the transition to know a roll has begun and which layer it expects.
		this.#log(Fmt.logSeamlessTravel(target))
		this.#log(Fmt.logTransitionWorld())
		this.#log(Fmt.logStartLoadingDestination(target))

		this.currentLayer = target
		this.nextLayer = null
		this.matchStartedAt = this.#now()
		for (const p of this.players.values()) {
			p.squadId = null
			p.isLeader = false
			if (this.swapTeamsOnRoll && p.teamId !== null) p.teamId = p.teamId === 1 ? 2 : 1
		}
		this.squads = []
		this.#log(Fmt.logNewGame(this.currentLayer))
	}

	#dropFromSquad(p: EmuPlayer) {
		const squad = p.squadId !== null && p.teamId !== null ? this.findSquad(p.teamId, p.squadId) : null
		p.squadId = null
		p.isLeader = false
		if (squad && !this.playerList().some((x) => x.teamId === squad.teamId && x.squadId === squad.squadId)) {
			this.squads = this.squads.filter((s) => s !== squad)
		}
	}

	// ---------- RCON command surface ----------

	// returns the response body; empty string mirrors the real server's silence on unknown commands
	handleCommand(body: string): string {
		const [verb] = body.trim().split(/\s+/, 1)
		const rest = body.trim().slice(verb.length).trim()

		switch (verb) {
			case 'ShowServerInfo':
				return Fmt.showServerInfo({
					serverName: this.serverName,
					maxPlayers: this.maxPlayers,
					playerCount: this.players.size,
					publicQueue: this.publicQueue,
					publicQueueLimit: this.publicQueueLimit,
					gameMode: this.currentLayer.layer.split('_')[1] ?? 'RAAS',
					mapName: this.currentLayer.layer,
					playTimeSec: Math.max(0, Math.floor((this.#now().getTime() - (this.matchStartedAt?.getTime() ?? this.#now().getTime())) / 1000)),
					nextLayer: this.nextLayer,
				})
			case 'ShowCurrentMap':
				return Fmt.showCurrentMap(this.currentLayer)
			case 'ShowNextMap':
				return Fmt.showNextMap(this.nextLayer)
			case 'ListPlayers':
				return Fmt.listPlayers(this.playerList(), this.disconnected)
			case 'ListSquads':
				return Fmt.listSquads(
					this.teams,
					this.squads.map((s) => ({
						teamId: s.teamId,
						squadId: s.squadId,
						name: s.name,
						locked: s.locked,
						creatorName: s.creator.name,
						creatorEos: s.creator.eos,
						creatorSteam: s.creator.steam,
					})),
				)
			case 'AdminListDisconnectedPlayers':
				return Fmt.listDisconnectedPlayers()
			case 'ShowCommandInfo':
				return COMMAND_INFO[rest] ?? ''
			case 'AdminBroadcast': {
				if (!rest) return Fmt.missingArgument(COMMAND_USAGE[verb], verb)
				this.#log(Fmt.logBroadcast(rest))
				return `Message broadcasted <${rest}>`
			}
			case 'AdminWarn': {
				if (!rest) return Fmt.missingArgument(COMMAND_USAGE[verb], verb)
				const match = rest.match(/^"([^"]+)"\s*(.*)$/s) ?? rest.match(/^(\S+)\s*(.*)$/s)
				if (!match) return Fmt.missingArgument(COMMAND_USAGE[verb], verb)
				const [, target, reason] = match
				const p = this.findPlayer(target)
				if (!p) {
					const msg = `Could not find player ${target}`
					this.#chat(msg)
					return msg
				}
				const bodyStr = Fmt.playerWarnedBody(p.name, reason)
				this.#chat(bodyStr)
				this.#log(Fmt.logPlayerWarned(p.name, reason))
				return bodyStr
			}
			case 'AdminSetNextLayer': {
				if (!rest) return Fmt.missingArgument(COMMAND_USAGE[verb], verb)
				const layerName = rest.split(/\s+/)[0]
				if (this.knownLayers && !this.knownLayers.has(layerName)) {
					return `ERROR: Unable to set next layer : layer Not Found : ${layerName}`
				}
				this.nextLayer = this.#toLayerLike(rest)
				this.#log(Fmt.logMapSet(rest))
				return `Set next layer to ${rest}`
			}
			case 'AdminChangeLayer': {
				if (!rest) return Fmt.missingArgument(COMMAND_USAGE[verb], verb)
				const layerName = rest.split(/\s+/)[0]
				if (this.knownLayers && !this.knownLayers.has(layerName)) {
					return `ERROR: Unable to change layer : layer Not Found : ${layerName}`
				}
				this.#log(Fmt.logLayerChanged(rest))
				this.#sinks.layerChangeRequested?.(this.#toLayerLike(rest))
				return `Change layer to ${rest}`
			}
			case 'AdminForceTeamChange': {
				if (!rest) return Fmt.missingArgument(COMMAND_USAGE[verb], verb)
				const p = this.findPlayer(rest.replace(/^"|"$/g, ''))
				if (!p) return `Could not find player ${rest}`
				const playerId = this.playerIdOf(p)
				p.teamId = p.teamId === 1 ? 2 : 1
				this.#dropFromSquad(p)
				this.#log(Fmt.logForcedTeamChange(p, playerId))
				return `Forced team change for player ${playerId}. ${p.name}`
			}
			case 'AdminKick': {
				if (!rest) return Fmt.missingArgument(COMMAND_USAGE[verb], verb)
				const match = rest.match(/^"([^"]+)"\s*(.*)$/s) ?? rest.match(/^(\S+)\s*(.*)$/s)
				const [, target, reason] = match!
				const p = this.findPlayer(target)
				if (!p) return `Could not find player ${target}`
				const playerId = this.playerIdOf(p)
				this.#log(
					Fmt.logKickingPlayer(p, reason || 'Kicked by admin'),
					Fmt.logPlayerKicked(p, playerId),
				)
				this.players.delete(p.eos)
				this.disconnected.push(p)
				this.#log(Fmt.logPlayerDisconnected(p))
				return `Kicked player ${playerId}. ${p.name}`
			}
			case 'AdminDisbandSquad': {
				const [teamStr, squadStr] = rest.split(/\s+/)
				if (!teamStr || !squadStr) return Fmt.missingArgument(COMMAND_USAGE.AdminDisbandSquad, verb)
				const squad = this.findSquad(Number(teamStr), Number(squadStr))
				if (!squad) return `Could not find squad ${squadStr} on team ${teamStr}`
				for (const p of this.playerList()) {
					if (p.teamId === squad.teamId && p.squadId === squad.squadId) {
						p.squadId = null
						p.isLeader = false
					}
				}
				this.squads = this.squads.filter((s) => s !== squad)
				this.#log(Fmt.logSquadDisbanded(squad.squadId, squad.teamId, squad.name))
				return `Disbanded squad ${squad.squadId} on team ${squad.teamId}`
			}
			case 'AdminRenameSquad': {
				const [teamStr, squadStr] = rest.split(/\s+/)
				if (!teamStr || !squadStr) return Fmt.missingArgument(COMMAND_USAGE.AdminRenameSquad, verb)
				const squad = this.findSquad(Number(teamStr), Number(squadStr))
				if (!squad) return `Could not find squad ${squadStr} on team ${teamStr}`
				const oldName = squad.name
				squad.name = `Squad ${squad.squadId}`
				const line = Fmt.squadRenamedBody(squad.squadId, squad.teamId, oldName, squad.name)
				this.#chat(line)
				this.#log(Fmt.logSquadRenamed(squad.squadId, squad.teamId, oldName, squad.name))
				// the real server duplicates the rename line in the command response
				return `${line}\n${line}`
			}
			case 'AdminRemovePlayerFromSquad': {
				if (!rest) return Fmt.missingArgument(COMMAND_USAGE.AdminRemovePlayerFromSquad, verb)
				const p = this.findPlayer(rest.replace(/^"|"$/g, ''))
				if (!p) return `Could not find player ${rest}`
				this.#dropFromSquad(p)
				this.#log(Fmt.logRemovedFromSquad(p))
				return `Player ${p.name.trim()} was removed from squad`
			}
			case 'AdminDemoteCommander': {
				if (!rest) return Fmt.missingArgument(COMMAND_USAGE.AdminDemoteCommander, verb)
				return ''
			}
			case 'AdminEndMatch': {
				this.endMatch({ source: Fmt.RCON_SOURCE })
				return ''
			}
			case 'AdminSetFogOfWar': {
				if (rest === 'on' || rest === 'off') this.fogOfWar = rest
				return ''
			}
			default:
				return ''
		}
	}

	#toLayerLike(cmdArgs: string): Fmt.LayerLike {
		const [layer, f1, f2] = cmdArgs.split(/\s+/)
		const level = layer.split('_')[0]
		return {
			level,
			layer,
			factions: f1 && f2 ? `${f1} ${f2}` : 'USA GFI',
			mapDir: `/Game/Maps/${level}/Gameplay_Layers`,
		}
	}
}
