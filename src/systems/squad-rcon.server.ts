import { type CleanupTasks, sleep } from '@/lib/async'
import { AsyncResource } from '@/lib/async-resource'
import { matchLog } from '@/lib/log-parsing'
import type { DecodedPacket } from '@/lib/rcon/core-rcon'
import * as CS from '@/models/context-shared'
import * as L from '@/models/layer'

import * as SM from '@/models/squad.models'
import { CONFIG } from '@/server/config.ts'
import * as C from '@/server/context.ts'
import { initModule } from '@/server/logger'

import * as Rx from 'rxjs'

const module = initModule('squad-rcon')
let log!: CS.Logger

export function setup() {
	log = module.getLogger()
}

export type SquadRcon = {
	rconEvent$: Rx.Observable<[C.OtelCtx, SM.RconEvents.Event]>

	layersStatus: AsyncResource<SM.LayerStatusRes, C.Rcon>
	serverInfo: AsyncResource<SM.ServerInfoRes, C.Rcon>
	teams: AsyncResource<SM.TeamsRes, C.Rcon & C.AdminList>
}

export function initSquadRcon(ctx: C.Rcon & C.AdminList, cleanup: CleanupTasks): SquadRcon {
	const rcon = ctx.rcon
	const layersStatus: SquadRcon['layersStatus'] = new AsyncResource<SM.LayerStatusRes, C.Rcon>(
		`serverStatus`,
		(ctx) => getLayerStatus(ctx),
		module,
		{
			defaultTTL: 5000,
			retries: 4,
			retryDelay: 1000,
			isErrorResponse: (res: SM.LayerStatusRes) => res.code !== 'ok',
			log,
		},
	)
	cleanup.push(() => layersStatus.dispose())

	const serverInfo: SquadRcon['serverInfo'] = new AsyncResource<SM.ServerInfoRes, C.Rcon>(
		`serverInfo`,
		(ctx) => getServerInfo(ctx),
		module,
		{
			defaultTTL: 10_000,
			retries: 4,
			retryDelay: 1000,
			isErrorResponse: (res: SM.ServerInfoRes) => res.code !== 'ok',
			log,
		},
	)
	cleanup.push(() => serverInfo.dispose())

	const teams: SquadRcon['teams'] = new AsyncResource<SM.TeamsRes, C.Rcon & C.AdminList>(
		'teams',
		(ctx) => getTeams(ctx),
		module,
		{
			defaultTTL: 5000,
			retries: 4,
			retryDelay: 1000,
			isErrorResponse: (res: SM.TeamsRes) => res.code !== 'ok',
			log,
		},
	)
	cleanup.push(() => teams.dispose())

	const rconEventBase$ = Rx.fromEvent(rcon, 'server', (...args) => args) as unknown as Rx.Observable<[CS.Log & C.OtelCtx, DecodedPacket]>
	const rconEvent$: Rx.Observable<[C.OtelCtx, SM.RconEvents.Event]> = rconEventBase$.pipe(
		Rx.concatMap(([ctx, pkt]): Rx.Observable<[C.OtelCtx, SM.RconEvents.Event]> => {
			log.info('RCON PACKET: %s', pkt.body)
			const [event, err] = matchLog(pkt.body, SM.RCON_EVENT_MATCHERS)
			if (err) {
				log.error((err as any)?.stack ?? err, `Error matching event. packet: %s`, pkt.body)
				return Rx.EMPTY
			}
			if (!event) return Rx.EMPTY
			return Rx.of([ctx, event])
		}),
		Rx.share(),
	)

	rcon.connected$.subscribe(() => {
		const rconCtx = { ...ctx, rcon }
		layersStatus.invalidate(rconCtx)
		teams.invalidate(rconCtx)
		serverInfo.invalidate(rconCtx)
	})

	return {
		layersStatus,
		serverInfo,
		teams,
		rconEvent$,
	}
}

export async function getCurrentLayer(ctx: C.Rcon) {
	const response = await ctx.rcon.execute('ShowCurrentMap')
	if (response.code !== 'ok') return response
	const match = response.data.match(/^Current level is (.*), layer is (.*), factions (.*)/)
	if (!match) throw new Error('Invalid response from ShowCurrentMap: ' + response.data)
	const layer = match[2]
	const factions = match[3]
	return { code: 'ok' as const, layer: L.parseRawLayerText(`${layer} ${factions}`)! }
}

export async function getNextLayer(ctx: C.Rcon) {
	const response = await ctx.rcon.execute('ShowNextMap')
	if (response.code !== 'ok') return response
	if (!response.data) return { code: 'ok' as const, layer: null }
	const match = response.data.match(/^Next level is (.*), layer is (.*), factions (.*)/)
	if (!match) return { code: 'ok' as const, layer: null }
	const layer = match[2]
	const factions = match[3]
	if (!layer || !factions) return { code: 'ok' as const, layer: null }
	return { code: 'ok' as const, layer: L.parseRawLayerText(`${layer} ${factions}`) }
}

