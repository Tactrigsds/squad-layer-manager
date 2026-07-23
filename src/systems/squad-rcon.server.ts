import { sleep } from '@/lib/async'
import { AsyncResource } from '@/lib/async-resource'
import type * as Cleanup from '@/lib/cleanup'
import { matchLog } from '@/lib/log-parsing'
import type { DecodedPacket } from '@/lib/rcon/core-rcon'
import { WARNS } from '@/messages'
import * as CS from '@/models/context-shared'
import * as L from '@/models/layer'
import * as SM from '@/models/squad.models'
import * as C from '@/server/context.ts'
import { initModule } from '@/server/logger'
import * as AdminList from '@/systems/adminlist.server'
import * as Settings from '@/systems/settings.server'
import * as Rx from 'rxjs'

const module = initModule('squad-rcon')
let log!: CS.Logger

export function setup() {
	log = module.getLogger()
}

export type SquadRcon = {
	rconEvent$: Rx.Observable<[C.OtelCtx, SM.RconEvents.Event]>

	layersStatus: AsyncResource<SM.LayerStatusRes, C.Rcon & CS.AbortSignal>
	serverInfo: AsyncResource<SM.ServerInfoRes, C.Rcon & CS.AbortSignal>
	teams: AsyncResource<SM.TeamsRes, C.Rcon & CS.AbortSignal>
}

