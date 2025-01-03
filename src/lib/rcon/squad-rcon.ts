import { Subject } from 'rxjs'
import { AsyncResource } from '@/lib/async'

import * as M from '@/models'
import * as C from '@/server/context.ts'

import { capitalID, iterateIDs, lowerID } from './id-parser'
import Rcon, { DecodedPacket } from './rcon-core'
import * as SM from './squad-models'

export default class SquadRcon {
	event$: Subject<SM.SquadEvent> = new Subject()

	serverStatus: AsyncResource<SM.ServerStatus>
	playerList: AsyncResource<SM.Player[]>
	squadList: AsyncResource<SM.Squad[]>

	constructor(
		ctx: C.Log,
		private rcon: Rcon
	) {
		if (!rcon.connected) {
			throw new Error('Rcon must be connected before creating SquadRcon instance')
		}
		this.serverStatus = new AsyncResource('serverStatus', (ctx) => this.getServerStatus(ctx))
		this.playerList = new AsyncResource('playerList', (ctx) => this.getListPlayers(ctx))
		this.squadList = new AsyncResource('squadList', (ctx) => this.getSquads(ctx))

		const onServerMsg = (pkt: DecodedPacket) => {
			const message = processChatPacket(ctx, pkt)
			if (message === null) return
			this.event$.next({ type: 'chat-message', message })
		}
		rcon.on('server', onServerMsg)
		this[Symbol.dispose] = () => {
			rcon.off('server', onServerMsg)
		}
	}

	[Symbol.dispose]() {}

	private async getCurrentLayer(ctx: C.Log) {
		const response = await this.rcon.execute(ctx, 'ShowCurrentMap')
		const match = response.match(/^Current level is (.*), layer is (.*), factions (.*)/)
		const layer = match[2]
		const factions = match[3]
		return parseLayer(layer, factions)
	}

	private async getNextLayer(ctx: C.Log) {
		const response = await this.rcon.execute(ctx, 'ShowNextMap')
		if (!response) return null
		const match = response.match(/^Next level is (.*), layer is (.*), factions (.*)/)
		if (!match) return null
		const layer = match[2]
		const factions = match[3]
		if (!layer || !factions) return null
		return parseLayer(layer, factions)
	}

	private async getListPlayers(ctx: C.Log) {
		const response = await this.rcon.execute(ctx, 'ListPlayers')

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

	async getSquads(ctx: C.Log) {
		const responseSquad = await this.rcon.execute(ctx, 'ListSquads')

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

	async broadcast(ctx: C.Log, message: string) {
		ctx.log.info(`Broadcasting message: %s`, message)
		await this.rcon.execute(ctx, `AdminBroadcast ${message}`)
	}

	async setFogOfWar(ctx: C.Log, mode: string) {
		await this.rcon.execute(ctx, `AdminSetFogOfWar ${mode}`)
	}

	async warn(ctx: C.Log, anyID: string, message: string) {
		await this.rcon.execute(ctx, `AdminWarn "${anyID}" ${message}`)
	}

	// 0 = Perm | 1m = 1 minute | 1d = 1 Day | 1M = 1 Month | etc...
	async ban(ctx: C.Log, anyID: string, banLength: string, message: string) {
		await this.rcon.execute(ctx, `AdminBan "${anyID}" ${banLength} ${message}`)
	}

	async switchTeam(ctx: C.Log, anyID: string) {
		await this.rcon.execute(ctx, `AdminForceTeamChange "${anyID}"`)
		this.playerList.invalidate(ctx)
		this.squadList.invalidate(ctx)
	}

	async setNextLayer(ctx: C.Log, layer: M.AdminSetNextLayerOptions) {
		await this.rcon.execute(ctx, M.getAdminSetNextLayerCommand(layer))
		this.serverStatus.invalidate(ctx)
	}

	async endGame(_ctx: C.Log) {
		throw new Error('Method not implemented.')
	}

	async leaveSquad(ctx: C.Log, playerId: number) {
		await this.rcon.execute(ctx, `AdminForceRemoveFromSquad ${playerId}`)
		this.squadList.invalidate(ctx)
		this.playerList.invalidate(ctx)
	}

	private async getPlayerQueueLength(ctx: C.Log): Promise<number> {
		const response = await this.rcon.execute(ctx, 'ListPlayers')
		const match = response.match(/\[Players in Queue: (\d+)\]/)
		return match ? parseInt(match[1], 10) : 0
	}

	private async getServerStatus(_ctx: C.Log): Promise<SM.ServerStatus> {
		using ctx = C.pushOperation(_ctx, 'squad-rcon:getServerstatus', { level: 'trace' })
		const rawDataPromise = this.rcon.execute(ctx, `ShowServerInfo`)
		const currentLayerTask = this.getCurrentLayer(ctx)
		const nextLayerTask = this.getNextLayer(ctx)
		const rawData = await rawDataPromise
		const data = JSON.parse(rawData)
		const res = SM.ServerRawInfoSchema.safeParse(data)
		if (!res.success) {
			ctx.log.error(`Failed to parse server info: %O, %O`, res.error, data)
			throw res.error
		}

		const rawInfo = res.data

		const status = {
			name: rawInfo.ServerName_s,
			currentLayer: await currentLayerTask,
			nextLayer: await nextLayerTask,
			maxPlayers: rawInfo.MaxPlayers,
			currentPlayers: rawInfo.PlayerCount_I,
		}
		return status
	}
}

function parseLayer(layer: string, factions: string): M.PossibleUnknownMiniLayer {
	const { level: level, gamemode, version: version } = M.parseLayerString(layer)
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
	const res = M.MiniLayerSchema.safeParse(miniLayer)
	if (res.success) return { code: 'known', layer: res.data }
	return {
		code: 'unknown',
		layerString: layer,
		factionString: factions,
	}
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

function processChatPacket(ctx: C.Log, decodedPacket: DecodedPacket) {
	const matchChat = decodedPacket.body.match(/\[(ChatAll|ChatTeam|ChatSquad|ChatAdmin)] \[Online IDs:([^\]]+)\] (.+?) : (.*)/)
	if (matchChat) {
		ctx.log.trace(`Matched chat message: %s`, decodedPacket.body)

		const result = {
			raw: decodedPacket.body,
			chat: matchChat[1],
			name: matchChat[3],
			message: matchChat[4],
			time: new Date(),
			steamID: undefined as string | undefined,
			eosID: undefined as string | undefined,
			playerId: null as unknown as string,
		}

		iterateIDs(matchChat[2]).forEach((platform, id) => {
			//@ts-expect-error not typesafe
			result[lowerID(platform)] = id
		})
		result.playerId = (result.steamID || result.eosID)!
		ctx.log.info(result)
		return SM.ChatMessageSchema.parse(result)
	}

	const matchWarn = decodedPacket.body.match(/Remote admin has warned player (.*)\. Message was "(.*)"/)
	if (matchWarn) {
		ctx.log.trace(`Matched warn message: %s`, decodedPacket.body)
	}
	return null
}
