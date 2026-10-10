import { AsyncResource } from '@/lib/async-resource'
import type * as Cleanup from '@/lib/cleanup'
import { matchLog } from '@/lib/log-parsing'
import * as Prom from '@/lib/promise-utils'
import type { DecodedPacket } from '@/lib/rcon/core-rcon'
import * as Rx from '@/lib/rxjs'
import * as SM_Msgs from '@/messages/squad.messages'
import * as CS from '@/models/context-shared.models'
import * as L from '@/models/layer.models'
import * as Msgs from '@/models/messages.models'
import type * as SETTINGS from '@/models/settings.models'
import * as SR from '@/models/squad-rcon.models'
import * as SM from '@/models/squad.models'
import type * as C from '@/server/context.ts'
import * as Env from '@/server/env'
import * as Instr from '@/server/instrumentation'
import { initModule } from '@/server/logger'
import * as AdminList from '@/systems/adminlist.server'
import * as PlayerDiscordRoles from '@/systems/player-discord-roles.server'

const module = initModule('squad-rcon')
let log!: CS.Logger
let reportedUnmatchedListPlayers = false

const envBuilder = Env.getEnvBuilder({ ...Env.groups.general })

// each is both how often the resource is polled and how stale a read of it may be before it refetches
const LAYERS_STATUS_TTL_MS = 5_000
const SERVER_INFO_TTL_MS = 10_000
const TEAMS_TTL_MS = 5_000
let pollIntervalScale = 1

export function setup() {
	log = module.getLogger()
	pollIntervalScale = envBuilder().RCON_POLL_INTERVAL_SCALE
}

