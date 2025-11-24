import { sleep } from '@/lib/async'
import { AsyncResource } from '@/lib/async'
import { matchLog } from '@/lib/log-parsing'
import * as OneToMany from '@/lib/one-to-many-map'
import type { DecodedPacket } from '@/lib/rcon/core-rcon'
import Rcon from '@/lib/rcon/core-rcon'
import type * as CS from '@/models/context-shared'
import * as L from '@/models/layer'
import type * as SS from '@/models/server-state.models'
import * as SM from '@/models/squad.models'
import { CONFIG } from '@/server/config.ts'
import * as C from '@/server/context.ts'
import * as Otel from '@opentelemetry/api'
import * as Rx from 'rxjs'
import { baseLogger } from '../logger'

const tracer = Otel.trace.getTracer('squad-rcon')

export type SquadRconContext = {
	rconEvent$: Rx.Observable<[CS.Log & C.OtelCtx, SM.RconEvents.Event]>
	layersStatus: AsyncResource<SM.LayerStatusRes, CS.Log & C.Rcon>

	serverInfo: AsyncResource<SM.ServerInfoRes, CS.Log & C.Rcon>
	playerList: AsyncResource<SM.PlayerListRes, CS.Log & C.Rcon>
	squadList: AsyncResource<SM.SquadListRes, CS.Log & C.Rcon>
}

export function initSquadRcon(ctx: CS.Log, id: string, settings: SS.ServerConnection['rcon'], sub: Rx.Subscription): SquadRconContext {
	const layersStatus: SquadRconContext['layersStatus'] = new AsyncResource('serverStatus', (ctx) => getLayerStatus(ctx), {
		defaultTTL: 5000,
	})

	const rcon = new Rcon({ serverId: id, settings })
	rcon.ensureConnected(ctx)

	const serverInfo: SquadRconContext['serverInfo'] = new AsyncResource('serverInfo', (ctx) => getServerInfo(ctx), {
		defaultTTL: 10_000,
	})
	const playerList: SquadRconContext['playerList'] = new AsyncResource('playerList', (ctx) => getListPlayers(ctx), {
		defaultTTL: 5000,
	})
	const squadList: SquadRconContext['squadList'] = new AsyncResource('squadList', (ctx) => getSquads(ctx), { defaultTTL: 5000 })

	const coreRconEvent$ = Rx.fromEvent(rcon, 'server') as Rx.Observable<[CS.Log & C.OtelCtx, DecodedPacket]>
	const rconEvent$: Rx.Observable<[CS.Log & C.OtelCtx, SM.RconEvents.Event]> = coreRconEvent$.pipe(
		Rx.concatMap(([ctx, _pkt]): Rx.Observable<[CS.Log & C.OtelCtx, SM.RconEvents.Event]> => {
			const pkt = _pkt as DecodedPacket
			for (const matcher of SM.RCON_EVENT_MATCHERS) {
				const [event, err] = matchLog(pkt.body, matcher)
				if (err) {
					console.warn({ packet: pkt.body, err }, `Chat packet parsing failed`)
					return Rx.EMPTY
				}
				return Rx.of([ctx, event as SM.RconEvents.Event])
			}
			return Rx.EMPTY
		}),
		Rx.share(),
	)

	sub.add(rcon.connected$.subscribe(() => {
		const rconCtx = { ...ctx, rcon }
		layersStatus.invalidate(rconCtx)
		playerList.invalidate(rconCtx)
		squadList.invalidate(rconCtx)
		serverInfo.invalidate(rconCtx)
	}))

	return {
		layersStatus,
		serverInfo,
		playerList,
		squadList,
		rconEvent$,
	}
}

export async function getCurrentLayer(ctx: CS.Log & C.Rcon) {
	const response = await ctx.rcon.execute(ctx, 'ShowCurrentMap')
	if (response.code !== 'ok') return response
	const match = response.data.match(/^Current level is (.*), layer is (.*), factions (.*)/)
	if (!match) throw new Error('Invalid response from ShowCurrentMap: ' + response.data)
	const layer = match[2]
	const factions = match[3]
	return { code: 'ok' as const, layer: L.parseRawLayerText(`${layer} ${factions}`)! }
}

export async function getNextLayer(ctx: CS.Log & C.Rcon) {
	const response = await ctx.rcon.execute(ctx, 'ShowNextMap')
	if (response.code !== 'ok') return response
	if (!response.data) return { code: 'ok' as const, layer: null }
	const match = response.data.match(/^Next level is (.*), layer is (.*), factions (.*)/)
	if (!match) return { code: 'ok' as const, layer: null }
	const layer = match[2]
	const factions = match[3]
	if (!layer || !factions) return { code: 'ok' as const, layer: null }
	return { code: 'ok' as const, layer: L.parseRawLayerText(`${layer} ${factions}`) }
}

export async function getListPlayers(ctx: CS.Log & C.Rcon) {
	const res = await ctx.rcon.execute(ctx, 'ListPlayers')
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
		data.player = SM.PlayerIds.parsePlayerIds({ username: match.groups!.name, idsStr: match[2] })
		const parsedData = SM.PlayerSchema.parse(data)
		players.push(parsedData)
	}
	return { code: 'ok' as const, players }
}

