import * as M from '@/models'
import * as C from '@/server/context.ts'

import { exclude } from '../object'
import { capitalID, iterateIDs, lowerID } from './id-parser'
import * as SM from './squad-models'

export async function processChatPacket(ctx: C.Log & C.Rcon, decodedPacket: any) {
	const matchChat = decodedPacket.body.match(/\[(ChatAll|ChatTeam|ChatSquad|ChatAdmin)] \[Online IDs:([^\]]+)\] (.+?) : (.*)/)
	if (matchChat) {
		ctx.log.info(`Matched chat message: ${decodedPacket.body}`)

		const result: any = {
			raw: decodedPacket.body,
			chat: matchChat[1],
			name: matchChat[3],
			message: matchChat[4],
			time: new Date(),
		}
		iterateIDs(matchChat[2]).forEach((platform, id) => {
			result[lowerID(platform)] = id
		})
		const parsedResult = SM.ChatMessageSchema.parse(result)
		ctx.rcon.emit('CHAT_MESSAGE', parsedResult)
		return
	}

	const matchPossessedAdminCam = decodedPacket.body.match(/\[Online Ids:([^\]]+)\] (.+) has possessed admin camera\./)
	if (matchPossessedAdminCam) {
		ctx.log.info(`Matched admin camera possessed: ${decodedPacket.body}`)
		const result: any = {
			raw: decodedPacket.body,
			name: matchPossessedAdminCam[2],
			time: new Date(),
		}
		iterateIDs(matchPossessedAdminCam[1]).forEach((platform, id) => {
			result[lowerID(platform)] = id
		})
		const parsedResult = SM.AdminCameraSchema.parse(result)
		ctx.rcon.emit('POSSESSED_ADMIN_CAMERA', parsedResult)
		return
	}

	const matchUnpossessedAdminCam = decodedPacket.body.match(/\[Online IDs:([^\]]+)\] (.+) has unpossessed admin camera\./)
	if (matchUnpossessedAdminCam) {
		ctx.log.info(`Matched admin camera unpossessed: ${decodedPacket.body}`)
		const result: any = {
			raw: decodedPacket.body,
			name: matchUnpossessedAdminCam[2],
			time: new Date(),
		}
		iterateIDs(matchUnpossessedAdminCam[1]).forEach((platform, id) => {
			result[lowerID(platform)] = id
		})
		const parsedResult = SM.AdminCameraSchema.parse(result)
		ctx.rcon.emit('UNPOSSESSED_ADMIN_CAMERA', parsedResult)
		return
	}

	const matchWarn = decodedPacket.body.match(/Remote admin has warned player (.*)\. Message was "(.*)"/)
	if (matchWarn) {
		ctx.log.info(`Matched warn message: ${decodedPacket.body}`)

		const result = {
			raw: decodedPacket.body,
			name: matchWarn[1],
			reason: matchWarn[2],
			time: new Date(),
		}
		const parsedResult = SM.WarnMessageSchema.parse(result)
		ctx.rcon.emit('PLAYER_WARNED', parsedResult)
		return
	}

	const matchKick = decodedPacket.body.match(/Kicked player ([0-9]+)\. \[Online IDs=([^\]]+)\] (.*)/)
	if (matchKick) {
		ctx.log.info(`Matched kick message: ${decodedPacket.body}`)

		const result: any = {
			raw: decodedPacket.body,
			playerID: matchKick[1],
			name: matchKick[3],
			time: new Date(),
		}
		iterateIDs(matchKick[2]).forEach((platform, id) => {
			result[lowerID(platform)] = id
		})
		const parsedResult = SM.KickMessageSchema.parse(result)
		ctx.rcon.emit('PLAYER_KICKED', parsedResult)
		return
	}

	const matchSqCreated = decodedPacket.body.match(
		/(?<playerName>.+) \(Online IDs:([^)]+)\) has created Squad (?<squadID>\d+) \(Squad Name: (?<squadName>.+)\) on (?<teamName>.+)/
	)
	if (matchSqCreated) {
		ctx.log.info(`Matched Squad Created: ${decodedPacket.body}`)
		const result: any = {
			time: new Date(),
			...matchSqCreated.groups,
		}
		iterateIDs(matchSqCreated[2]).forEach((platform, id) => {
			result['player' + capitalID(platform)] = id
		})
		const parsedResult = SM.SquadCreatedSchema.parse(result)
		ctx.rcon.emit('SQUAD_CREATED', parsedResult)
		return
	}

	const matchBan = decodedPacket.body.match(/Banned player ([0-9]+)\. \[Online IDs=([^\]]+)\] (.*) for interval (.*)/)
	if (matchBan) {
		ctx.log.info(`Matched ban message: ${decodedPacket.body}`)

		const result: any = {
			raw: decodedPacket.body,
			playerID: matchBan[1],
			name: matchBan[3],
			interval: matchBan[4],
			time: new Date(),
		}
		iterateIDs(matchBan[2]).forEach((platform, id) => {
			result[lowerID(platform)] = id
		})
		const parsedResult = SM.BanMessageSchema.parse(result)
		ctx.rcon.emit('PLAYER_BANNED', parsedResult)
	}
}

