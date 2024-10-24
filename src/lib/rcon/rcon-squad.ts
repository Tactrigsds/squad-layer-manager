import * as M from '@/models'

import { capitalID, iterateIDs, lowerID } from './id-parser'
import Rcon from './rcon-core'
import {
	AdminCameraSchema,
	BanMessageSchema,
	ChatMessageSchema,
	ISquadRcon,
	KickMessageSchema,
	Player,
	PlayerSchema,
	ServerInfo,
	Squad,
	SquadCreatedSchema,
	SquadSchema,
	WarnMessageSchema,
} from './squad-models'

export default class SquadRcon extends Rcon implements ISquadRcon {
	processChatPacket(decodedPacket: any) {
		const matchChat = decodedPacket.body.match(/\[(ChatAll|ChatTeam|ChatSquad|ChatAdmin)] \[Online IDs:([^\]]+)\] (.+?) : (.*)/)
		if (matchChat) {
			this.log.info(`Matched chat message: ${decodedPacket.body}`)

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
			const parsedResult = ChatMessageSchema.parse(result)
			this.emit('CHAT_MESSAGE', parsedResult)
			return
		}

		const matchPossessedAdminCam = decodedPacket.body.match(/\[Online Ids:([^\]]+)\] (.+) has possessed admin camera\./)
		if (matchPossessedAdminCam) {
			this.log.info(`Matched admin camera possessed: ${decodedPacket.body}`)
			const result: any = {
				raw: decodedPacket.body,
				name: matchPossessedAdminCam[2],
				time: new Date(),
			}
			iterateIDs(matchPossessedAdminCam[1]).forEach((platform, id) => {
				result[lowerID(platform)] = id
			})
			const parsedResult = AdminCameraSchema.parse(result)
			this.emit('POSSESSED_ADMIN_CAMERA', parsedResult)
			return
		}

		const matchUnpossessedAdminCam = decodedPacket.body.match(/\[Online IDs:([^\]]+)\] (.+) has unpossessed admin camera\./)
		if (matchUnpossessedAdminCam) {
			this.log.info(`Matched admin camera unpossessed: ${decodedPacket.body}`)
			const result: any = {
				raw: decodedPacket.body,
				name: matchUnpossessedAdminCam[2],
				time: new Date(),
			}
			iterateIDs(matchUnpossessedAdminCam[1]).forEach((platform, id) => {
				result[lowerID(platform)] = id
			})
			const parsedResult = AdminCameraSchema.parse(result)
			this.emit('UNPOSSESSED_ADMIN_CAMERA', parsedResult)
			return
		}

		const matchWarn = decodedPacket.body.match(/Remote admin has warned player (.*)\. Message was "(.*)"/)
		if (matchWarn) {
			this.log.info(`Matched warn message: ${decodedPacket.body}`)

			const result = {
				raw: decodedPacket.body,
				name: matchWarn[1],
				reason: matchWarn[2],
				time: new Date(),
			}
			const parsedResult = WarnMessageSchema.parse(result)
			this.emit('PLAYER_WARNED', parsedResult)
			return
		}

		const matchKick = decodedPacket.body.match(/Kicked player ([0-9]+)\. \[Online IDs=([^\]]+)\] (.*)/)
		if (matchKick) {
			this.log.info(`Matched kick message: ${decodedPacket.body}`)

			const result: any = {
				raw: decodedPacket.body,
				playerID: matchKick[1],
				name: matchKick[3],
				time: new Date(),
			}
			iterateIDs(matchKick[2]).forEach((platform, id) => {
				result[lowerID(platform)] = id
			})
			const parsedResult = KickMessageSchema.parse(result)
			this.emit('PLAYER_KICKED', parsedResult)
			return
		}

		const matchSqCreated = decodedPacket.body.match(
			/(?<playerName>.+) \(Online IDs:([^)]+)\) has created Squad (?<squadID>\d+) \(Squad Name: (?<squadName>.+)\) on (?<teamName>.+)/
		)
		if (matchSqCreated) {
			this.log.info(`Matched Squad Created: ${decodedPacket.body}`)
			const result: any = {
				time: new Date(),
				...matchSqCreated.groups,
			}
			iterateIDs(matchSqCreated[2]).forEach((platform, id) => {
				result['player' + capitalID(platform)] = id
			})
			const parsedResult = SquadCreatedSchema.parse(result)
			this.emit('SQUAD_CREATED', parsedResult)
			return
		}

		const matchBan = decodedPacket.body.match(/Banned player ([0-9]+)\. \[Online IDs=([^\]]+)\] (.*) for interval (.*)/)
		if (matchBan) {
			this.log.info(`Matched ban message: ${decodedPacket.body}`)

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
			const parsedResult = BanMessageSchema.parse(result)
			this.emit('PLAYER_BANNED', parsedResult)
		}
	}

	async getCurrentMap(): Promise<M.MiniLayer> {
		const response = await this.execute('ShowCurrentMap')
		const match = response.match(/^Current level is (.*), layer is (.*), factions (.*)/)
		return { level: match[1], layer: match[2], factions: match[3] }
	}

	async getNextMap() {
		const response = await this.execute('ShowNextMap')
		const match = response.match(/^Next level is (.*), layer is (.*), factions (.*)/)
		return {
			level: match ? (match[1] !== '' ? match[1] : null) : null,
			layer: match ? (match[2] !== 'To be voted' ? match[2] : null) : null,
			factions: match ? (match[3] !== '' ? match[3] : null) : null,
		}
	}

	async getListPlayers() {
		const response = await this.execute('ListPlayers')

		const players: Player[] = []

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
			const parsedData = PlayerSchema.parse(data)
			players.push(parsedData)
		}
		return players
	}

	async getSquads() {
		const responseSquad = await this.execute('ListSquads')

		const squads: Squad[] = []
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
			const parsed = SquadSchema.parse(squad)
			squad.push(parsed)
		}
		return squads
	}

	async broadcast(message: string) {
		await this.execute(`AdminBroadcast ${message}`)
	}

	async setFogOfWar(mode: string) {
		await this.execute(`AdminSetFogOfWar ${mode}`)
	}

	async warn(anyID: string, message: string) {
		await this.execute(`AdminWarn "${anyID}" ${message}`)
	}

	// 0 = Perm | 1m = 1 minute | 1d = 1 Day | 1M = 1 Month | etc...
	async ban(anyID: string, banLength: string, message: string) {
		await this.execute(`AdminBan "${anyID}" ${banLength} ${message}`)
	}

	async switchTeam(anyID: string) {
		await this.execute(`AdminForceTeamChange "${anyID}"`)
	}

	async setNextLayer(layer: M.AdminSetNextLayerOptions) {
		await this.execute(M.getAdminSetNextLayerCommand(layer))
	}
	async endGame() {}
	async leaveSquad(playerId: number) {
		await this.execute(`AdminForceRemoveFromSquad ${playerId}`)
	}

	async getPlayerQueueLength(): Promise<number> {
		const response = await this.execute('ListPlayers')
		const match = response.match(/\[Players in Queue: (\d+)\]/)
		return match ? parseInt(match[1], 10) : 0
	}

	async getCurrentLayer(): Promise<M.MiniLayer> {
		return this.getCurrentMap()
	}

	async getNextLayer(): Promise<M.MiniLayer | null> {
		const nextMap = await this.getNextMap()
		if (nextMap.level && nextMap.layer && nextMap.factions) {
			return nextMap as M.MiniLayer
		}
		return null
	}

	get info(): ServerInfo {
		return {
			maxPlayers: this.server,
			name: this.serverName,
		}
	}
}
