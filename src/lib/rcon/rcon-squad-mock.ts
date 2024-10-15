import { sleep } from '@/lib/async'
import * as RM from '@/lib/rcon/squad-models'
import * as M from '@/models'
import * as DB from '@/server/db.ts'
import { Logger } from '@/server/logger'
import * as Schema from '@/server/schema.ts'
import { sql } from 'drizzle-orm'
import { Subject } from 'rxjs'

export type ServerState = {
	currentMap: M.MiniLayer
	nextMap: M.MiniLayer
	players: RM.Player[]
	playerQueue: RM.Player[]
	squads: RM.Squad[]
	fogOfWar: string
}

export class MockSquadRcon implements RM.ISquadRcon {
	serverState!: ServerState
	minLatency = 10
	maxLatency = 11
	log: Logger
	event$ = new Subject<RM.SquadEvent>()
	maxPlayers: number = 100
	info: RM.ServerInfo

	constructor(
		options: {
			name?: string
			maxPlayers?: number
		} = {},
		ctx: { log: Logger }
	) {
		this.info = {
			maxPlayers: options.maxPlayers ?? 100,
			name: options.name ?? 'Mock Squad Server',
		}
		this.log = ctx.log.child({ module: 'rcon-squad' })
	}

	async simulateLatency() {
		const latency = Math.random() * (this.maxLatency - this.minLatency) + this.minLatency
		await sleep(latency)
	}

	async connect(): Promise<void> {
		await this.simulateLatency()
		this.serverState = {
			currentMap: await this.getRandomLayer(),
			nextMap: await this.getRandomLayer(),
			players: [],
			squads: [],
			playerQueue: [],
			fogOfWar: '',
		}
		this.log.info('Connected to server')
	}

	async disconnect(): Promise<void> {
		await this.simulateLatency()
		this.log.info('Disconnected from server')
	}

	async getCurrentLayer() {
		await this.simulateLatency()
		this.log.info('Fetched current map')
		return this.serverState.currentMap
	}

	async getNextLayer() {
		await this.simulateLatency()
		this.log.info('Fetched next map')
		return this.serverState.nextMap
	}

	async getListPlayers(): Promise<RM.Player[]> {
		await this.simulateLatency()
		this.log.info('Fetched list of players')
		return this.serverState.players
	}

	async getSquads(): Promise<RM.Squad[]> {
		await this.simulateLatency()
		this.log.info('Fetched list of squads')
		return this.serverState.squads
	}

	async broadcast(message: string): Promise<void> {
		await this.simulateLatency()
		this.log.info(`Broadcast message: ${message}`)
	}

	async setFogOfWar(mode: string): Promise<void> {
		await this.simulateLatency()
		this.serverState.fogOfWar = mode
		this.log.info(`Set fog of war mode to: ${mode}`)
	}

	async warn(anyID: string, message: string): Promise<void> {
		await this.simulateLatency()
		this.log.info(`Warned player ${anyID} with message: ${message}`)
	}

	async ban(anyID: string, banLength: string, message: string): Promise<void> {
		await this.simulateLatency()
		this.log.info(`Banned player ${anyID} for ${banLength} with message: ${message}`)
	}

	async getPlayerQueueLength() {
		await this.simulateLatency()
		return this.serverState.playerQueue.length
	}

	async switchTeam(playerId: number | string): Promise<void> {
		if (typeof playerId === 'string') throw new Error('idk how to handle this yet')
		await this.simulateLatency()
		const player = this.serverState.players.find((p) => p.playerID === playerId)
		if (player === undefined) return
		player.teamID = player.teamID === 0 ? 1 : 0
		await this.leaveSquad(playerId)
	}

	async leaveSquad(playerId: number): Promise<void> {
		await this.simulateLatency()
		const thisPlayer = this.serverState.players.find((p) => p.playerID === playerId)
		if (!thisPlayer) return
		const playerSquadId = thisPlayer.squadID
		if (playerSquadId === undefined) return
		delete thisPlayer.squadID
		if (!thisPlayer.isLeader) return
		const playerSquadIndex = this.serverState.squads.findIndex((squad) => squad.squadID === playerSquadId)
		const playerSquad = this.serverState.squads[playerSquadIndex]
		if (!playerSquad) throw new Error(`Squad not found for player ${thisPlayer.name}`)
		playerSquad.size--
		if (playerSquad.size === 0) {
			this.serverState.squads.splice(playerSquadIndex, 1)
			return
		}
		for (const player of this.serverState.players) {
			if (player.teamID !== playerSquad.teamID || player.squadID !== playerSquad.squadID) continue
			player.isLeader = true
			break
		}
		this.log.info(`Switched team for player ${playerId}`)
	}

	async setNextLayer(command: M.MiniLayer): Promise<void> {
		await this.simulateLatency()
		this.serverState.nextMap = command
		this.log.info(`Set next layer with command: %o `, command)
	}

	async connectPlayer(player: RM.Player): Promise<void> {
		await this.simulateLatency()
		this.serverState.players.push(player)
		this.log.info(`Player connected: ${player.name}`)
	}

	async disconnectPlayer(playerID: number): Promise<void> {
		await this.simulateLatency()
		this.leaveSquad(playerID)
		this.serverState.players = this.serverState.players.filter((player) => player.playerID !== playerID)
		this.log.info(`Player disconnected: ${playerID}`)
	}

	async createSquad(squad: RM.Squad): Promise<void> {
		await this.simulateLatency()
		const player = this.serverState.players.find((p) => p.name === squad.creatorName)
		if (!player) throw new Error('unknown squad creator')
		this.serverState.squads.push(squad)
		player.squadID = squad.squadID
		player.isLeader = true
		this.log.info(`Squad created: ${squad.squadName}`)
	}

	async removeSquad(squadID: number): Promise<void> {
		await this.simulateLatency()
		this.serverState.squads = this.serverState.squads.filter((squad) => squad.squadID !== squadID)
		this.log.info(`Squad removed: ${squadID}`)
	}
	async endMatch() {
		this.serverState.currentMap = this.serverState.nextMap
		this.serverState.nextMap = await this.getRandomLayer()
	}

	async getRandomLayer() {
		const db = DB.get({ log: this.log })
		const [randomLayer] = await db
			.select({
				id: Schema.layers.id,
				Level: Schema.layers.Level,
				Layer: Schema.layers.Layer,
				Gamemode: Schema.layers.Gamemode,
				LayerVersion: Schema.layers.LayerVersion,
				Faction_1: Schema.layers.Faction_1,
				Faction_2: Schema.layers.Faction_2,
				SubFac_1: Schema.layers.SubFac_1,
				SubFac_2: Schema.layers.SubFac_2,
			})
			.from(Schema.layers)
			.orderBy(sql`RAND()`)
			.limit(1)
		return randomLayer
	}
}