export async function getCurrentMap(ctx: C.Log & C.Rcon): Promise<M.MiniLayer> {
	const response = await ctx.rcon.execute(exclude(ctx, ['rcon']), 'ShowCurrentMap')
	const match = response.match(/^Current level is (.*), layer is (.*), factions (.*)/)
	const layer = match[2]
	const factions = match[3]
	return parseLayer(layer, factions)
}

export async function getNextLayer(ctx: C.Log & C.Rcon) {
	const response = await ctx.rcon.execute(exclude(ctx, ['rcon']), 'ShowNextMap')
	const match = response.match(/^Next level is (.*), layer is (.*), factions (.*)/)
	const layer = match[2]
	const factions = match[3]
	if (!layer || !factions) return null
	return parseLayer(layer, factions)
}

export async function getListPlayers(ctx: C.Log & C.Rcon) {
	const response = await ctx.rcon.execute(exclude(ctx, ['rcon']), 'ListPlayers')

	const players: SM.Player[] = []

	if (!response || response.length < 1) return players

	for (const line of response.split('\n')) {
		const match = line.match(
			/^ID: (?<playerID>\d+) \| Online IDs:([^|]+)\| Name: (?<name>.+) \| Team ID: (?<teamID>\d|N\/A) \| Squad ID: (?<squadID>\d+|N\/A) \| Is Leader: (?<isLeader>True|False) \| Role: (?<role>.+)$/
		)
		if (!match) continue

		const data = match.groups
		data.playerID = +data.playerID
		data.isLeader = data.isLeader === 'True'
		data.teamID = data.teamID !== 'N/A' ? +data.teamID : null
		data.squadID = data.squadID !== 'N/A' ? +data.squadID : null
		iterateIDs(match[2]).forEach((platform, id) => {
			data[lowerID(platform)] = id
		})
		const parsedData = SM.PlayerSchema.parse(data)
		players.push(parsedData)
	}
	return players
}

export async function getSquads(ctx: C.Log & C.Rcon) {
	const responseSquad = await ctx.rcon.execute(exclude(ctx, ['rcon']), 'ListSquads')

	const squads: SM.Squad[] = []
	let teamName
	let teamID

	if (!responseSquad || responseSquad.length < 1) return squads

	for (const line of responseSquad.split('\n')) {
		const match = line.match(
			/ID: (?<squadID>\d+) \| Name: (?<squadName>.+) \| Size: (?<size>\d+) \| Locked: (?<locked>True|False) \| Creator Name: (?<creatorName>.+) \| Creator Online IDs:([^|]+)/
		)
		const matchSide = line.match(/Team ID: (\d) \((.+)\)/)
		if (matchSide) {
			teamID = +matchSide[1]
			teamName = matchSide[2]
		}
		if (!match) continue
		match.groups.squadID = +match.groups.squadID
		const squad = {
			...match.groups,
			teamID: teamID,
			teamName: teamName,
		}
		iterateIDs(match[6]).forEach((platform, id) => {
			squad['creator' + capitalID(platform)] = id
		})
		const parsed = SM.SquadSchema.parse(squad)
		squads.push(parsed)
	}
	return squads
}

export async function broadcast(ctx: C.Log & C.Rcon, message: string) {
	await ctx.rcon.execute(exclude(ctx, ['rcon']), `AdminBroadcast ${message}`)
}