export function initSquadRcon(
	ctx: C.Rcon & CS.AbortSignal,
	cleanup: Cleanup.Tasks,
	opts?: { onFatalError?: (err: unknown) => void },
): SquadRcon {
	const rcon = ctx.rcon
	const cacheTTL = Settings.GLOBAL_SETTINGS.squadServer.rconCacheTTL
	const layersStatus: SquadRcon['layersStatus'] = new AsyncResource<SM.LayerStatusRes, C.Rcon & CS.AbortSignal>(
		`serverStatus`,
		(ctx) => getLayerStatus(ctx),
		module,
		{
			defaultTTL: cacheTTL.layersStatus,
			retries: 4,
			retryDelay: 1000,
			isErrorResponse: (res: SM.LayerStatusRes) => res.code !== 'ok',
			log,
			onFatalError: opts?.onFatalError,
		},
	)
	cleanup.push(() => layersStatus.dispose())

	const serverInfo: SquadRcon['serverInfo'] = new AsyncResource<SM.ServerInfoRes, C.Rcon & CS.AbortSignal>(
		`serverInfo`,
		(ctx) => getServerInfo(ctx),
		module,
		{
			defaultTTL: cacheTTL.serverInfo,
			retries: 4,
			retryDelay: 1000,
			isErrorResponse: (res: SM.ServerInfoRes) => res.code !== 'ok',
			log,
			onFatalError: opts?.onFatalError,
		},
	)
	cleanup.push(() => serverInfo.dispose())

	const teams: SquadRcon['teams'] = new AsyncResource<SM.TeamsRes, C.Rcon & CS.AbortSignal>(
		'teams',
		(ctx) => fetchTeams(ctx),
		module,
		{
			defaultTTL: cacheTTL.teams,
			retries: 4,
			retryDelay: 1000,
			isErrorResponse: (res: SM.TeamsRes) => res.code !== 'ok',
			log,
			onFatalError: opts?.onFatalError,
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

	cleanup.push(rcon.connected$.subscribe(() => {
		const rconCtx = { ...ctx, rcon }
		layersStatus.invalidate(rconCtx)
		teams.invalidate(rconCtx)
		serverInfo.invalidate(rconCtx)
	}))

	return {
		layersStatus,
		serverInfo,
		teams,
		rconEvent$,
	}
}

export async function getCurrentLayer(ctx: C.Rcon & CS.AbortSignal) {
	const response = await ctx.rcon.execute('ShowCurrentMap', { signal: ctx.signal })
	if (response.code !== 'ok') return response
	const match = response.data.match(/^Current level is (.*), layer is (.*), factions (.*)/)
	if (!match) throw new Error('Invalid response from ShowCurrentMap: ' + response.data)
	const layer = match[2]
	const factions = match[3]
	const parsedLayer = L.parseRawLayerText(`${layer} ${factions}`)!
	return { code: 'ok' as const, layer: parsedLayer }
}

export async function getNextLayer(ctx: C.Rcon & CS.AbortSignal) {
	const response = await ctx.rcon.execute('ShowNextMap', { signal: ctx.signal })
	if (response.code !== 'ok') return response
	if (!response.data) return { code: 'ok' as const, layer: null }
	const match = response.data.match(/^Next level is (.*), layer is (.*), factions (.*)/)
	if (!match) return { code: 'ok' as const, layer: null }
	const layer = match[2]
	const factions = match[3]
	if (!layer || !factions) return { code: 'ok' as const, layer: null }
	return { code: 'ok' as const, layer: L.parseRawLayerText(`${layer} ${factions}`) }
}

async function fetchPlayers(ctx: C.Rcon & CS.AbortSignal) {
	const res = await ctx.rcon.execute('ListPlayers', { signal: ctx.signal })
	if (res.code !== 'ok') return res

	const players: SM.Player[] = []

	if (!res || res.data.length < 1) return { code: 'ok' as const, players: [] }

	for (const line of res.data.split('\n')) {
		if (line.includes('epic:')) {
			log.info('found line with epic id: %s', line)
		}
		const match = line.match(
			/^ID: (?<playerID>\d+) \| Online IDs:([^|]+)\| Name: (?<name>.+) \| Team ID: (?<teamId>\d|N\/A) \| Squad ID: (?<squadId>\d+|N\/A) \| Is Leader: (?<isLeader>True|False) \| Role: (?<role>.+)$/,
		)
		if (!match) continue

		const data: any = match.groups!
		data.playerID = +data.playerID
		data.isLeader = data.isLeader === 'True'
		data.teamId = data.teamId !== 'N/A' ? +data.teamId : null
		data.squadId = data.squadId !== 'N/A' && data.squadId !== null ? +data.squadId : null
		data.role = SM.toDedupedRoleName(data.role)
		const idsInput = { username: match.groups!.name, idsStr: match[2] }
		let ids: SM.PlayerIds.Type
		try {
			ids = SM.PlayerIds.parse(idsInput)
		} catch (e) {
			log.error(e, 'Failed to parse player ids. line: %s, input: %o', line, idsInput)
			continue
		}
		data.ids = ids

		data.isAdmin = false
		data.adminGroups = []
		if (data.ids.steam) {
			const adminList = await AdminList.adminList.get(ctx, { ttl: Infinity })
			data.isAdmin = SM.AdminList.getIsAdmin(adminList, data.ids)
			data.adminGroups = [...(SM.AdminList.getPlayerGroups(adminList, data.ids) ?? [])]
		} else {
			log.info('parsed player info data without steam id: %o', data)
		}

		const playerResult = SM.PlayerSchema.safeParse(data)
		if (!playerResult.success) {
			log.error(playerResult.error, 'Failed to parse player. line: %s, input: %o', line, data)
			continue
		}
		players.push(playerResult.data)
	}
	return { code: 'ok' as const, players }
}

async function fetchSquads(ctx: C.Rcon & CS.AbortSignal) {
	const resSquad = await ctx.rcon.execute('ListSquads', { signal: ctx.signal })
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
		const creatorIdsInput = { username: match.groups!.creatorName, idsStr: match[6] }
		let creatorIds: SM.PlayerIds.Type
		try {
			creatorIds = SM.PlayerIds.parse(creatorIdsInput)
		} catch (e) {
			log.error(e, 'Failed to parse squad creator ids. line: %s, input: %o', line, creatorIdsInput)
			continue
		}
		const squad: any = {
			squadId: +match.groups!.squadId,
			teamId: teamId ?? null,
			teamName: teamName,
			squadName: match.groups!.squadName,
			locked: match.groups?.locked === 'True',
			creator: SM.PlayerIds.getPlayerId(creatorIds),
		}
		const squadResult = SM.SquadSchema.safeParse(squad)
		if (!squadResult.success) {
			log.error(squadResult.error, 'Failed to parse squad. line: %s, input: %o', line, squad)
			continue
		}
		squads.push(squadResult.data)
	}
	return {
		code: 'ok' as const,
		squads,
	}
}

async function fetchTeams(ctx: C.Rcon & C.AsyncResourceInvocation & CS.AbortSignal): Promise<SM.TeamsRes> {
	// stamped before the requests go out so it's a lower bound on the snapshot's validity; see TeamsRes.polledAt
	const polledAt = Date.now()
	const [playersRes, squadsRes] = await Promise.all([fetchPlayers(ctx), fetchSquads(ctx)])

	if (playersRes.code === 'err:rcon') return playersRes
	if (squadsRes.code === 'err:rcon') return squadsRes
	const players = playersRes.players
	const squads = squadsRes.squads

	const grouped = SM.Players.groupIntoSquads(players)

	// -------- validate data coherence between players and squads --------
	try {
		for (const player of players) {
			if (player.squadId !== null && player.teamId === null) {
				throw ctx.refetch(
					`player ${SM.PlayerIds.prettyPrint(player.ids)} is in a squad without a team`,
				)
			}
			if (player.isLeader && player.squadId === null) {
				log.error(`player ${SM.PlayerIds.prettyPrint(player.ids)} is a leader without a squad, setting isLeader to false`)
				player.isLeader = false
			}
		}

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
	} catch (e) {
		log.warn(e, 'Received error while validating players and squads.')
		// kept in the message rather than as attributes: as an object these two exploded into one key per
		// player and per squad, at warn level. As a body it stays a single (large, but rare) line.
		log.warn('Parsed responses: players=%o squads=%o', playersRes, squadsRes)
		throw e
	}

	return {
		code: 'ok',
		polledAt,
		players,
		squads,
	}
}

export async function broadcast(ctx: C.Rcon & CS.AbortSignal, message: string) {
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
		await ctx.rcon.execute(`AdminBroadcast ${message}`, { level: 'debug', signal: ctx.signal })
	}
}

