import { AsyncResource, sleep } from '@/lib/async'
import * as CS from '@/models/context-shared'
import * as L from '@/models/layer'
import * as SM from '@/models/squad.models'
import * as C from '@/server/context.ts'
import * as Otel from '@opentelemetry/api'
import { Subject } from 'rxjs'
import Rcon, { DecodedPacket } from './core-rcon'
import { capitalID, iterateIDs, lowerID } from './id-parser'

export type WarnOptionsBase = { msg: string | string[]; repeat?: number } | string | string[]
export type WarnOptions = WarnOptionsBase | ((ctx: C.Player) => WarnOptionsBase)

const tracer = Otel.trace.getTracer('squad-rcon')
export default class SquadRcon {
	event$: Subject<SM.SquadEvent> = new Subject()

	layersStatus: AsyncResource<SM.LayerStatusRes>
	serverInfo: AsyncResource<SM.ServerInfoRes>
	playerList: AsyncResource<SM.PlayerListRes>
	squadList: AsyncResource<SM.SquadListRes>

	constructor(
		ctx: CS.Log,
		public core: Rcon,
		private opts?: { warnPrefix?: string },
	) {
		this.layersStatus = new AsyncResource('serverStatus', (ctx) => this.getServerLayerStatus(ctx), { defaultTTL: 5000 })
		this.serverInfo = new AsyncResource('serverInfo', (ctx) => this.getServerInfo(ctx), { defaultTTL: 10_000 })
		this.playerList = new AsyncResource('playerList', (ctx) => this.getListPlayers(ctx), { defaultTTL: 5000 })
		this.squadList = new AsyncResource('squadList', (ctx) => this.getSquads(ctx), { defaultTTL: 5000 })

		const onServerMsg = (pkt: DecodedPacket) => {
			const message = processChatPacket(ctx, pkt)
			if (message === null) return
			this.event$.next({ type: 'chat-message', message })
		}
		core.on('server', onServerMsg)

		// immediately reset the state of all resources when the connection state changes
		const sub = core.connected$.subscribe(() => {
			this.layersStatus.invalidate(ctx)
			this.playerList.invalidate(ctx)
			this.squadList.invalidate(ctx)
		})

		this[Symbol.dispose] = () => {
			core.off('server', onServerMsg)
			sub.unsubscribe()
		}
	}

	[Symbol.dispose]() {}

	private async getCurrentLayer(ctx: CS.Log) {
		const response = await this.core.execute(ctx, 'ShowCurrentMap')
		if (response.code !== 'ok') return response
		const match = response.data.match(/^Current level is (.*), layer is (.*), factions (.*)/)
		if (!match) throw new Error('Invalid response from ShowCurrentMap: ' + response.data)
		const layer = match[2]
		const factions = match[3]
		return { code: 'ok' as const, layer: L.parseRawLayerText(`${layer} ${factions}`)! }
	}

	private async getNextLayer(ctx: CS.Log) {
		const response = await this.core.execute(ctx, 'ShowNextMap')
		if (response.code !== 'ok') return response
		if (!response.data) return { code: 'ok' as const, layer: null }
		const match = response.data.match(/^Next level is (.*), layer is (.*), factions (.*)/)
		if (!match) return { code: 'ok' as const, layer: null }
		const layer = match[2]
		const factions = match[3]
		if (!layer || !factions) return { code: 'ok' as const, layer: null }
		return { code: 'ok' as const, layer: L.parseRawLayerText(`${layer} ${factions}`) }
	}

	async getPlayer(ctx: CS.Log, anyID: string) {
		const { value: playersRes } = await this.playerList.get(ctx)
		if (playersRes.code !== 'ok') return playersRes
		const players = playersRes.players
		const player = players.find(p => p.playerID.toString() === anyID || p.steamID.toString() === anyID)
		if (!player) return { code: 'err:player-not-found' as const }
		return { code: 'ok' as const, player }
	}

	private async getListPlayers(ctx: CS.Log) {
		const res = await this.core.execute(ctx, 'ListPlayers')
		if (res.code !== 'ok') return res

		const players: SM.Player[] = []

		if (!res || res.data.length < 1) return { code: 'ok' as const, players: [] }

		for (const line of res.data.split('\n')) {
			const match = line.match(
				/^ID: (?<playerID>\d+) \| Online IDs:([^|]+)\| Name: (?<name>.+) \| Team ID: (?<teamID>\d|N\/A) \| Squad ID: (?<squadID>\d+|N\/A) \| Is Leader: (?<isLeader>True|False) \| Role: (?<role>.+)$/,
			)
			if (!match) continue

			const data: any = match.groups!
			data.playerID = +data.playerID
			data.isLeader = data.isLeader === 'True'
			data.teamID = data.teamID !== 'N/A' ? +data.teamID : null
			data.squadID = data.squadID !== 'N/A' && data.squadID !== null ? +data.squadID : null
			iterateIDs(match[2]).forEach((platform, id) => {
				data[lowerID(platform)] = id
			})
			const parsedData = SM.PlayerSchema.parse(data)
			players.push(parsedData)
		}
		return { code: 'ok' as const, players }
	}