export async function setFogOfWar(ctx: C.Log & C.Rcon, mode: string) {
	await ctx.rcon.execute(exclude(ctx, ['rcon']), `AdminSetFogOfWar ${mode}`)
}

export async function warn(ctx: C.Log & C.Rcon, anyID: string, message: string) {
	await ctx.rcon.execute(exclude(ctx, ['rcon']), `AdminWarn "${anyID}" ${message}`)
}

// 0 = Perm | 1m = 1 minute | 1d = 1 Day | 1M = 1 Month | etc...
export async function ban(ctx: C.Log & C.Rcon, anyID: string, banLength: string, message: string) {
	await ctx.rcon.execute(exclude(ctx, ['rcon']), `AdminBan "${anyID}" ${banLength} ${message}`)
}

export async function switchTeam(ctx: C.Log & C.Rcon, anyID: string) {
	await ctx.rcon.execute(exclude(ctx, ['rcon']), `AdminForceTeamChange "${anyID}"`)
}

export async function setNextLayer(ctx: C.Log & C.Rcon, layer: M.AdminSetNextLayerOptions) {
	await ctx.rcon.execute(exclude(ctx, ['rcon']), M.getAdminSetNextLayerCommand(layer))
}

export async function endGame(_ctx: C.Log & C.Rcon) {}

export async function leaveSquad(ctx: C.Log & C.Rcon, playerId: number) {
	await ctx.rcon.execute(exclude(ctx, ['rcon']), `AdminForceRemoveFromSquad ${playerId}`)
}

export async function getPlayerQueueLength(ctx: C.Log & C.Rcon): Promise<number> {
	const response = await ctx.rcon.execute(exclude(ctx, ['rcon']), 'ListPlayers')
	const match = response.match(/\[Players in Queue: (\d+)\]/)
	return match ? parseInt(match[1], 10) : 0
}

export async function getCurrentLayer(ctx: C.Log & C.Rcon): Promise<M.MiniLayer> {
	const response = await ctx.rcon.execute(exclude(ctx, ['rcon']), 'ShowCurrentMap')
	const match = response.match(/^Current level is (.*), layer is (.*), factions (.*)/)
	const layer = match[2]
	const factions = match[3]
	return parseLayer(layer, factions)
}

export async function getServerStatus(ctx: C.Log & C.Rcon): Promise<SM.ServerStatus> {
	const rawData = await ctx.rcon.execute(exclude(ctx, ['rcon']), `ShowServerInfo`)
	ctx.log.debug('SquadServer', 3, `Server information raw data`, rawData)
	const data = JSON.parse(rawData)
	const rawInfo = SM.ServerRawInfoSchema.parse(data)
	return {
		name: rawInfo.ServerName_s,
		maxPlayers: rawInfo.MaxPlayers,
		reserveSlots: rawInfo.PlayerReserveCount_I,
		currentPlayers: rawInfo.PlayerCount_I,
		currentPlayersInQueue: rawInfo.PublicQueue_I,
	}
}

function parseLayer(layer: string, factions: string): M.MiniLayer {
	const { level, gamemode, version } = M.parseLayerString(layer)
	const [faction1, faction2] = parseLayerFactions(factions)
	const layerIdArgs: M.LayerIdArgs = {
		Level: level,
		Gamemode: gamemode,
		LayerVersion: version,
		Faction_1: faction1.faction,
		SubFac_1: faction1.subFaction as M.MiniLayer['SubFac_1'],
		Faction_2: faction2.faction,
		SubFac_2: faction2.subFaction as M.MiniLayer['SubFac_2'],
	}
	const miniLayer = {
		...layerIdArgs,
		id: M.getLayerId(layerIdArgs),
		Layer: layer,
	} as M.MiniLayer
	return M.MiniLayerSchema.parse(miniLayer)
}

type ParsedFaction = {
	faction: string
	subFaction: string | null
}

function parseLayerFactions(factionsRaw: string) {
	const parsedFactions: ParsedFaction[] = []
	for (const factionRaw of factionsRaw.split(/\s/)) {
		const [faction, subFaction] = factionRaw.split('+')
		parsedFactions.push({
			faction: faction.trim(),
			subFaction: subFaction?.trim() || null,
		})
	}
	return parsedFactions as [ParsedFaction, ParsedFaction]
}