export async function getSquads(ctx: CS.Log & C.Rcon) {
	const resSquad = await ctx.rcon.execute(ctx, 'ListSquads')
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
			creator: SM.PlayerIds.parsePlayerIds({ username: match[6], idsStr: match[5] }),
		}

		const parsed = SM.SquadSchema.parse(squad)
		squads.push(parsed)
	}
	return {
		code: 'ok' as const,
		squads,
	}
}

export async function broadcast(ctx: CS.Log & C.Rcon, message: string) {
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
		await ctx.rcon.execute(ctx, `AdminBroadcast ${message}`)
	}
}

export type WarnOptionsBase = { msg: string | string[]; repeat?: number } | string | string[]
// returning undefined indicates warning should be skipped
export type WarnOptions = WarnOptionsBase | ((ctx: C.Player) => WarnOptionsBase | undefined)

export async function getPlayer(ctx: CS.Log & C.SquadRcon, query: SM.PlayerIds.IdQuery) {
	const playersRes = await ctx.server.playerList.get(ctx)
	if (playersRes.code !== 'ok') return playersRes
	const players = playersRes.players
	const player = SM.PlayerIds.find(players, p => p.ids, query)
	if (!player) return { code: 'err:player-not-found' as const }
	return { code: 'ok' as const, player }
}

export async function warn(ctx: CS.Log & C.SquadRcon, ids: SM.PlayerIds.Type, _opts: WarnOptions) {
	let opts: WarnOptionsBase
	if (typeof _opts === 'function') {
		const playerRes = await getPlayer(ctx, ids)
		if (playerRes.code !== 'ok') return playerRes
		const optsRes = _opts({ player: playerRes.player })
		if (!optsRes) return
		opts = optsRes
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
	if (msgArr[0] && CONFIG.warnPrefix) {
		msgArr[0] = CONFIG.warnPrefix + msgArr[0]
	}

	ctx.log.info(`Warning player: %s: %s`, ids, msgArr)
	for (let i = 0; i < repeatCount; i++) {
		if (i !== 0) await sleep(5000)
		for (const msg of msgArr) {
			await ctx.rcon.execute(ctx, `AdminWarn "${SM.PlayerIds.resolvePlayerId(ids)}" ${msg}`)
		}
	}
}

export const warnAllAdmins = C.spanOp(
	'squad-server:warn-all-admins',
	{ tracer, eventLogLevel: 'info' },
	async (ctx: CS.Log & C.SquadServer, options: WarnOptions) => {
		const [currentAdminList, playersRes] = await Promise.all([
			ctx.server.adminList.get(ctx),
			ctx.server.playerList.get(ctx),
		])
		const ops: Promise<unknown>[] = []

		if (playersRes.code === 'err:rcon') return
		for (const player of playersRes.players) {
			if (!player.ids.steam) continue
			if (OneToMany.has(currentAdminList.admins, player.ids.steam, CONFIG.adminListAdminRole)) {
				ops.push(warn(ctx, player.ids, options))
			}
		}
		await Promise.all(ops)
	},
)

export async function getServerInfo(ctx: CS.Log & C.Rcon): Promise<SM.ServerInfoRes> {
	const rawDataRes = await ctx.rcon.execute(ctx, `ShowServerInfo`)
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

export const getLayerStatus = C.spanOp(
	'squad-rcon:getLayerStatus',
	{ tracer },
	async (ctx: CS.Log & C.Rcon): Promise<SM.LayerStatusRes> => {
		const currentLayerTask = getCurrentLayer(ctx)
		const nextLayerTask = getNextLayer(ctx)
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

export const setNextLayer = C.spanOp(
	'squad-rcon:setNextLayer',
	{ tracer },
	async (ctx: CS.Log & C.SquadRcon, layer: L.LayerId | L.UnvalidatedLayer) => {
		const cmd = L.getLayerCommand(layer, 'set-next')
		ctx.log.info(`Setting next layer: %s, `, cmd)
		await ctx.rcon.execute(ctx, cmd)
		ctx.server.layersStatus.invalidate(ctx)
		const newStatus = await ctx.server.layersStatus.get(ctx)
		if (newStatus.code !== 'ok') return newStatus

		// this shouldn't happen. if it does we need to handle it more gracefully
		if (!newStatus.data.nextLayer) {
			throw new Error(`Failed to set next layer. Expected ${typeof layer === 'string' ? layer : JSON.stringify(layer)}, received undefined`)
		}

		if (newStatus.data.nextLayer && !L.areLayersCompatible(layer, newStatus.data.nextLayer)) {
			return {
				code: 'err:unable-to-set-next-layer' as const,
				unexpectedLayerId: newStatus.data.nextLayer.id,
				msg: `Failed to set next layer. Expected ${L.toLayer(layer).id}, received ${newStatus.data.nextLayer.id}`,
			}
		}
		return { code: 'ok' as const }
	},
)

export function setFogOfWar(ctx: CS.Log & C.Rcon, mode: 'on' | 'off') {
	ctx.log.info(`Setting fog of war to %s`, mode)
	return ctx.rcon.execute(ctx, `AdminSetFogOfWar ${mode}`)
}

export function processChatPacket(ctx: CS.Log, decodedPacket: DecodedPacket) {
}

export function endMatch(ctx: CS.Log & C.Rcon) {
	ctx.log.info(`Ending match`)
	void ctx.rcon.execute(ctx, 'AdminEndMatch')
}
