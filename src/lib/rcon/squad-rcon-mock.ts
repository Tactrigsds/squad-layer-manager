import { Mutex } from 'async-mutex'
import { sql } from 'drizzle-orm'
import * as fs from 'node:fs/promises'
import { Subject } from 'rxjs'
import { z } from 'zod'

import { sleep } from '@/lib/async'
import * as SM from '@/lib/rcon/squad-models'
import * as M from '@/models'
import * as C from '@/server/context'
import * as DB from '@/server/db.ts'
import { ENV } from '@/server/env.ts'
import { Logger } from '@/server/logger'
import * as Schema from '@/server/schema.ts'

const WarnSchema = z.object({
	playerId: z.string(),
	message: z.string(),
})

const ServerStateSchema = z.object({
	currentMap: M.MiniLayerSchema,
	nextMap: M.MiniLayerSchema,
	players: SM.PlayerSchema.array(),
	playerQueue: SM.PlayerSchema.array(),
	squads: SM.SquadSchema.array(),
	fogOfWar: z.boolean(),
	chat: SM.ChatMessageSchema.array(),
	warns: SM.WarnSchema.array(),
})

export type ServerState = z.infer<typeof ServerStateSchema>

export class SquadRconMock implements SM.ISquadRcon {
	state!: ServerState
	event$ = new Subject<SM.SquadEvent>()
	public saveMtx = new Mutex()

	async setup(ctx: C.Log) {
		const release = await this.saveMtx.acquire()
		try {
			const raw = await fs.readFile(ENV.MOCK_SQUAD_SERVER_PATH!, {
				encoding: 'utf-8',
			})
			this.state = ServerStateSchema.parse(JSON.parse(raw))
		} finally {
			release()
		}
	}

	async writeState(ctx: C.Log) {
		const release = await this.saveMtx.acquire()
		try {
			await fs.writeFile(ENV.MOCK_SQUAD_SERVER_PATH!, JSON.stringify(this.state, null, 2), { encoding: 'utf-8' })
		} finally {
			release()
		}
	}

	async simulateLatency() {
		await sleep(0)
	}

	async getCurrentLayer() {
		await this.simulateLatency()
		return this.state.currentMap
	}

	async getNextLayer(ctx: C.Log) {
		await this.simulateLatency()
		return this.state.nextMap
	}

	async getListPlayers(): Promise<SM.Player[]> {
		await this.simulateLatency()
		return this.state.players
	}

	async getSquads(): Promise<SM.Squad[]> {
		await this.simulateLatency()
		return this.state.squads
	}

	async broadcast(ctx: C.Log, message: string): Promise<void> {
		await this.simulateLatency()
	}

	async setFogOfWar(ctx: C.Log, on: boolean): Promise<void> {
		await this.simulateLatency()
		this.state.fogOfWar = mode
		ctx.log.info(`Set fog of war mode to: ${mode}`)
	}

	async warn(ctx: C.Log, anyID: string, message: string): Promise<void> {
		await this.simulateLatency()
		ctx.log.info(`Warned player ${anyID} with message: ${message}`)
	}

	async ban(ctx: C.Log, anyID: string, banLength: string, message: string): Promise<void> {
		await this.simulateLatency()
		ctx.log.info(`Banned player ${anyID} for ${banLength} with message: ${message}`)
	}

	async getPlayerQueueLength() {
		await this.simulateLatency()
		return this.state.playerQueue.length
	}

	async switchTeam(ctx: C.Log, playerId: number | string): Promise<void> {
		if (typeof playerId === 'string') {
			throw new Error('idk how to handle this yet')
		}
		await this.simulateLatency()
		const player = this.state.players.find((p) => p.playerID === playerId)
		if (player === undefined) return
		player.teamID = player.teamID === 0 ? 1 : 0
		await this.leaveSquad(ctx, playerId)
	}

	async leaveSquad(ctx: C.Log, playerId: number): Promise<void> {
		await this.simulateLatency()
		const thisPlayer = this.state.players.find((p) => p.playerID === playerId)
		if (!thisPlayer) return
		const playerSquadId = thisPlayer.squadID
		if (playerSquadId === undefined) return
		delete thisPlayer.squadID
		if (!thisPlayer.isLeader) return
		const playerSquadIndex = this.state.squads.findIndex((squad) => squad.squadID === playerSquadId)
		const playerSquad = this.state.squads[playerSquadIndex]
		if (!playerSquad) {
			throw new Error(`Squad not found for player ${thisPlayer.name}`)
		}
		playerSquad.size--
		if (playerSquad.size === 0) {
			this.state.squads.splice(playerSquadIndex, 1)
			return
		}
		for (const player of this.state.players) {
			if (player.teamID !== playerSquad.teamID || player.squadID !== playerSquad.squadID) continue
			player.isLeader = true
			break
		}
		ctx.log.info(`Switched team for player ${playerId}`)
	}

	async setNextLayer(ctx: C.Log, layer: M.MiniLayer): Promise<void> {
		await this.simulateLatency()
		this.state.nextMap = layer
		ctx.log.info(`Set next layer: %o `, layer)
	}

	async connectPlayer(ctx: C.Log, player: SM.Player): Promise<void> {
		await this.simulateLatency()
		this.state.players.push(player)
		ctx.log.info(`Player connected: ${player.name}`)
	}

	async disconnectPlayer(ctx: C.Log, playerID: number): Promise<void> {
		await this.simulateLatency()
		await this.leaveSquad(ctx, playerID)
		this.state.players = this.state.players.filter((player) => player.playerID !== playerID)
		ctx.log.info(`Player disconnected: ${playerID}`)
	}

	async createSquad(ctx: C.Log, squad: SM.Squad): Promise<void> {
		await this.simulateLatency()
		const player = this.state.players.find((p) => p.name === squad.creatorName)
		if (!player) throw new Error('unknown squad creator')
		this.state.squads.push(squad)
		player.squadID = squad.squadID
		player.isLeader = true
		ctx.log.info(`Squad created: ${squad.squadName}`)
	}

	async removeSquad(ctx: C.Log, squadID: number): Promise<void> {
		await this.simulateLatency()
		this.state.squads = this.state.squads.filter((squad) => squad.squadID !== squadID)
		ctx.log.info(`Squad removed: ${squadID}`)
	}

	async endGame(ctx: C.Log) {
		this.state.currentMap = this.state.nextMap
		const _ctx = DB.addPooledDb(ctx)
		this.state.nextMap = await this.getRandomLayer(_ctx)
	}

	async getRandomLayer(ctx: C.Db) {
		const [randomLayer] = await ctx
			.db()
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
			.orderBy(
				sql`RAND
            ()`
			)
			.limit(1)
		return randomLayer
	}
}