	async getSquads(ctx: CS.Log) {
		const resSquad = await this.core.execute(ctx, 'ListSquads')
		if (resSquad.code !== 'ok') return resSquad

		const squads: SM.Squad[] = []
		let teamName
		let teamID

		if (!resSquad.data || resSquad.data.length === 0) return { code: 'ok' as const, squads }

		for (const line of resSquad.data.split('\n')) {
			const match = line.match(
				/ID: (?<squadID>\d+) \| Name: (?<squadName>.+) \| Size: (?<size>\d+) \| Locked: (?<locked>True|False) \| Creator Name: (?<creatorName>.+) \| Creator Online IDs:([^|]+)/,
			)
			if (!match) throw new Error(`Invalid squad data: ${line}`)
			const matchSide = line.match(/Team ID: (\d) \((.+)\)/)
			if (matchSide) {
				teamID = +matchSide[1]
				teamName = matchSide[2]
			}
			if (!match) continue
			const ids = match.groups as any
			ids.squadID = +match.groups!.squadID
			const squad: any = {
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
		return {
			code: 'ok' as const,
			squads,
		}
	}

	async broadcast(ctx: CS.Log, message: string) {
		let messages = [message]
		if (message.length > SM.RCON_MAX_BUF_LEN) {
			messages = []
			for (const msg of message.split('\n\n')) {
				if (msg.length > SM.RCON_MAX_BUF_LEN) {
					for (const line of msg.split('\n')) {
						if (line.length > SM.RCON_MAX_BUF_LEN) {
							messages.push(line.slice(0, SM.RCON_MAX_BUF_LEN))
						}
					}
				} else {
					messages.push(msg)
				}
			}
		}
		for (const message of messages) {
			ctx.log.info(`Broadcasting message: %s`, message)
			await this.core.execute(ctx, `AdminBroadcast ${message}`)
		}
	}

	async setFogOfWar(ctx: CS.Log, mode: 'on' | 'off') {
		await this.core.execute(ctx, `AdminSetFogOfWar ${mode}`)
	}

	async warn(ctx: CS.Log, anyID: string, _opts: WarnOptions) {
		let opts: WarnOptionsBase
		if (typeof _opts === 'function') {
			const playerRes = await this.getPlayer(ctx, anyID)
			if (playerRes.code !== 'ok') return playerRes
			opts = _opts({ player: playerRes.player })
		} else {
			opts = _opts
		}

		let repeatCount = 1
		let msgArr: string[]
		if (typeof opts === 'string') {
			msgArr = [opts]
		} else if (Array.isArray(opts)) {
			msgArr = opts
		} else {
			msgArr = Array.isArray(opts.msg) ? opts.msg : [opts.msg]
			repeatCount = opts.repeat || 1
		}
		if (msgArr[0] && this.opts?.warnPrefix) {
			msgArr[0] = this.opts.warnPrefix + msgArr[0]
		}

		ctx.log.info(`Warning player: %s: %s`, anyID, msgArr)
		for (let i = 0; i < repeatCount; i++) {
			if (i !== 0) await sleep(5000)
			for (const msg of msgArr) {
				await this.core.execute(ctx, `AdminWarn "${anyID}" ${msg}`)
			}
		}
	}

	// 0 = Perm | 1m = 1 minute | 1d = 1 Day | 1M = 1 Month | etc...
	async ban(ctx: CS.Log, anyID: string, banLength: string, message: string) {
		await this.core.execute(ctx, `AdminBan "${anyID}" ${banLength} ${message}`)
	}

	async switchTeam(ctx: CS.Log, anyID: string) {
		await this.core.execute(ctx, `AdminForceTeamChange "${anyID}"`)
		this.playerList.invalidate(ctx)
		this.squadList.invalidate(ctx)
	}

	setNextLayer = C.spanOp('squad-rcon:setNextLayer', { tracer }, async (ctx: CS.Log, layer: L.LayerId | L.UnvalidatedLayer) => {
		const cmd = L.getAdminSetNextLayerCommand(layer)
		ctx.log.info(`Setting next layer: %s, `, cmd)
		await this.core.execute(ctx, cmd)
		this.layersStatus.invalidate(ctx)
		const newStatus = (await this.layersStatus.get(ctx)).value
		if (newStatus.code !== 'ok') return newStatus

		// this shouldn't happen. if it does we need to handle it more gracefully
		if (!newStatus.data.nextLayer) throw new Error(`Failed to set next layer. Expected ${layer}, received undefined`)

		if (newStatus.data.nextLayer && !L.areLayersCompatible(layer, newStatus.data.nextLayer)) {
			return {
				code: 'err:unable-to-set-next-layer' as const,
				unexpectedLayerId: newStatus.data.nextLayer.id,
				msg: `Failed to set next layer. Expected ${L.toLayer(layer).id}, received ${newStatus.data.nextLayer.id}`,
			}
		}
		return { code: 'ok' as const }
	})

	async endMatch(_ctx: CS.Log) {
		_ctx.log.info(`Ending match`)
		await this.core.execute(_ctx, 'AdminEndMatch')
	}

	async leaveSquad(ctx: CS.Log, playerId: number) {
		await this.core.execute(ctx, `AdminForceRemoveFromSquad ${playerId}`)
		this.squadList.invalidate(ctx)
		this.playerList.invalidate(ctx)
	}

	private async getPlayerQueueLength(ctx: CS.Log) {
		const response = await this.core.execute(ctx, 'ListPlayers')
		if (response.code !== 'ok') return response
		const match = response.data.match(/\[Players in Queue: (\d+)\]/)
		if (match === null) throw new Error('Failed to parse player queue length')
		return { code: 'ok' as const, length: match ? parseInt(match[1], 10) : 0 }
	}

	private async getServerInfo(ctx: CS.Log): Promise<SM.ServerInfoRes> {
		const rawDataRes = await this.core.execute(ctx, `ShowServerInfo`)
		if (rawDataRes.code !== 'ok') return rawDataRes
		const data = JSON.parse(rawDataRes.data)
		const res = SM.ServerRawInfoSchema.safeParse(data)
		if (!res.success) {
			ctx.log.error(res.error, `Failed to parse server info: %O`, data)
			return { code: 'err:rcon' as const, msg: 'Failed to parse server info' }
		}

		const rawInfo = res.data
		const serverStatus: SM.ServerInfo = {
			name: rawInfo.ServerName_s,
			maxPlayerCount: rawInfo.MaxPlayers,
			playerCount: rawInfo.PlayerCount_I,
			queueLength: rawInfo.PublicQueue_I,
			maxQueueLength: rawInfo.PublicQueueLimit_I,
		}

		return {
			code: 'ok' as const,
			data: serverStatus,
		}
	}

	private getServerLayerStatus = C.spanOp(
		'squad-rcon:getServerLayerstatus',
		{ tracer },
		async (_ctx: CS.Log): Promise<SM.LayerStatusRes> => {
			const currentLayerTask = this.getCurrentLayer(_ctx)
			const nextLayerTask = this.getNextLayer(_ctx)
			const currentLayerRes = await currentLayerTask
			const nextLayerRes = await nextLayerTask
			if (currentLayerRes.code !== 'ok') return currentLayerRes
			if (nextLayerRes.code !== 'ok') return nextLayerRes

			const serverStatus: SM.LayersStatus = {
				currentLayer: currentLayerRes.layer,
				nextLayer: nextLayerRes.layer,
			}

			return {
				code: 'ok' as const,
				data: serverStatus,
			}
		},
	)
}

function processChatPacket(ctx: CS.Log, decodedPacket: DecodedPacket) {
	const matchChat = decodedPacket.body.match(/\[(ChatAll|ChatTeam|ChatSquad|ChatAdmin)] \[Online IDs:([^\]]+)\] (.+?) : (.*)/)
	if (matchChat) {
		ctx.log.debug(`Matched chat message: %s`, decodedPacket.body)
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
			// @ts-expect-error not typesafe
			result[lowerID(platform)] = id
		})
		result.playerId = (result.steamID || result.eosID)!
		ctx.log.info({ result }, result.raw)
		return SM.ChatMessageSchema.parse(result)
	}

	const matchWarn = decodedPacket.body.match(/Remote admin has warned player (.*)\. Message was "(.*)"/)
	if (matchWarn) {
		ctx.log.debug(`Matched warn message: %s`, decodedPacket.body)
	}
	return null
}