export type WarnOptionsBase =
	| {
		msg: string | string[]
		// whether to include GLOBAL_SETTINGS.warnPrefix
		prefix?: boolean
	}
	| string
	| string[]
// returning undefined indicates warning should be skipped
export type WarnOptions = WarnOptionsBase | ((ctx: C.Player) => WarnOptionsBase | undefined)

// normalizes any WarnOptions form to carry the admin-directed warnPrefix flag. Only admin-directed sends
// (warnAllAdmins, admin-chat command feedback) go through this; player-directed warns stay unprefixed.
export function withPrefixFlag(options: WarnOptions, prefix = true): WarnOptions {
	const apply = (o: WarnOptionsBase | undefined): WarnOptionsBase | undefined => {
		if (o === undefined) return undefined
		if (typeof o === 'string' || Array.isArray(o)) return { msg: o, prefix }
		return { prefix, ...o }
	}
	if (typeof options === 'function') return (pctx) => apply(options(pctx))
	return apply(options)!
}

export async function getPlayer(ctx: C.SquadRcon & CS.AbortSignal, query: SM.PlayerIds.IdQuery, opts?: { ttl?: number }) {
	const playersRes = await ctx.server.teams.get(ctx, opts)
	if (playersRes.code !== 'ok') return playersRes
	const players = playersRes.players
	const player = SM.PlayerIds.find(players, p => p.ids, query)
	if (!player) return { code: 'err:player-not-found' as const }
	return { code: 'ok' as const, player }
}