const fetchPlayers = C.spanOp('squad-rcon:fetch-players', { module }, async (ctx: C.Rcon & C.AdminList) => {
	const res = await ctx.rcon.execute('ListPlayers')
	if (res.code !== 'ok') return res

	const players: SM.Player[] = []

	if (!res || res.data.length < 1) return { code: 'ok' as const, players: [] }

	for (const line of res.data.split('\n')) {
		const match = line.match(
			/^ID: (?<playerID>\d+) \| Online IDs:([^|]+)\| Name: (?<name>.+) \| Team ID: (?<teamId>\d|N\/A) \| Squad ID: (?<squadId>\d+|N\/A) \| Is Leader: (?<isLeader>True|False) \| Role: (?<role>.+)$/,
		)
		if (!match) continue

		const data: any = match.groups!
		data.playerID = +data.playerID
		data.isLeader = data.isLeader === 'True'
		data.teamId = data.teamId !== 'N/A' ? +data.teamId : null
		data.squadId = data.squadId !== 'N/A' && data.squadId !== null ? +data.squadId : null
		data.ids = SM.PlayerIds.extractPlayerIds({ username: match.groups!.name, idsStr: match[2] })

		data.isAdmin = false
		if (data.ids.steam) {
			const adminList = await ctx.adminList.get(ctx, { ttl: Infinity })
			data.isAdmin = adminList.admins.has(data.ids.steam)
		}

		const parsedData = SM.PlayerSchema.parse(data)
		players.push(parsedData)
	}
	return { code: 'ok' as const, players }
})

const fetchSquads = C.spanOp('squad-rcon:fetch-squads', { module }, async (ctx: C.Rcon) => {
	const resSquad = await ctx.rcon.execute('ListSquads')
	if (resSquad.code !== 'ok') return resSquad

	const squads: SM.Squad[] = []
	let teamName: string | undefined
	let teamId: number | undefined

	if (!resSquad.data || resSquad.data.length === 0) return { code: 'ok' as const, squads }

	for (const line of resSquad.data.split('\n')) {
		const match = line.match(
			/ID: (?<squadId>\d+) \| Name: (?<squadName>.+) \| Size: (?<size>\d+) \| Locked: (?<locked>True|False) \| Creator Name: (?<creatorName>.+) \| Creator Online IDs:([^|]+)/,
		)
		const matchSide = line.match(/Team ID: (\d) \((.+)\)/)
		if (matchSide) {
			teamId = +matchSide[1]
			teamName = matchSide[2]
		}
		if (!match) continue
		const ids = match.groups as any
		ids.squadId = +match.groups!.squadId
		const squad: any = {
			squadId: +match.groups!.squadId,
			teamId: teamId ?? null,
			teamName: teamName,
			squadName: match.groups!.squadName,
			locked: match.groups?.locked === 'True',
			creatorIds: SM.PlayerIds.extractPlayerIds({ username: match.groups!.creatorName, idsStr: match[6] }),
		}

		const parsed = SM.SquadSchema.parse(squad)
		squads.push(parsed)
	}
	return {
		code: 'ok' as const,
		squads,
	}
})

const getTeams = C.spanOp(
	'fetch-teams',
	{ module },
	async (ctx: C.Rcon & C.AdminList & C.AsyncResourceInvocation): Promise<SM.TeamsRes> => {
		const [playersRes, squadsRes] = await Promise.all([fetchPlayers(ctx), fetchSquads(ctx)])

		if (playersRes.code === 'err:rcon') return playersRes
		if (squadsRes.code === 'err:rcon') return squadsRes
		const players = playersRes.players
		const squads = squadsRes.squads

		const grouped = SM.Players.groupIntoSquads(players)

		// -------- validate data coherence between players and squads --------

		for (const squad of squads) {
			const group = grouped.find(group => SM.Squads.idsEqual(squad, group))
			if (!group) {
				throw ctx.refetch(`squad ${SM.Squads.printKey(squad)} is empty`)
			}
			const leaders = group.players.filter(player => player.isLeader)
			if (leaders.length === 0) {
				throw ctx.refetch(`squad ${SM.Squads.printKey(squad)} has no leaders`)
			}
			if (leaders.length > 1) {
				throw ctx.refetch(
					`squad ${SM.Squads.printKey(squad)} has multiple leaders: ${leaders.map(p => SM.PlayerIds.prettyPrint(p.ids)).join(', ')}`,
				)
			}
		}

		for (const group of grouped) {
			const squad = squads.find(squad => SM.Squads.idsEqual(squad, group))
			if (!squad) {
				throw ctx.refetch(
					`players ${group.players.map(p => SM.PlayerIds.prettyPrint(p.ids)).join(', ')} are in a nonexistant squad ${
						SM.Squads.printKey(group)
					}`,
				)
			}
		}

		return {
			code: 'ok',
			players,
			squads,
		}
	},
)

