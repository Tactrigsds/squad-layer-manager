import { Subject } from 'rxjs'
import { AsyncResource, sleep } from '@/lib/async'

import * as M from '@/models'
import * as C from '@/server/context.ts'
import * as Otel from '@opentelemetry/api'

import { capitalID, iterateIDs, lowerID } from './id-parser'
import Rcon, { DecodedPacket } from './core-rcon'
import * as SM from './squad-models'
import { prefixProps, selectProps } from '../object'

export type WarnOptions = { msg: string | string[]; repeat?: number } | string | string[]

const tracer = Otel.trace.getTracer('squad-rcon')
export default class SquadRcon {
	event$: Subject<SM.SquadEvent> = new Subject()

	serverStatus: AsyncResource<SM.ServerStatusRes>
	playerList: AsyncResource<SM.PlayerListRes>
	squadList: AsyncResource<SM.SquadListRes>

	constructor(
		ctx: C.Log,
		public core: Rcon
	) {
		this.serverStatus = new AsyncResource('serverStatus', (ctx) => this.getServerStatus(ctx), { defaultTTL: 5000 })
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
			this.serverStatus.invalidate(ctx)
			this.playerList.invalidate(ctx)
			this.squadList.invalidate(ctx)
		})

		this[Symbol.dispose] = () => {
			core.off('server', onServerMsg)
			sub.unsubscribe()
		}
	}

	[Symbol.dispose]() {}

	private async getCurrentLayer(ctx: C.Log) {
		const response = await this.core.execute(ctx, 'ShowCurrentMap')
		if (response.code !== 'ok') return response
		const match = response.data.match(/^Current level is (.*), layer is (.*), factions (.*)/)
		if (!match) throw new Error('Invalid response from ShowCurrentMap: ' + response.data)
		const layer = match[2]
		const factions = match[3]
		return { code: 'ok' as const, layer: parseLayer(layer, factions) }
	}

	private async getNextLayer(ctx: C.Log) {
		const response = await this.core.execute(ctx, 'ShowNextMap')
		if (response.code !== 'ok') return response
		if (!response.data) return { code: 'ok' as const, layer: null }
		const match = response.data.match(/^Next level is (.*), layer is (.*), factions (.*)/)
		if (!match) return { code: 'ok' as const, layer: null }
		const layer = match[2]
		const factions = match[3]
		if (!layer || !factions) return { code: 'ok' as const, layer: null }
		return { code: 'ok' as const, layer: parseLayer(layer, factions) }
	}

	private async getListPlayers(ctx: C.Log) {
		const res = await this.core.execute(ctx, 'ListPlayers')
		if (res.code !== 'ok') return res

		const players: SM.Player[] = []

		if (!res || res.data.length < 1) return { code: 'ok' as const, players: [] }

		for (const line of res.data.split('\n')) {
			const match = line.match(
				/^ID: (?<playerID>\d+) \| Online IDs:([^|]+)\| Name: (?<name>.+) \| Team ID: (?<teamID>\d|N\/A) \| Squad ID: (?<squadID>\d+|N\/A) \| Is Leader: (?<isLeader>True|False) \| Role: (?<role>.+)$/
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

	async getSquads(ctx: C.Log) {
		const resSquad = await this.core.execute(ctx, 'ListSquads')
		if (resSquad.code !== 'ok') return resSquad

		const squads: SM.Squad[] = []
		let teamName
		let teamID

		if (!resSquad.data || resSquad.data.length === 0) return { code: 'ok' as const, squads }

		for (const line of resSquad.data.split('\n')) {
			const match = line.match(
				/ID: (?<squadID>\d+) \| Name: (?<squadName>.+) \| Size: (?<size>\d+) \| Locked: (?<locked>True|False) \| Creator Name: (?<creatorName>.+) \| Creator Online IDs:([^|]+)/
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

	async broadcast(ctx: C.Log, message: string) {
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

	async setFogOfWar(ctx: C.Log, mode: 'on' | 'off') {
		await this.core.execute(ctx, `AdminSetFogOfWar ${mode}`)
	}

	async warn(ctx: C.Log, anyID: string, opts: WarnOptions) {
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

		ctx.log.info(`Warning player: %s: %s`, anyID, msgArr)
		for (let i = 0; i < repeatCount; i++) {
			for (const msg of msgArr) {
				await this.core.execute(ctx, `AdminWarn "${anyID}" ${msg}`)
			}
			await sleep(5000)
		}
	}

	// 0 = Perm | 1m = 1 minute | 1d = 1 Day | 1M = 1 Month | etc...
	async ban(ctx: C.Log, anyID: string, banLength: string, message: string) {
		await this.core.execute(ctx, `AdminBan "${anyID}" ${banLength} ${message}`)
	}

	async switchTeam(ctx: C.Log, anyID: string) {
		await this.core.execute(ctx, `AdminForceTeamChange "${anyID}"`)
		this.playerList.invalidate(ctx)
		this.squadList.invalidate(ctx)
	}

	async setNextLayer(ctx: C.Log, layer: M.AdminSetNextLayerOptions) {
		return C.spanOp('squad-rcon:setNextLayer', { tracer }, async () => {
			const span = Otel.trace.getActiveSpan()!
			span.setAttributes(prefixProps(selectProps(layer, ['Layer', 'Faction_1', 'Faction_2', 'SubFac_1', 'SubFac_2']), 'nextlayer'))
			await this.core.execute(ctx, M.getAdminSetNextLayerCommand(layer))
			this.serverStatus.invalidate(ctx)
			span.setStatus({ code: Otel.SpanStatusCode.OK })
		})()
	}

	async endMatch(_ctx: C.Log) {
		_ctx.log.info(`Ending match`)
		await this.core.execute(_ctx, 'AdminEndMatch')
	}

	async leaveSquad(ctx: C.Log, playerId: number) {
		await this.core.execute(ctx, `AdminForceRemoveFromSquad ${playerId}`)
		this.squadList.invalidate(ctx)
		this.playerList.invalidate(ctx)
	}

	private async getPlayerQueueLength(ctx: C.Log) {
		const response = await this.core.execute(ctx, 'ListPlayers')
		if (response.code !== 'ok') return response
		const match = response.data.match(/\[Players in Queue: (\d+)\]/)
		if (match === null) throw new Error('Failed to parse player queue length')
		return { code: 'ok' as const, length: match ? parseInt(match[1], 10) : 0 }
	}

	private async getServerStatus(_ctx: C.Log): Promise<SM.ServerStatusRes> {
		return C.spanOp('squad-rcon:getServerstatus', { tracer }, async () => {
			const rawDataPromise = this.core.execute(_ctx, `ShowServerInfo`)
			const currentLayerTask = this.getCurrentLayer(_ctx)
			const nextLayerTask = this.getNextLayer(_ctx)
			const rawDataRes = await rawDataPromise
			if (rawDataRes.code !== 'ok') return rawDataRes
			const data = JSON.parse(rawDataRes.data)
			const res = SM.ServerRawInfoSchema.safeParse(data)
			if (!res.success) {
				_ctx.log.error(res.error, `Failed to parse server info: %O`, data)
				return { code: 'err:rcon' as const, msg: 'Failed to parse server info' }
			}

			const rawInfo = res.data
			const currentLayerRes = await currentLayerTask
			const nextLayerRes = await nextLayerTask
			if (currentLayerRes.code !== 'ok') return currentLayerRes
			if (nextLayerRes.code !== 'ok') return nextLayerRes

			const serverStatus: SM.ServerStatus = {
				name: rawInfo.ServerName_s,
				currentLayer: currentLayerRes.layer,
				nextLayer: nextLayerRes.layer,
				maxPlayerCount: rawInfo.MaxPlayers,
				playerCount: rawInfo.PlayerCount_I,
				queueLength: rawInfo.PublicQueue_I,
				maxQueueLength: rawInfo.PublicQueueLimit_I,
			}

			return {
				code: 'ok' as const,
				data: serverStatus,
			}
		})()
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
		ctx.log.info({ result }, result.raw)
		return SM.ChatMessageSchema.parse(result)
	}

	const matchWarn = decodedPacket.body.match(/Remote admin has warned player (.*)\. Message was "(.*)"/)
	if (matchWarn) {
		ctx.log.trace(`Matched warn message: %s`, decodedPacket.body)
	}
	return null
}