export async function warn(ctx: C.SquadRcon & CS.AbortSignal, ids: SM.PlayerIds.EosIdQueryOrPlayerId, _opts: WarnOptions) {
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

	let prefix: boolean = false
	let msgArr: string[]
	if (typeof opts === 'string') {
		msgArr = [opts]
	} else if (Array.isArray(opts)) {
		msgArr = opts
	} else {
		msgArr = Array.isArray(opts.msg) ? opts.msg : [opts.msg]
		prefix = opts.prefix ?? prefix
	}
	if (msgArr[0] && Settings.GLOBAL_SETTINGS.warnPrefix && prefix) {
		msgArr[0] = Settings.GLOBAL_SETTINGS.warnPrefix + msgArr[0]
	}

	log.info(`Warning player: %s: %s`, SM.PlayerIds.prettyPrint(ids), msgArr)
	for (const msg of msgArr) {
		await ctx.rcon.execute(`AdminWarn "${SM.PlayerIds.normalizeToPlayerId(ids)}" ${msg}`, { level: 'debug', signal: ctx.signal })
	}
}

export const warnAll = C.spanOp(
	'warnAll',
	{ module, levels: { event: 'info' } },
	async (ctx: C.SquadRcon & CS.AbortSignal, players: SM.PlayerIds.EosIdQueryOrPlayerId[], options: WarnOptions) => {
		const ops: Promise<unknown>[] = []
		for (const player of players) {
			ops.push(warn(ctx, player, options))
		}

		await Promise.all(ops)
	},
)

export const warnAllAdmins = C.spanOp(
	'warnAllAdmins',
	{ module, levels: { event: 'info' } },
	async (ctx: C.SquadRcon & CS.AbortSignal, options: WarnOptions, excludeSteamIds?: Set<string>) => {
		// admin-directed messages carry the configured warnPrefix; this covers every warnAllAdmins call site
		options = withPrefixFlag(options)
		const [currentAdminList, teamsRes] = await Promise.all([
			AdminList.adminList.get(ctx),
			ctx.server.teams.get(ctx),
		])
		if (teamsRes.code === 'err:rcon') return
		const admins: SM.PlayerIds.Schema[] = []
		for (const player of teamsRes.players) {
			if (
				player.ids.steam
				&& SM.AdminList.getIsAdmin(currentAdminList, player.ids as SM.PlayerIds.IdQuery<'steam' | 'eos'>)
				&& !excludeSteamIds?.has(player.ids.steam)
			) {
				admins.push(player.ids)
			}
		}
		await warnAll(ctx, admins, options)
	},
)