export async function broadcast(ctx: C.Rcon, message: string) {
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
		await ctx.rcon.execute(`AdminBroadcast ${message}`)
	}
}

export type WarnOptionsBase =
	| {
		msg: string | string[]
		repeat?: number
		// whether to include CONFIG.warnPrefix
		prefix?: boolean
	}
	| string
	| string[]
// returning undefined indicates warning should be skipped
export type WarnOptions = WarnOptionsBase | ((ctx: C.Player) => WarnOptionsBase | undefined)

export async function getPlayer(ctx: C.SquadRcon & C.AdminList, query: SM.PlayerIds.IdQuery, opts?: { ttl?: number }) {
	const playersRes = await ctx.server.teams.get(ctx, opts)
	if (playersRes.code !== 'ok') return playersRes
	const players = playersRes.players
	const player = SM.PlayerIds.find(players, p => p.ids, query)
	if (!player) return { code: 'err:player-not-found' as const }
	return { code: 'ok' as const, player }
}

export async function warn(ctx: C.SquadRcon & C.AdminList, ids: SM.PlayerIds.Type, _opts: WarnOptions) {
	let opts: WarnOptionsBase
	if (typeof _opts === 'function') {
		const playerRes = await getPlayer(ctx, ids)
		if (playerRes.code !== 'ok') return playerRes
		const optsRes = _opts({ ...CS.init(), player: playerRes.player })
		if (!optsRes) return
		opts = optsRes
	} else {
		opts = _opts
	}

	let repeatCount = 1
	let prefix: boolean = false
	let msgArr: string[]
	if (typeof opts === 'string') {
		msgArr = [opts]
	} else if (Array.isArray(opts)) {
		msgArr = opts
	} else {
		msgArr = Array.isArray(opts.msg) ? opts.msg : [opts.msg]
		repeatCount = opts.repeat || 1
		prefix = opts.prefix ?? prefix
	}
	if (msgArr[0] && CONFIG.warnPrefix && prefix) {
		msgArr[0] = CONFIG.warnPrefix + msgArr[0]
	}

	log.info(`Warning player: %s: %s`, ids, msgArr)
	for (let i = 0; i < repeatCount; i++) {
		if (i !== 0) await sleep(5000)
		for (const msg of msgArr) {
			await ctx.rcon.execute(`AdminWarn "${SM.PlayerIds.resolvePlayerId(ids)}" ${msg}`)
		}
	}
}

export const warnAllAdmins = C.spanOp(
	'warn-all-admins',
	{ module, levels: { event: 'info' } },
	async (ctx: C.SquadRcon & C.AdminList, options: WarnOptions) => {
		const [currentAdminList, teamsRes] = await Promise.all([
			ctx.adminList.get(ctx),
			ctx.server.teams.get(ctx),
		])
		const ops: Promise<unknown>[] = []

		if (teamsRes.code === 'err:rcon') return
		for (const player of teamsRes.players) {
			if (!player.ids.steam) continue
			if (currentAdminList.admins.has(player.ids.steam)) {
				ops.push(warn(ctx, player.ids, options))
			}
		}
		await Promise.all(ops)
	},
)

export async function getServerInfo(ctx: C.Rcon): Promise<SM.ServerInfoRes> {
	const rawDataRes = await ctx.rcon.execute(`ShowServerInfo`)
	if (rawDataRes.code !== 'ok') return rawDataRes
	const data = JSON.parse(rawDataRes.data)
	const res = SM.ServerRawInfoSchema.safeParse(data)
	if (!res.success) {
		log.error(res.error, `Failed to parse server info: %O`, data)
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
	'getLayerStatus',
	{ module },
	async (ctx: C.Rcon): Promise<SM.LayerStatusRes> => {
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
	'setNextLayer',
	{ module },
	async (ctx: C.SquadRcon, layer: L.LayerId | L.UnvalidatedLayer) => {
		const cmd = L.getLayerCommand(layer, 'set-next')
		log.info(`Setting next layer: %s, `, cmd)
		await ctx.rcon.execute(cmd)
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

export function setFogOfWar(ctx: C.Rcon, mode: 'on' | 'off') {
	log.info(`Setting fog of war to %s`, mode)
	return ctx.rcon.execute(`AdminSetFogOfWar ${mode}`)
}

export function processChatPacket(decodedPacket: DecodedPacket) {
}

export function endMatch(ctx: C.Rcon) {
	log.info(`Ending match`)
	void ctx.rcon.execute('AdminEndMatch')
}