export function initSquadRcon(
	ctx: SR.Ctx.Rcon & CS.ServerId & CS.AbortSignal,
	cleanup: Cleanup.Tasks,
	opts: { onFatalError?: (err: unknown) => void },
): SR.Ctx.Payload {
	const rcon = ctx.rcon
	const layersStatus: SR.Ctx.Payload['layersStatus'] = new AsyncResource<SM.LayerStatusRes, SR.Ctx.Rcon & CS.AbortSignal>(
		`serverStatus`,
		(ctx) => fetchLayerStatus(ctx),
		module,
		{
			defaultTTL: LAYERS_STATUS_TTL_MS * pollIntervalScale,
			retries: 4,
			retryDelay: 1000,
			isErrorResponse: (res: SM.LayerStatusRes) => res.code !== 'ok',
			log,
			onFatalError: opts.onFatalError,
		},
	)
	cleanup.push(() => layersStatus.dispose())

	const serverInfo: SR.Ctx.Payload['serverInfo'] = new AsyncResource<SM.ServerInfoRes, SR.Ctx.Rcon & CS.AbortSignal>(
		`serverInfo`,
		(ctx) => fetchServerInfo(ctx),
		module,
		{
			defaultTTL: SERVER_INFO_TTL_MS * pollIntervalScale,
			retries: 4,
			retryDelay: 1000,
			isErrorResponse: (res: SM.ServerInfoRes) => res.code !== 'ok',
			log,
			onFatalError: opts.onFatalError,
		},
	)
	cleanup.push(() => serverInfo.dispose())

	const teams: SR.Ctx.Payload['teams'] = new AsyncResource<SM.TeamsRes, SR.Ctx.Rcon & CS.ServerId & CS.AbortSignal>(
		'teams',
		(ctx) => fetchTeams(ctx),
		module,
		{
			defaultTTL: TEAMS_TTL_MS * pollIntervalScale,
			retries: 4,
			retryDelay: 1000,
			isErrorResponse: (res: SM.TeamsRes) => res.code !== 'ok',
			log,
			onFatalError: opts.onFatalError,
		},
	)
	cleanup.push(() => teams.dispose())

	const rconEventBase$ = Rx.fromEvent(rcon, 'server', (...args) => args) as unknown as Rx.Observable<[CS.Log & CS.Otel, DecodedPacket]>
	const rconEvent$: Rx.Observable<[CS.Otel, SM.RconEvents.Event]> = rconEventBase$.pipe(
		Rx.concatMap(([ctx, pkt]): Rx.Observable<[CS.Otel, SM.RconEvents.Event]> => {
			log.debug('RCON PACKET: %s', pkt.body)
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

	cleanup.push(
		rcon.connected$.subscribe(() => {
			const rconCtx = { ...ctx, rcon }
			layersStatus.invalidate(rconCtx)
			teams.invalidate(rconCtx)
			serverInfo.invalidate(rconCtx)
		}),
	)

	return {
		layersStatus,
		serverInfo,
		teams,
		rconEvent$,
	}
}

export async function getCurrentLayer(ctx: SR.Ctx.Rcon & CS.AbortSignal) {
	const response = await ctx.rcon.execute('ShowCurrentMap', { signal: ctx.signal })
	if (response.code !== 'ok') return response
	const match = response.data.match(/^Current level is (.*), layer is (.*), factions (.*)/)
	if (!match) throw new Error('Invalid response from ShowCurrentMap: ' + response.data)
	const layer = match[2]
	const factions = match[3]
	const parsedLayer = L.parseRawLayerText(`${layer} ${factions}`)!
	return { code: 'ok' as const, layer: parsedLayer }
}

export async function getNextLayer(ctx: SR.Ctx.Rcon & CS.AbortSignal) {
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

async function fetchPlayers(ctx: SR.Ctx.Rcon & CS.ServerId & CS.AbortSignal) {
	const res = await ctx.rcon.execute('ListPlayers', { signal: ctx.signal })
	if (res.code !== 'ok') return res

	const players: SM.Player[] = []

	if (!res || res.data.length < 1) return { code: 'ok' as const, players: [] }

	// ttl Infinity: take whatever is cached and never block on a refetch. This runs inside the teams poll, which
	// event correlation waits on, so a slow admin-list fetch here stalls match ingestion. Resolved once for the whole
	// roster rather than per player, which is what it used to be.
	const adminLists = await AdminList.getListsForServerId(ctx, ctx.serverId, { ttl: Infinity })

	const parsed = SR.parseListPlayers(res.data)
	if (parsed.unmatched.length > 0) {
		// polled every few seconds, so a format change is reported loudly once and quietly after that
		const level = reportedUnmatchedListPlayers ? 'debug' : 'warn'
		reportedUnmatchedListPlayers = true
		log[level]('ListPlayers rows not understood, these players are left out of the roster:\n%s', parsed.unmatched.join('\n'))
	}

	for (const row of parsed.rows) {
		const data: any = { ...row, role: SM.toDedupedRoleName(row.role) }
		const idsInput = { username: row.name, idsStr: row.idsStr }
		let ids: SM.PlayerIds.Type
		try {
			ids = SM.PlayerIds.parse(idsInput)
		} catch (e) {
			log.error(e, 'Failed to parse player ids. row: %o, input: %o', row, idsInput)
			continue
		}
		data.ids = ids

		data.isAdmin = false
		data.adminGroups = []
		data.discordRoles = []
		if (data.ids.steam) {
			data.isAdmin = SM.AdminList.isAdminInAny(adminLists, data.ids)
			data.adminGroups = SM.AdminList.collectPlayerGroups(adminLists, data.ids)
			data.discordRoles = PlayerDiscordRoles.rolesForSteamId(BigInt(data.ids.steam))
		} else {
			log.info('parsed player info data without steam id: %o', data)
		}

		const playerResult = SM.PlayerSchema.safeParse(data)
		if (!playerResult.success) {
			log.error(playerResult.error, 'Failed to parse player. row: %o, input: %o', row, data)
			continue
		}
		players.push(playerResult.data)
	}
	return { code: 'ok' as const, players }
}

async function fetchSquads(ctx: SR.Ctx.Rcon & CS.AbortSignal) {
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

async function fetchTeams(ctx: SR.Ctx.Rcon & CS.ServerId & C.AsyncResourceInvocation & CS.AbortSignal): Promise<SM.TeamsRes> {
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
				throw ctx.refetch(`player ${SM.PlayerIds.prettyPrint(player.ids)} is in a squad without a team`)
			}
			if (player.isLeader && player.squadId === null) {
				log.error(`player ${SM.PlayerIds.prettyPrint(player.ids)} is a leader without a squad, setting isLeader to false`)
				player.isLeader = false
			}
		}

		for (const squad of squads) {
			const group = grouped.find((group) => SM.Squads.idsEqual(squad, group))
			if (!group) {
				throw ctx.refetch(`squad ${SM.Squads.printKey(squad)} is empty`)
			}
			const leaders = group.players.filter((player) => player.isLeader)
			if (leaders.length === 0) {
				throw ctx.refetch(`squad ${SM.Squads.printKey(squad)} has no leaders`)
			}
			if (leaders.length > 1) {
				throw ctx.refetch(
					`squad ${SM.Squads.printKey(squad)} has multiple leaders: ${leaders.map((p) => SM.PlayerIds.prettyPrint(p.ids)).join(', ')}`,
				)
			}
		}

		for (const group of grouped) {
			const squad = squads.find((squad) => SM.Squads.idsEqual(squad, group))
			if (!squad) {
				throw ctx.refetch(
					`players ${group.players.map((p) => SM.PlayerIds.prettyPrint(p.ids)).join(', ')} are in a nonexistant squad ${SM.Squads.printKey(
						group,
					)}`,
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

const BROADCAST_PREFIX = 'AdminBroadcast '
const BROADCAST_MAX_BYTES = SM.RCON_MAX_BUF_LEN - Buffer.byteLength(BROADCAST_PREFIX, 'utf8')
const truncateBuf = new Uint8Array(SM.RCON_MAX_BUF_LEN)
const utf8Encoder = new TextEncoder()

// the rcon calls a broadcast takes: one per message, each of which the game logs separately. Exposed so a caller
// attributing the broadcast can arm an expectation per line (see broadcastAction).
/**
 * Splits a message into chunks rcon will accept, breaking at blank lines first, then packing lines into as few
 * chunks as fit. A single line over the limit is truncated.
 */
export function splitBroadcast(message: string): string[] {
	if (Buffer.byteLength(message, 'utf8') <= BROADCAST_MAX_BYTES) return [message]
	const chunks: string[] = []
	for (const paragraph of message.split('\n\n')) {
		if (paragraph.trim() === '') continue
		if (Buffer.byteLength(paragraph, 'utf8') <= BROADCAST_MAX_BYTES) {
			chunks.push(paragraph)
			continue
		}
		let chunk = ''
		let chunkBytes = 0
		for (let line of paragraph.split('\n')) {
			let lineBytes = Buffer.byteLength(line, 'utf8')
			if (lineBytes > BROADCAST_MAX_BYTES) {
				line = truncateUtf8(line, BROADCAST_MAX_BYTES)
				lineBytes = Buffer.byteLength(line, 'utf8')
			}
			if (chunk !== '' && chunkBytes + 1 + lineBytes <= BROADCAST_MAX_BYTES) {
				chunk += '\n' + line
				chunkBytes += 1 + lineBytes
				continue
			}
			if (chunk.trim() !== '') chunks.push(chunk)
			chunk = line
			chunkBytes = lineBytes
		}
		if (chunk.trim() !== '') chunks.push(chunk)
	}
	return chunks
}

// encodeInto stops before a character that would not fit, so the cut never splits a code point
function truncateUtf8(str: string, maxBytes: number) {
	const { read } = utf8Encoder.encodeInto(str, truncateBuf.subarray(0, maxBytes))
	return str.slice(0, read)
}

export async function broadcast(ctx: SR.Ctx.Rcon & CS.AbortSignal, message: string) {
	for (const chunk of splitBroadcast(message)) {
		await ctx.rcon.execute(BROADCAST_PREFIX + chunk, { level: 'debug', signal: ctx.signal })
	}
}

export async function getPlayer(ctx: SR.Ctx & CS.AbortSignal, query: SM.PlayerIds.Ref, opts?: { ttl?: number }) {
	const playersRes = await getTeams(ctx, opts)
	if (playersRes.code !== 'ok') return playersRes
	const players = playersRes.players
	const player = SM.PlayerIds.find(players, (p) => p.ids, query)
	if (!player) return { code: 'err:player-not-found' as const }
	return { code: 'ok' as const, player }
}

// Takes the message itself, and resolves it here: RCON renders plain strings, and this is the point where the
// reader is known, so a per-recipient message gets the player it is being written to.
/** Warns one player. See warnAll for a list of them, warnAllAdmins for everyone holding admin. */
export async function warn(ctx: SR.Ctx & CS.AbortSignal & Msgs.Ctx, ids: SM.PlayerIds.EosIdQueryOrPlayerId, input: SR.WarnInput) {
	const _opts = Msgs.isMsg(input) ? ctx.tr.warn(input) : input
	let opts: SR.WarnOptionsBase<string>
	if (typeof _opts === 'function') {
		const playerRes = await getPlayer(ctx, ids)
		if (playerRes.code !== 'ok') return playerRes
		const optsRes = _opts({ ...CS.init(), player: playerRes.player, locale: ctx.tr.locale })
		if (!optsRes) return
		opts = optsRes
	} else {
		opts = _opts
	}

	let msgArr: string[]
	if (typeof opts === 'string') {
		msgArr = [opts]
	} else if (Array.isArray(opts)) {
		msgArr = opts
	} else {
		msgArr = Array.isArray(opts.msg) ? opts.msg : [opts.msg]
	}

	log.info(`Warning player: %s: %s`, SM.PlayerIds.prettyPrint(ids), msgArr)
	for (const msg of msgArr) {
		await ctx.rcon.execute(`AdminWarn "${SM.PlayerIds.normalizeToPlayerId(ids)}" ${msg}`, { level: 'debug', signal: ctx.signal })
	}
}

/** Warns each of the given players. For everyone holding admin instead, see warnAllAdmins. */
export const warnAll = Instr.spanOp(
	'warnAll',
	{ module, levels: { event: 'info' } },
	async (ctx: SR.Ctx & CS.AbortSignal & Msgs.Ctx, players: SM.PlayerIds.EosIdQueryOrPlayerId[], options: SR.WarnInput) => {
		const ops: Promise<unknown>[] = []
		for (const player of players) {
			ops.push(warn(ctx, player, options))
		}

		await Promise.all(ops)
	},
)

/** Warns every admin currently in game, resolved from the server's admin lists. Silent if rcon is down. */
export const warnAllAdmins = Instr.spanOp(
	'warnAllAdmins',
	{ module, levels: { event: 'info' } },
	async (ctx: SR.Ctx & CS.AbortSignal & Msgs.Ctx, options: SR.WarnInput, excludeSteamIds?: Set<string>) => {
		const [adminLists, teamsRes] = await Promise.all([AdminList.getListsForServerId(ctx, ctx.serverId), ctx.squadRcon.teams.get(ctx)])
		if (teamsRes.code === 'err:rcon') return
		const admins: SM.PlayerIds.Schema[] = []
		for (const player of teamsRes.players) {
			if (
				player.ids.steam &&
				SM.AdminList.isAdminInAny(adminLists, player.ids as SM.PlayerIds.IdQuery<'steam' | 'eos'>) &&
				!excludeSteamIds?.has(player.ids.steam)
			) {
				admins.push(player.ids)
			}
		}
		await warnAll(ctx, admins, options)
	},
)

async function fetchServerInfo(ctx: SR.Ctx.Rcon & CS.AbortSignal): Promise<SM.ServerInfoRes> {
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
		reserveSlots: rawInfo.PlayerReserveCount_I,
		reserveQueueLength: rawInfo.ReservedQueue_I,
	}

	return {
		code: 'ok' as const,
		data: serverStatus,
	}
}

// -------- the polled state: the roster, server info and layer status --------
//
// Each is a cached resource that SLM polls while anything observes it. A read is answered from the cache unless the
// cached answer is older than its `ttl`, and an observer is pushed every new answer. `ttl` is in ms and defaults to the
// resource's poll interval. It cannot go below MIN_TTL_MS: an observer's ttl becomes the poll interval for everyone,
// and a read with a tiny ttl is an rcon round trip per call.

export const MIN_TTL_MS = 1_000

function ttlAtLeastMin(opts?: { ttl?: number }) {
	return opts?.ttl === undefined ? undefined : { ttl: Math.max(opts.ttl, MIN_TTL_MS) }
}

/** The current roster, both teams and their squads. `polledAt` says how old the answer is. */
export async function getTeams(ctx: SR.Ctx & CS.AbortSignal, opts?: { ttl?: number }): Promise<SM.TeamsRes> {
	return await ctx.squadRcon.teams.get(ctx, ttlAtLeastMin(opts))
}

/** Every new roster, starting with the current one. */
export function teams$(ctx: SR.Ctx & CS.AbortSignal, opts?: { ttl?: number }): Rx.Observable<SM.TeamsRes> {
	return ctx.squadRcon.teams.observe(ctx, ttlAtLeastMin(opts))
}

/** Player and queue counts. */
export async function getServerInfo(ctx: SR.Ctx & CS.AbortSignal, opts?: { ttl?: number }): Promise<SM.ServerInfoRes> {
	return await ctx.squadRcon.serverInfo.get(ctx, ttlAtLeastMin(opts))
}

/** Every new answer of getServerInfo, starting with the current one. */
export function serverInfo$(ctx: SR.Ctx & CS.AbortSignal, opts?: { ttl?: number }): Rx.Observable<SM.ServerInfoRes> {
	return ctx.squadRcon.serverInfo.observe(ctx, ttlAtLeastMin(opts))
}

/** Current and next layer. Prefer it over getCurrentLayer + getNextLayer, which cost two rcon round trips per call. */
export async function getLayerStatus(ctx: SR.Ctx & CS.AbortSignal, opts?: { ttl?: number }): Promise<SM.LayerStatusRes> {
	return await ctx.squadRcon.layersStatus.get(ctx, ttlAtLeastMin(opts))
}

/** Every new answer of getLayerStatus, starting with the current one. */
export function layerStatus$(ctx: SR.Ctx & CS.AbortSignal, opts?: { ttl?: number }): Rx.Observable<SM.LayerStatusRes> {
	return ctx.squadRcon.layersStatus.observe(ctx, ttlAtLeastMin(opts))
}

const fetchLayerStatus = Instr.spanOp(
	'getLayerStatus',
	{ module },
	async (ctx: SR.Ctx.Rcon & CS.AbortSignal): Promise<SM.LayerStatusRes> => {
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

/** Sets the next layer on the game server directly. Bypasses the queue: LayerQueue.dispatchOp is the path that keeps SLM's state in step. */
export const setNextLayer = Instr.spanOp(
	'setNextLayer',
	{ module },
	async (ctx: SR.Ctx & CS.AbortSignal, layer: L.LayerId | L.UnvalidatedLayer) => {
		const cmd = L.getLayerCommand(layer, 'set-next')
		log.info(`Setting next layer: %s, `, cmd)
		await ctx.rcon.execute(cmd, { level: 'info', signal: ctx.signal })
		ctx.squadRcon.layersStatus.invalidate(ctx)
		const newStatus = await ctx.squadRcon.layersStatus.get(ctx)
		if (newStatus.code !== 'ok') return newStatus

		// this shouldn't happen. if it does we need to handle it more gracefully
		if (!newStatus.data.nextLayer) {
			throw new Error(
				`Failed to set next layer. Expected ${typeof layer === 'string' ? layer : JSON.stringify(layer)}, received undefined`,
			)
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

// AdminEnableVoting is what turns Squad's own end-of-match vote on and off. Turning it off is the only way to stop
// the vote deciding the next layer, so re-enabling SLM's updates without it would just leave the two fighting.
export function setIngameVotingEnabled(ctx: SR.Ctx.Rcon & CS.AbortSignal, enabled: boolean) {
	return ctx.rcon.execute(`AdminEnableVoting ${enabled ? 1 : 0}`, { level: 'info', signal: ctx.signal })
}

export function setFogOfWar(ctx: SR.Ctx.Rcon & CS.AbortSignal, mode: 'on' | 'off') {
	log.info(`Setting fog of war to %s`, mode)
	return ctx.rcon.execute(`AdminSetFogOfWar ${mode}`, { level: 'info', signal: ctx.signal })
}

/** Ends the match in progress immediately. The server rolls to whatever the next layer is set to. */
export async function endMatch(ctx: SR.Ctx.Rcon) {
	log.info(`Ending match`)
	await ctx.rcon.execute('AdminEndMatch', { level: 'info' })
}

export async function switchPlayers(ctx: SR.Ctx.Rcon & SR.Ctx & CS.AbortSignal, players: SM.PlayerIds.EosIdQueryOrPlayerId[]) {
	const ops: Promise<unknown>[] = []
	for (const ids of players) {
		const id = SM.PlayerIds.normalizeToPlayerId(ids)
		ops.push(ctx.rcon.execute(`AdminForceTeamChange ${id}`, { level: 'info', signal: ctx.signal }))
	}
	await Promise.all(ops)
	ctx.squadRcon.teams.invalidate(ctx)
}

// "Kill" trick: AdminForceTeamChange toggles a player's team and forces a respawn (death), so issuing it
// twice ~1s apart kills the player while returning them to their original team. Unlike the teamswap flow
// this doesn't broadcast switch notifications to admins, only warns the killed player, and invalidates
// teams once after both switches complete so the intermediate (swapped) team state is never surfaced.
export async function killPlayers(
	ctx: SR.Ctx.Rcon & SR.Ctx & SETTINGS.Ctx & CS.AbortSignal & Msgs.Ctx,
	players: SM.PlayerIds.EosIdQueryOrPlayerId[],
	reason?: string,
) {
	const ids = players.map((p) => SM.PlayerIds.normalizeToPlayerId(p))
	if (ids.length === 0) return
	log.info(`Killing players via double team switch: %o`, ids)
	// The two force-switches (and the wait between them) are atomic and deliberately ignore ctx.signal:
	// once the first switch fires, aborting must not skip the second, or the player is left stranded on the
	// opposite team instead of dead on their own.
	const forceSwitch = () => Promise.all(ids.map((id) => ctx.rcon.execute(`AdminForceTeamChange ${id}`, { level: 'info' })))
	// hold the teams fetch mutex across the double switch so no poll/refetch observes the player mid-swap
	// (on the opposite team). We invalidate only after releasing, triggering one fresh fetch of the settled
	// (back-to-original) state.
	await ctx.squadRcon.teams.fetchMtx.runExclusive(async () => {
		await forceSwitch()
		await Prom.sleep(1000)
		await forceSwitch()
	})
	ctx.squadRcon.teams.invalidate(ctx)
	await warnAll(ctx, ids, ctx.tr.warn(SM_Msgs.notifyKilled(reason)))
}

export async function demoteCommander(ctx: SR.Ctx.Rcon & SR.Ctx & CS.AbortSignal, ids: SM.PlayerIds.EosIdQueryOrPlayerId) {
	const id = SM.PlayerIds.normalizeToPlayerId(ids)
	log.info(`Demoting commander %s`, id)
	await ctx.rcon.execute(`AdminDemoteCommander ${id}`, { level: 'info', signal: ctx.signal })
	ctx.squadRcon.teams.invalidate(ctx)
}

export async function disbandSquad(ctx: SR.Ctx.Rcon & SR.Ctx & CS.AbortSignal, teamId: SM.TeamId, squadId: SM.SquadId) {
	log.info(`Disbanding squad %d on team %d`, squadId, teamId)
	await ctx.rcon.execute(`AdminDisbandSquad ${teamId} ${squadId}`, { level: 'info', signal: ctx.signal })
	ctx.squadRcon.teams.invalidate(ctx)
}

export async function kickPlayer(ctx: SR.Ctx.Rcon & SR.Ctx & CS.AbortSignal, ids: SM.PlayerIds.EosIdQueryOrPlayerId, reason?: string) {
	const id = SM.PlayerIds.normalizeToPlayerId(ids)
	log.info(`Kicking player %s`, id)
	await ctx.rcon.execute(`AdminKick "${id}" ${reason ?? ''}`.trim(), { level: 'info', signal: ctx.signal })
	ctx.squadRcon.teams.invalidate(ctx)
}

/**
 * Kicks players and returns the ones a fresh roster no longer lists. The server refuses to kick some players, such
 * as Squad's developers, and the reply to a refused kick has not been captured, so the roster is the evidence.
 */
export async function kickPlayersConfirmed(ctx: SR.Ctx.Rcon & SR.Ctx & CS.AbortSignal, targets: SM.PlayerId[], reason?: string) {
	log.info(`Kicking players %o`, targets)
	await Promise.all(
		targets.map((id) => ctx.rcon.execute(`AdminKick "${id}" ${reason ?? ''}`.trim(), { level: 'info', signal: ctx.signal })),
	)
	ctx.squadRcon.teams.invalidate(ctx)
	const teams = await ctx.squadRcon.teams.get(ctx)
	if (teams.code !== 'ok') {
		log.warn('Could not read the roster after kicking %o, so no kick is confirmed: %s', targets, teams.msg)
		return []
	}
	const remaining = new Set(teams.players.map((p) => SM.PlayerIds.getPlayerId(p.ids)))
	const refused = targets.filter((id) => remaining.has(id))
	if (refused.length > 0) log.warn('Players still on the server after a kick: %o', refused)
	return targets.filter((id) => !remaining.has(id))
}

export async function removeFromSquad(ctx: SR.Ctx.Rcon & SR.Ctx & CS.AbortSignal, ids: SM.PlayerIds.EosIdQueryOrPlayerId) {
	const id = SM.PlayerIds.normalizeToPlayerId(ids)
	log.info(`Removing player %s from squad`, id)
	await ctx.rcon.execute(`AdminRemovePlayerFromSquad ${id}`, { level: 'info', signal: ctx.signal })
	ctx.squadRcon.teams.invalidate(ctx)
}

export async function adminRenameSquad(ctx: SR.Ctx.Rcon & SR.Ctx & CS.AbortSignal, teamId: SM.TeamId, squadId: SM.SquadId) {
	await ctx.rcon.execute(`AdminRenameSquad ${teamId} ${squadId}`, { level: 'info', signal: ctx.signal })
	ctx.squadRcon.teams.invalidate(ctx)
}