export async function getServerInfo(ctx: C.Rcon & CS.AbortSignal): Promise<SM.ServerInfoRes> {
	const rawDataRes = await ctx.rcon.execute(`ShowServerInfo`, { signal: ctx.signal })
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
	async (ctx: C.Rcon & CS.AbortSignal): Promise<SM.LayerStatusRes> => {
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
	async (ctx: C.SquadRcon & CS.AbortSignal, layer: L.LayerId | L.UnvalidatedLayer) => {
		const cmd = L.getLayerCommand(layer, 'set-next')
		log.info(`Setting next layer: %s, `, cmd)
		await ctx.rcon.execute(cmd, { level: 'info', signal: ctx.signal })
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

export function setFogOfWar(ctx: C.Rcon & CS.AbortSignal, mode: 'on' | 'off') {
	log.info(`Setting fog of war to %s`, mode)
	return ctx.rcon.execute(`AdminSetFogOfWar ${mode}`, { level: 'info', signal: ctx.signal })
}

export async function endMatch(ctx: C.Rcon) {
	log.info(`Ending match`)
	await ctx.rcon.execute('AdminEndMatch', { level: 'info' })
}

export async function switchPlayers(
	ctx: C.Rcon & C.SquadRcon & CS.AbortSignal,
	players: SM.PlayerIds.EosIdQueryOrPlayerId[],
) {
	const ops: Promise<unknown>[] = []
	for (const ids of players) {
		const id = SM.PlayerIds.normalizeToPlayerId(ids)
		ops.push(ctx.rcon.execute(`AdminForceTeamChange ${id}`, { level: 'info', signal: ctx.signal }))
	}
	await Promise.all(ops)
	ctx.server.teams.invalidate(ctx)
}

// "Kill" trick: AdminForceTeamChange toggles a player's team and forces a respawn (death), so issuing it
// twice ~1s apart kills the player while returning them to their original team. Unlike the teamswap flow
// this doesn't broadcast switch notifications to admins, only warns the killed player, and invalidates
// teams once after both switches complete so the intermediate (swapped) team state is never surfaced.
export async function killPlayers(
	ctx: C.Rcon & C.SquadRcon & CS.AbortSignal,
	players: SM.PlayerIds.EosIdQueryOrPlayerId[],
	reason?: string,
) {
	const ids = players.map(p => SM.PlayerIds.normalizeToPlayerId(p))
	if (ids.length === 0) return
	log.info(`Killing players via double team switch: %o`, ids)
	// The two force-switches (and the wait between them) are atomic and deliberately ignore ctx.signal:
	// once the first switch fires, aborting must not skip the second, or the player is left stranded on the
	// opposite team instead of dead on their own.
	const forceSwitch = () => Promise.all(ids.map(id => ctx.rcon.execute(`AdminForceTeamChange ${id}`, { level: 'info' })))
	// hold the teams fetch mutex across the double switch so no poll/refetch observes the player mid-swap
	// (on the opposite team). We invalidate only after releasing, triggering one fresh fetch of the settled
	// (back-to-original) state.
	await ctx.server.teams.fetchMtx.runExclusive(async () => {
		await forceSwitch()
		await sleep(1000)
		await forceSwitch()
	})
	ctx.server.teams.invalidate(ctx)
	await warnAll(ctx, ids, WARNS.kill.notifyKilled(reason))
}

export async function demoteCommander(ctx: C.Rcon & C.SquadRcon & CS.AbortSignal, ids: SM.PlayerIds.EosIdQueryOrPlayerId) {
	const id = SM.PlayerIds.normalizeToPlayerId(ids)
	log.info(`Demoting commander %s`, id)
	await ctx.rcon.execute(`AdminDemoteCommander ${id}`, { level: 'info', signal: ctx.signal })
	ctx.server.teams.invalidate(ctx)
}

export async function disbandSquad(ctx: C.Rcon & C.SquadRcon & CS.AbortSignal, teamId: SM.TeamId, squadId: SM.SquadId) {
	log.info(`Disbanding squad %d on team %d`, squadId, teamId)
	await ctx.rcon.execute(`AdminDisbandSquad ${teamId} ${squadId}`, { level: 'info', signal: ctx.signal })
	ctx.server.teams.invalidate(ctx)
}

export async function kickPlayer(
	ctx: C.Rcon & C.SquadRcon & CS.AbortSignal,
	ids: SM.PlayerIds.EosIdQueryOrPlayerId,
	reason?: string,
) {
	const id = SM.PlayerIds.normalizeToPlayerId(ids)
	log.info(`Kicking player %s`, id)
	await ctx.rcon.execute(`AdminKick "${id}" ${reason ?? ''}`.trim(), { level: 'info', signal: ctx.signal })
	ctx.server.teams.invalidate(ctx)
}

export async function removeFromSquad(ctx: C.Rcon & C.SquadRcon & CS.AbortSignal, ids: SM.PlayerIds.EosIdQueryOrPlayerId) {
	const id = SM.PlayerIds.normalizeToPlayerId(ids)
	log.info(`Removing player %s from squad`, id)
	await ctx.rcon.execute(`AdminRemovePlayerFromSquad ${id}`, { level: 'info', signal: ctx.signal })
	ctx.server.teams.invalidate(ctx)
}

export async function adminRenameSquad(ctx: C.Rcon & C.SquadRcon & CS.AbortSignal, teamId: SM.TeamId, squadId: SM.SquadId) {
	await ctx.rcon.execute(`AdminRenameSquad ${teamId} ${squadId}`, { level: 'info', signal: ctx.signal })
	ctx.server.teams.invalidate(ctx)
}
