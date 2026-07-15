import type * as SchemaModels from '$root/drizzle/schema.models'
import * as Arr from '@/lib/array'
import { createLogMatcher, eventDef, type EventSchema, matchLog } from '@/lib/log-parsing'

import * as Obj from '@/lib/object'
import type { OneToManyMap } from '@/lib/one-to-many-map'
import { normalizeForMatch, simpleUniqueStringMatch } from '@/lib/string'
import * as ZodUtils from '@/lib/zod'
import type * as L from '@/models/layer'
import type * as MH from '@/models/match-history.models'
import * as dateFns from 'date-fns'
import { z } from 'zod'

export type SteamId = string
export type EosId = string

export const ServerRawInfoSchema = z.object({
	ServerName_s: z.string().default('Unknown'),
	MaxPlayers: z.int().nonnegative().default(0),
	PlayerCount_I: ZodUtils.ParsedIntSchema.default(0),
	PublicQueue_I: ZodUtils.ParsedIntSchema.default(0),
	PublicQueueLimit_I: ZodUtils.ParsedIntSchema.optional(),
	// MapName_s: z.string(),
	// GameMode_s: z.string(),
	// GameVersion_s: z.string(),
	// LICENSEDSERVER_b: z.boolean(),
	// PLAYTIME_I: ZodUtils.ParsedIntSchema.pipe(z.number().int().nonnegative()),
	// Flags_I: ZodUtils.ParsedIntSchema.pipe(z.number().int().nonnegative()),
	// MATCHHOPPER_s: z.string(),
	// MatchTimeout_d: z.number().int().nonnegative(),
	// SESSIONTEMPLATENAME_s: z.string(),
	// Password_b: z.boolean(),
	// CurrentModLoadedCount_I: ZodUtils.ParsedIntSchema.pipe(z.number().int().nonnegative()),
	// AllModsWhitelisted_b: z.boolean(),
	// Region_s: z.string(),
	// NextLayer_s: z.string().optional(),
	// TeamOne_s: z.string().optional(),
	// TeamTwo_s: z.string().optional(),
})

export type LayersStatus = {
	currentLayer: L.UnvalidatedLayer
	nextLayer: L.UnvalidatedLayer | null
}

export type ServerInfo = {
	name: string
	maxPlayerCount: number
	playerCount: number
	queueLength?: number
	maxQueueLength?: number
}

export type LayersStatusExt = LayersStatus & {
	currentMatch?: MH.MatchDetails
}

export type RconError = { code: 'err:rcon'; msg: string }

// the server has no live slice for this id: it's disabled, broken, still booting, or was torn down by a fatal
// resource error. Every per-server endpoint can return this instead of throwing or (worse) going silent.
export type ServerNotLoaded = { code: 'err:server-not-loaded'; serverId: string; msg: string }
export function serverNotLoaded(serverId: string): ServerNotLoaded {
	return { code: 'err:server-not-loaded', serverId, msg: `Server "${serverId}" is not currently loaded` }
}
export function isServerNotLoaded(value: unknown): value is ServerNotLoaded {
	return typeof value === 'object' && value !== null && (value as ServerNotLoaded).code === 'err:server-not-loaded'
}

export type ServerInfoRes = { code: 'ok'; data: ServerInfo } | RconError
export type LayerStatusRes = { code: 'ok'; data: LayersStatus } | RconError
export type LayersStatusResExt = { code: 'ok'; data: LayersStatusExt } | RconError

export const TeamIdSchema = z.union([z.literal(1), z.literal(2)])
export type TeamId = z.infer<typeof TeamIdSchema>
export function oppositeTeamId(teamId: TeamId): TeamId {
	return teamId === 1 ? 2 : 1
}

export namespace PlayerIds {
	export type Fields = 'username' | 'steam' | 'eos' | 'playerController' | 'usernameNoTag' | 'epic'

	export type IdQuery<Required extends Fields = never> = { [k in Fields]?: string } & { [k in Required]: string }

	export function IdFields<F extends Fields>(...fields: F[]): z.ZodType<IdQuery<F>> {
		return z.object({
			username: Arr.includes(fields, 'username') ? z.string() : z.string().optional(),
			usernameNoTag: Arr.includes(fields, 'usernameNoTag') ? z.string() : z.string().optional(),
			steam: Arr.includes(fields, 'steam') ? z.string() : z.string().optional(),
			eos: Arr.includes(fields, 'eos') ? z.string() : z.string().optional(),
			epic: Arr.includes(fields, 'epic') ? z.string() : z.string().optional(),
			playerController: Arr.includes(fields, 'playerController') ? z.string() : z.string().optional(),
			tag: Arr.includes(fields, 'tag') ? z.string().nullable() : z.string().nullable().optional(),
		}) as any
	}

	export const IdQuerySchema = IdFields()
	export const Schema = IdFields('eos', 'username')
	export type Schema = z.infer<typeof Schema>

	export function getPlayerId(ids: IdQuery<'eos'>) {
		return ids.eos
	}
	export function queryFromPlayerId(id: PlayerId): IdQuery<'eos'> {
		return { eos: id }
	}

	export type IdQueryOrPlayerId = IdQuery | PlayerId
	export type EosIdQueryOrPlayerId = IdQuery<'eos'> | PlayerId
	export function normalizeIdQuery(id: IdQueryOrPlayerId): IdQuery {
		return typeof id === 'string' ? queryFromPlayerId(id) : id
	}
	export function normalizeToPlayerId(id: EosIdQueryOrPlayerId): PlayerId {
		return typeof id === 'string' ? id : getPlayerId(id)
	}

	export type Type = z.infer<typeof Schema>

	// in order of lookup preference
	const LOOKUP_PROPS = ['eos', 'steam', 'epic', 'playerController', 'usernameNoTag', 'username'] as const

	// expected to be unique in a collection of PlayerIds. maybe playerController is unique too, not sure
	const UNIQUE_PROPS = ['steam', 'eos', 'epic'] as const

	// old signature
	// export function parsePlayerIds(username: string, idsStr?: string): Type {
	export function parse(opts: { playerController?: string; usernameNoTag?: string; username?: string; idsStr?: string; eos?: string }) {
		const ids: any = {}
		if (opts.idsStr) {
			for (const { key, value } of matchAllIds(opts.idsStr)) {
				if (value === undefined) continue
				ids[key] = value
			}
		}
		const username = opts.username?.trim()
		const usernameNoTag = opts.usernameNoTag?.trim()
		if (username && usernameNoTag) {
			const lenDiff = Math.max(username.length - usernameNoTag.length, 0)
			const tag = username.slice(0, lenDiff).trim() || undefined
			if (tag) {
				ids.tag = tag
			}
		}
		return Obj.trimUndefined({
			...ids,
			usernameNoTag,
			username,
			playerController: opts.playerController?.trim(),
			eos: opts.eos?.trim() ?? ids.eos,
		})
	}

	export function find(idList: Type[], id: IdQueryOrPlayerId): Type | undefined
	export function find<T>(idList: T[], cb: (item: T) => Type, id: IdQueryOrPlayerId): T | undefined
	export function find<T>(
		elts: T[] | Type[],
		cbOrId?: ((item: T) => Type) | IdQueryOrPlayerId,
		id?: IdQueryOrPlayerId,
	): T | Type | undefined {
		if (typeof cbOrId === 'function') {
			const cb = cbOrId
			const searchId = normalizeIdQuery(id!)
			for (const item of elts as T[]) {
				const itemIds = cb(item)
				if (match(itemIds, searchId)) return item
			}
			return undefined
		}

		const searchId = normalizeIdQuery(cbOrId!)
		for (const prop of LOOKUP_PROPS) {
			if (!searchId[prop]) continue
			for (const item of elts as Type[]) {
				if (match(item, searchId)) return item
			}
		}
	}

	export function indexOf(idList: Type[], id: IdQueryOrPlayerId): number
	export function indexOf<T>(idList: T[], cb: (item: T) => Type, id: IdQueryOrPlayerId): number
	export function indexOf<T>(
		elts: T[] | Type[],
		cbOrId?: ((item: T) => Type) | IdQueryOrPlayerId,
		id?: IdQueryOrPlayerId,
	): number {
		if (typeof cbOrId === 'function') {
			const cb = cbOrId
			const searchId = normalizeIdQuery(id!)
			for (let i = 0; i < (elts as T[]).length; i++) {
				const eltIds = cb((elts as T[])[i])
				if (match(eltIds, searchId)) return i
			}
			return -1
		}

		const searchId = normalizeIdQuery(cbOrId!)
		for (let i = 0; i < (elts as Type[]).length; i++) {
			const elt = (elts as Type[])[i]
			if (match(elt, searchId)) return i
		}
		return -1
	}

	export function upsert(idList: Type[], id: Type): Type
	export function upsert<T>(idList: T[], cb: (item: T) => Type, newItem: T): T
	export function upsert<T>(
		elts: T[] | Type[],
		cbOrId: ((item: T) => Type) | Type,
		itemOrId?: T | Type,
	) {
		if (typeof cbOrId === 'function') {
			// Overload: upsert<T>(idList: T[], cb: (item: T) => Type, newItem: T): T
			const cb = cbOrId
			const newItem = itemOrId as T
			const searchId = cb(newItem)
			const existingIndex = indexOf(elts as T[], cb, searchId)
			if (existingIndex !== -1) {
				const existingIds = cb((elts as T[])[existingIndex])
				for (const prop of UNIQUE_PROPS) {
					if (!searchId[prop]) continue
					if (existingIds[prop] !== searchId[prop]) {
						console.error(`ID conflict: ${prop}=${searchId[prop]} vs ${existingIds[prop]}. keeping ${existingIds[prop]}`)
						return
					}
				}
				;(elts as T[]).splice(existingIndex, 1, newItem)
				return newItem
			}
			;(elts as T[]).push(newItem)
			return newItem
		}

		// Original overload: upsert(idList: Type[], id: Type): Type
		const searchId = cbOrId as Type
		const existingIndex = indexOf(elts as Type[], searchId)
		if (existingIndex !== -1) {
			const existing = (elts as Type[])[existingIndex]
			for (const prop of UNIQUE_PROPS) {
				if (!searchId[prop]) continue
				if (existing[prop] !== searchId[prop]) {
					console.error(`ID conflict: ${prop}=${searchId[prop]} vs ${existing[prop]}. keeping ${existing[prop]}`)
					return existing
				}
			}
			;(elts as Type[]).splice(existingIndex, 1, searchId)
			return searchId
		}
		;(elts as Type[]).push(searchId)
		return searchId
	}

	export function remove(idList: Type[], id: IdQueryOrPlayerId): boolean
	export function remove<T>(idList: T[], cb: (item: T) => Type, id: IdQueryOrPlayerId): boolean
	export function remove<T>(
		elts: T[] | Type[],
		cbOrId?: ((item: T) => Type) | IdQueryOrPlayerId,
		id?: IdQueryOrPlayerId,
	): boolean {
		if (typeof cbOrId === 'function') {
			const cb = cbOrId
			const searchId = normalizeIdQuery(id!)
			for (const prop of LOOKUP_PROPS) {
				if (!searchId[prop]) continue
				for (let i = 0; i < (elts as T[]).length; i++) {
					if (cb((elts as T[])[i])[prop] === searchId[prop]) {
						;(elts as T[]).splice(i, 1)
						return true
					}
				}
			}
			return false
		}

		const searchId = normalizeIdQuery(cbOrId!)
		for (const prop of LOOKUP_PROPS) {
			if (!searchId[prop]) continue
			for (let i = 0; i < (elts as Type[]).length; i++) {
				if ((elts as Type[])[i][prop] === searchId[prop]) {
					;(elts as Type[]).splice(i, 1)
					return true
				}
			}
		}
		return false
	}

	export function match(a: IdQueryOrPlayerId, b: IdQueryOrPlayerId): boolean {
		const aNorm = normalizeIdQuery(a)
		const bNorm = normalizeIdQuery(b)
		for (const prop of LOOKUP_PROPS) {
			if (aNorm[prop] && bNorm[prop] && aNorm[prop] === bNorm[prop]) return true
		}
		if (aNorm.username && bNorm.usernameNoTag?.includes(aNorm.username)) return true
		if (bNorm.username && aNorm.usernameNoTag?.includes(bNorm.username)) return true
		return false
	}

	// Identifier fields matched by exact whole-value equality in free-text player search. Usernames are
	// deliberately excluded: they use incremental substring matching instead.
	const STRICT_SEARCH_FIELDS = ['steam', 'eos', 'epic', 'playerController'] as const satisfies readonly Fields[]

	export function matchesStrictSearch(id: IdQueryOrPlayerId, query: string): boolean {
		const target = query.trim().toLowerCase()
		if (!target) return false
		const ids = normalizeIdQuery(id)
		for (const field of STRICT_SEARCH_FIELDS) {
			const value = ids[field]
			if (value !== undefined && value.toLowerCase() === target) return true
		}
		return false
	}

	const ID_MATCHER = /\s*(?<name>[^\s:]+)\s*:\s*(?<id>[^\s]+)/g

	function* matchAllIds(idsStr: string) {
		for (const match of idsStr.matchAll(ID_MATCHER)) {
			yield { key: match.groups!.name.toLowerCase(), value: match.groups!.id }
		}
	}

	// Resolves a player from a bare display name (e.g. a Die()/Wound() log line, which carries no online ids for the
	// victim). Exact matching is find()'s job; this adds tolerance for tag/whitespace/unicode differences between log
	// and RCON names via normalized containment in either direction, requiring the match to be unique. A unique-but-wrong
	// containment is possible when the real player isn't in the list, so only use this as a fallback after find().
	export function findByUsernameLoose<T>(players: T[], cb: (item: T) => Type, username: string): T | undefined {
		const names = players.map(p => cb(p).username ?? '')
		const res = simpleUniqueStringMatch(names, username)
		if (res.code === 'ok') return players[res.matched]
		// the log name may carry a tag the RCON name lacks; try the reverse direction
		const target = normalizeForMatch(username)
		if (!target) return undefined
		const reverseMatches: number[] = []
		for (let i = 0; i < names.length; i++) {
			const name = normalizeForMatch(names[i])
			if (name && target.includes(name)) reverseMatches.push(i)
		}
		if (reverseMatches.length === 1) return players[reverseMatches[0]]
		return undefined
	}

	export function prettyPrint(id: IdQueryOrPlayerId) {
		const type = normalizeIdQuery(id)
		const parts: string[] = []
		if (type.username) parts.push(type.username)
		if (type.steam) parts.push(`steam:${type.steam}`)
		if (type.eos) parts.push(`eos:${type.eos}`)
		if (type.epic) parts.push(`epic:${type.epic}`)
		if (type.playerController) parts.push(`pc:${type.playerController}`)
		return parts.join(' | ')
	}

	export function fuzzyMatchIdentifierUniquely(
		players: Type[],
		id: string,
	): { code: 'ok'; matched: Type } | { code: 'err:not-found' } | { code: 'err:multiple-matches'; count: number }
	export function fuzzyMatchIdentifierUniquely<T>(
		players: T[],
		cb: (item: T) => Type,
		id: string,
	): { code: 'ok'; matched: T } | { code: 'err:not-found' } | { code: 'err:multiple-matches'; count: number }
	export function fuzzyMatchIdentifierUniquely<T>(
		players: T[] | Type[],
		cbOrId: ((item: T) => Type) | string,
		id?: string,
	): { code: 'ok'; matched: T | Type } | { code: 'err:not-found' } | { code: 'err:multiple-matches'; count: number } {
		if (typeof cbOrId === 'function') {
			const cb = cbOrId
			const searchId = id!
			const exact = (players as T[]).filter(p => {
				const ids = cb(p)
				return ids.eos === searchId || ids.steam === searchId || ids.epic === searchId
			})
			if (exact.length === 1) return { code: 'ok', matched: exact[0] }
			if (exact.length > 1) return { code: 'err:multiple-matches', count: exact.length }
			const result = simpleUniqueStringMatch((players as T[]).map(p => cb(p).username?.toLowerCase() ?? ''), searchId)
			if (result.code !== 'ok') return result
			return { code: 'ok', matched: (players as T[])[result.matched] }
		}

		const searchId = cbOrId
		const exact = (players as Type[]).filter(p => p.eos === searchId || p.steam === searchId)
		if (exact.length === 1) return { code: 'ok', matched: exact[0] }
		if (exact.length > 1) return { code: 'err:multiple-matches', count: exact.length }
		const result = simpleUniqueStringMatch((players as Type[]).map(p => p.username?.toLowerCase() ?? ''), searchId)
		if (result.code !== 'ok') return result
		return { code: 'ok', matched: (players as Type[])[result.matched] }
	}
}

export const ChainIdSchema = ZodUtils.ParsedIntSchema

export const PLAYER_DETAILS = ['role', 'isAdmin'] as const
export const PlayerSchema = z.object({
	ids: PlayerIds.Schema,
	teamId: TeamIdSchema.nullable(),
	squadId: z.number().nullable(),
	isLeader: z.boolean(),
	isAdmin: z.boolean(),
	role: z.string(),
})

export type Player = z.infer<typeof PlayerSchema>
export const PlayerIdSchema = z.string()
export type PlayerId = EosId

// A roster is "settled" when every player has been assigned to a team -- i.e. no one is still loading / unassigned.
// Canonical gate for operations that need faithful team data (e.g. executing configured team swaps): acting on a
// roster with team-less players would compute moves / balance against an incomplete picture.
export function allPlayersTeamed(players: Pick<Player, 'teamId'>[]): boolean {
	return players.every(p => p.teamId != null)
}
export type PlayerAssoc<Type extends SchemaModels.ServerEventPlayerAssocType = 'player', Value = PlayerId> = { [key in Type]: Value }
export function toDedupedRoleName(role: string): string {
	const regex = /([A-Z]+)_([A-Za-z]+)(_(\d+))?/
	const match = role.match(regex)
	if (!match) return role
	return match[2]
}
export namespace Players {
	export type SquadGroup = { squadId: SquadId; teamId: TeamId; players: Player[] }
	export function groupIntoSquads(players: Player[]) {
		const squads: SquadGroup[] = []
		for (const player of players) {
			if (player.squadId === null || player.teamId === null) continue
			let squad = squads.find(s => s.squadId === player.squadId && s.teamId === player.teamId)
			if (!squad) {
				squad = { squadId: player.squadId, teamId: player.teamId, players: [] }
				squads.push(squad)
			}
			squad.players.push(player)
		}
		return squads
	}
}

export type SquadId = number
export const SquadSchema = z.object({
	squadId: z.number(),
	squadName: z.string().min(1),
	locked: z.boolean(),
	creator: PlayerIdSchema,
	teamId: TeamIdSchema,
})

export type Squad = z.infer<typeof SquadSchema>
export const SQUAD_DETAILS = ['locked'] as const

// the in-game name Squad gives the commander's squad
export const COMMAND_SQUAD_NAME = 'Command Squad'
export function isCommandSquad(squad: Pick<Squad, 'squadName'>): boolean {
	return squad.squadName === COMMAND_SQUAD_NAME
}

// the text tag prepended to a squad-directed warn so members see who it's aimed at. command squads read as
// "@cmdSquad" since their squad number isn't a meaningful reference.
export function squadWarnTag(squad: Pick<Squad, 'squadId' | 'squadName'>): string {
	return isCommandSquad(squad) ? '@cmdSquad' : `@Squad${squad.squadId}`
}

// admin-facing squad identifier including faction, e.g. "Squad1 (PLA)" (or "cmdSquad (PLA)" for the command squad)
export function squadAdminLabel(squad: Pick<Squad, 'squadId' | 'squadName'>, faction?: string): string {
	const base = isCommandSquad(squad) ? 'cmdSquad' : `Squad${squad.squadId}`
	return faction ? `${base} (${faction})` : base
}

// Squad with a server-assigned uniqueId that is stable for the lifetime of the squad instance
export const UniqueSquadSchema = SquadSchema.extend({
	uniqueId: z.number(),
})
export type UniqueSquad = z.infer<typeof UniqueSquadSchema>

export type PlayerListRes = { code: 'ok'; players: Player[] } | RconError
export type SquadListRes = { code: 'ok'; squads: Squad[] } | RconError
export type Teams<P = Player> = { players: P[]; squads: Squad[] }
export type UniqueTeams<P = Player> = { players: P[]; squads: UniqueSquad[] }
// `polledAt` is the wall-clock time the ListPlayers/ListSquads requests were issued -- a lower bound on when
// the snapshot was actually taken (the server captures it no earlier than the request is sent). The event
// pipeline orders teams polls by this, NOT by when the response arrived: a response can be in flight across a
// map roll, so it still reflects the pre-roll roster while arriving after the roll's NEW_GAME log. Timestamping
// at receive time would let that stale snapshot complete the roll; polledAt keeps it correctly pre-boundary.
export type TeamsRes<P = Player> = { code: 'ok'; polledAt: number } & Teams<P> | RconError

export namespace Squads {
	// identifies a squad across teams
	export type Key = { squadId: SquadId; teamId: TeamId }
	export type PartialKey = { squadId: SquadId | null; teamId: TeamId | null }
	export type FullKey = Key & { uniqueId: number; creator: PlayerId }

	// returns false if any missing properties
	export function idsEqual(a: PartialKey, b: PartialKey) {
		if (a.squadId === null || b.squadId === null || a.teamId === null || b.teamId === null) {
			return false
		}
		return a.squadId === b.squadId && a.teamId === b.teamId
	}
	export function printKey(key: Key) {
		return `${key.teamId}-${key.squadId}`
	}

	export function isSquadKeyLike(obj: unknown): obj is { squadId: number; teamId: number } {
		return typeof obj === 'object' && obj !== null && typeof (obj as { squadId: unknown }).squadId === 'number'
			&& typeof (obj as { teamId: unknown }).teamId === 'number'
	}
}

export function findSquadLeader(players: Player[]) {
}

// https://squad.fandom.com/wiki/Server_Configuration#Admins.cfg
export const PLAYER_PERM = z.enum([
	'startvote', // not used
	'changemap', // switch to another map
	'pause', // Pause server gameplay
	'cheat', // Use server cheat commands
	'private', // Password protect server
	'balance', // Group Ignores server team balance
	'kick', // kick a player
	'ban', // ban a player
	'config', // Change server config
	'cameraman', // Admin spectate mode
	'immune', // Cannot be kicked / banned
	'manageserver', // Shutdown server
	'featuretest', // Any features added for testing by dev team
	'reserve', // Reserve slot
	'demos', // Record Demos ("demos" appears to only work when added together with "demo,ClientDemos" access levels aswell. Keep in mind that admins with these permissions have to be on the server for the files to be saved on their PC. They can be AFK but have to have "ENABLE AUTO RECORD MULTIPLAYER GAMES" setting in their "REPLAY" settings enabled for it to work without manual saving). Player names still cannot be viewed for some reason though.
	'demo', // Record Demos (see demos)
	'ClientDemos', // Record Demos (see demos)
	'debug', // show admin stats command and other debugging info
	'teamchange', // No timer limits on team change
	'forceteamchange', // Can issue the ForceTeamChange command
	'canseeadminchat', // This group can see the admin chat and teamkill/admin-join notifications
])
export type PlayerPerm = z.infer<typeof PLAYER_PERM>
// remote/local/ftp keep a single `source` string (a URL, local path, or ftp:// URI); sftp holds its connection
// details separately so they can be entered directly (or copied from the server's sftp log connection).
export const AdminListSourceSchema = z.discriminatedUnion('type', [
	z.object({ type: z.literal('remote'), source: z.string() }),
	z.object({ type: z.literal('local'), source: z.string() }),
	z.object({ type: z.literal('ftp'), source: z.string() }),
	z.object({
		type: z.literal('sftp'),
		host: z.string(),
		port: z.number().min(1).max(65535).prefault(22),
		username: z.string(),
		password: z.string(),
		filePath: z.string(),
	}),
])
export type AdminListSource = z.infer<typeof AdminListSourceSchema>
export type AdminListSourceType = AdminListSource['type']
// steamId -> groups
export type SquadAdmins = OneToManyMap<SteamId, string>
// group -> permissions
export type SquadGroups = OneToManyMap<string, string>
export type AdminList = { players: SquadAdmins; groups: SquadGroups; admins: Set<SteamId> }

export const CHAT_CHANNEL_TYPE = z.enum(['ChatAdmin', 'ChatTeam', 'ChatSquad', 'ChatAll'])
export type ChatChannelType = z.infer<typeof CHAT_CHANNEL_TYPE>

export type ChatChannel =
	| { type: 'ChatAll' }
	| { type: 'ChatAdmin' }
	| { type: 'ChatTeam'; teamId: TeamId }
	| { type: 'ChatSquad'; teamId: TeamId; squadId: SquadId; uniqueId?: number }

export const RCON_MAX_BUF_LEN = 4152

export const SquadOutcomeTeamSchema = z.object({
	faction: z.string(),
	unit: ZodUtils.StrOrNullIfEmptyOrWhitespace,
	team: TeamIdSchema,
	tickets: z.number().positive(),
})

export type SquadOutcomeTeam = z.infer<typeof SquadOutcomeTeamSchema>

export type LayerSyncState =
	| {
		// for when the expected layer in the app's backend memory is not what's currently on the server, aka we're waiting for the squad server to tell us that its current layer has been updated
		status: 'desynced'
		// local in this case meaning our application server
		expected: string
		current: string
	}
	| {
		// server offline
		status: 'offline'
	}
	| {
		// expected layer is on the server
		status: 'synced'
		value: string
	}

export type PlayerRef = string

export namespace RconEvents {
	const ChatMessageDef = eventDef('CHAT_MESSAGE', {
		time: z.number(),
		channelType: CHAT_CHANNEL_TYPE,
		message: z.string(),
		playerIds: PlayerIds.Schema,
	})
	export type ChatMessage = z.infer<typeof ChatMessageDef['schema']>

	export const ChatMessageMatcher = createLogMatcher({
		event: ChatMessageDef,
		regex: /\[(ChatAll|ChatTeam|ChatSquad|ChatAdmin)] \[Online IDs:([^\]]+)\] (.+?) : (.*)/,
		onMatch: (match) => {
			return {
				time: Date.now(),
				channelType: match[1] as ChatChannelType,
				message: match[4],
				playerIds: PlayerIds.parse({ username: match[3], idsStr: match[2] }),
			}
		},
	})

	const PlayerWarnedDef = eventDef('PLAYER_WARNED', {
		time: z.number(),
		reason: z.string(),
		playerIds: PlayerIds.IdFields('username'),
	})
	export type PlayerWarned = z.infer<typeof PlayerWarnedDef['schema']>

	export const PlayerWarnedMatcher = createLogMatcher({
		event: PlayerWarnedDef,
		regex: /Remote admin has warned player (.*)\. Message was "(.*)"/s,
		onMatch: (match) => {
			return {
				time: Date.now(),
				reason: match[2],
				playerIds: PlayerIds.parse({ username: match[1] }),
			}
		},
	})

	const PossessedAdminCameraDef = eventDef('POSSESSED_ADMIN_CAMERA', {
		time: z.number(),
		playerIds: PlayerIds.Schema,
	})
	export type PossessedAdminCamera = z.infer<typeof PossessedAdminCameraDef['schema']>

	export const PossessedAdminCameraMatcher = createLogMatcher({
		event: PossessedAdminCameraDef,
		regex: /\[Online Ids:([^\]]+)\] (.+) has possessed admin camera\./,
		onMatch: (match) => {
			return {
				type: 'POSSESSED_ADMIN_CAMERA' as const,
				time: Date.now(),
				playerIds: PlayerIds.parse({ username: match[2], idsStr: match[1] }),
			}
		},
	})

	const UnpossessedAdminCameraDef = eventDef('UNPOSSESSED_ADMIN_CAMERA', {
		time: z.number(),
		playerIds: PlayerIds.Schema,
	})
	export type UnpossessedAdminCamera = z.infer<typeof UnpossessedAdminCameraDef['schema']>

	export const UnpossessedAdminCameraMatcher = createLogMatcher({
		event: UnpossessedAdminCameraDef,
		regex: /\[Online IDs:([^\]]+)\] (.+) has unpossessed admin camera\./,
		onMatch: (match) => {
			return {
				time: Date.now(),
				playerIds: PlayerIds.parse({ username: match[2], idsStr: match[1] }),
			}
		},
	})

	const SquadCreatedDef = eventDef('SQUAD_CREATED', {
		time: z.number(),
		squadId: ZodUtils.ParsedIntSchema,
		squadName: z.string(),
		teamName: z.string(),
		creatorIds: PlayerIds.Schema,
	})
	export type SquadCreated = z.infer<typeof SquadCreatedDef['schema']>

	export const SquadCreatedMatcher = createLogMatcher({
		event: SquadCreatedDef,
		regex: /(?<playerName>.+) \(Online IDs:([^)]+)\) has created Squad (?<squadId>\d+) \(Squad Name: (?<squadName>.+)\) on (?<teamName>.+)/,
		onMatch: (match) => {
			return {
				time: Date.now(),
				squadId: match.groups!.squadId,
				squadName: match.groups!.squadName,
				teamName: match.groups!.teamName,
				creatorIds: PlayerIds.parse({ username: match.groups!.playerName, idsStr: match[2] }),
			}
		},
	})

	const PlayerBannedDef = eventDef('PLAYER_BANNED', {
		time: z.number(),
		playerID: z.string(),
		interval: z.string(),
		playerIds: PlayerIds.IdFields('username', 'eos'),
	})
	export type PlayerBanned = z.infer<typeof PlayerBannedDef['schema']>

	export const PlayerBannedMatcher = createLogMatcher({
		event: PlayerBannedDef,
		regex: /Banned player ([0-9]+)\. \[Online IDs=([^\]]+)\] (.*) for interval (.*)/,
		onMatch: (match) => {
			return {
				time: Date.now(),
				playerID: match[1],
				interval: match[4],
				playerIds: PlayerIds.parse({ username: match[3], idsStr: match[2] }),
			}
		},
	})

	const SquadRenamedDef = eventDef('SQUAD_RENAMED', {
		time: z.number(),
		squadId: z.number(),
		teamId: z.number(),
		oldSquadName: z.string(),
		newSquadName: z.string(),
	})

	export type SquadRenamed = z.infer<typeof SquadRenamedDef['schema']>

	export const SquadRenamedMatcher = createLogMatcher({
		event: SquadRenamedDef,
		regex: /Remote admin renamed squad (?<squadId>\d+) on team (?<teamId>\d+), named "(?<oldSquadName>.+)", to "(?<newSquadName>.+)"/,
		onMatch: (match) => {
			return {
				time: Date.now(),
				squadId: Number(match[1]),
				teamId: Number(match[2]),
				oldSquadName: match[3],
				newSquadName: match[4],
			}
		},
	})

	export const matchers = [
		ChatMessageMatcher,
		PlayerWarnedMatcher,
		PossessedAdminCameraMatcher,
		UnpossessedAdminCameraMatcher,
		SquadCreatedMatcher,
		PlayerBannedMatcher,
		SquadRenamedMatcher,
	] as const

	export type Event = z.infer<(typeof matchers)[number]['event']['schema']>
}

export const RCON_EVENT_MATCHERS = RconEvents.matchers

export namespace LogEvents {
	export const ActionSourceSchema = z.discriminatedUnion('type', [
		z.object({ type: z.literal('rcon') }),
		z.object({ type: z.literal('player'), playerIds: PlayerIds.IdFields('username', 'eos', 'steam') }),
	])
	export type ActionSource = z.infer<typeof ActionSourceSchema>

	// Regex fragment: appends two capture groups — (idsStr, username) for the player case.
	// Use ACTION_SOURCE_CAPTURE_COUNT to offset subsequent group indices.
	export const ACTION_SOURCE_CAPTURE_COUNT = 2
	const ACTION_SOURCE_REGEX_SRC = String.raw`((?<rcon>RCON)|(?<player>player \d+\. \[Online IDs= (?<idsStr>[^\]]+)\]\s+(?<username>.+)))`

	export function parseActionSource(matches: RegExpMatchArray): ActionSource {
		const { rcon, idsStr, username } = matches.groups!
		if (rcon) return { type: 'rcon' }
		if (idsStr && username) {
			return { type: 'player', playerIds: PlayerIds.parse({ username, idsStr }) }
		}
		throw new Error(`Invalid capture groups resolved from ACTION_SOURCE_REGEX_SRC: ${JSON.stringify(matches.groups ?? null)}`)
	}

	const logStartRegex = /^([[0-9.:-]+]\[[ 0-9]*]).+$/
	export type ParseOutputEvent = AnyChainEvent | NonChainEvent

	// e.g. "[2026.07.02-08.27.38:836][686]LogSquad: USQGameState: Server Tick Rate: 63.77". Reported periodically
	// rather than as a discrete event, so it's scanned for a live gauge instead of routed through the event pipeline.
	const tickRateRegex = /^\[[0-9.:-]+]\[[ 0-9]*]LogSquad: USQGameState: Server Tick Rate: ([0-9.]+)/
	export function parseTickRate(line: string): number | null {
		const match = line.match(tickRateRegex)
		if (!match) return null
		const rate = Number(match[1])
		return Number.isFinite(rate) ? rate : null
	}

	export async function* parseLogStream(
		chunk$: AsyncGenerator<string>,
		errors: Error[],
		// Tick rate is a periodic gauge rather than a discrete event, so it's surfaced via this callback instead of
		// being routed through the event pipeline. We should follow this pattern for other other gauge-style logs in future
		onTickRate?: (rate: number) => void,
	) {
		let foundLogStart: boolean = false
		let lineBuffer: string[] = []
		let chainState: { chainID: number; events: Event[] } | null = null

		function handleEvent(event: Event): ParseOutputEvent[] {
			const results: (AnyChainEvent | NonChainEvent)[] = []
			if (!chainState) {
				chainState = { chainID: event.chainID, events: [] }
			}

			if (event.chainID === chainState.chainID) {
				chainState.events.push(event)
				return results
			}

			let chainDef: ChainDef | undefined
			let chainKey: keyof typeof LOG_CHAINS | undefined
			for (const event of chainState.events) {
				const membership = EVENT_CHAIN_MAP.get(event.type)
				if (membership?.primary) {
					chainDef = LOG_CHAINS[membership.chainKey]
					chainKey = membership.chainKey
					break
				}
			}

			if (chainDef) {
				const chainEvents: ChainEvents<typeof chainDef> = {}
				const eventKeys = new Set(chainEventKeys(chainDef))
				for (const event of chainState.events) {
					if (!eventKeys.has(event.type)) continue
					if (chainEvents[event.type]) {
						errors.push(new Error(`Duplicate event type: ${event.type}`))
						continue
					}
					chainEvents[event.type] = event
				}
				const chainEvent: AnyChainEvent = { type: chainKey!, events: chainEvents as any, time: chainState.events[0]!.time }
				const chainErrors = validateChainEvent(chainEvent, chainDef)
				if (chainErrors.length > 0) {
					errors.push(...chainErrors)
				} else {
					results.push(chainEvent)
				}
			} else {
				results.push(...(chainState.events as any[]))
			}

			chainState = { chainID: event.chainID, events: [event] }

			return results
		}

		const MAX_CONTINUATION_LINES = 100
		let carry = ''
		for await (const chunk of chunk$) {
			const lines = chunk.split(/\r?\n/)
			lines[0] = carry + lines[0]
			carry = lines.pop() ?? ''
			if (lines.length === 0) continue
			for (const line of lines) {
				if (onTickRate) {
					const rate = parseTickRate(line)
					if (rate !== null) onTickRate(rate)
				}
				const match = line.match(logStartRegex)
				if (!match) {
					if (foundLogStart && lineBuffer.length <= MAX_CONTINUATION_LINES) lineBuffer.push(line)
					continue
				}
				if (foundLogStart) {
					const bufferContent = lineBuffer.join('\n')
					lineBuffer = [line]
					const [event, err] = matchLog(bufferContent, EventMatchers)
					if (event === null && err == null) continue
					if (err !== null) {
						errors.push(err)
						yield null
						continue
					}
					;(event as any).raw = bufferContent.trim()
					yield* handleEvent(event!)
					continue
				}
				foundLogStart = true
				lineBuffer = [line]
			}
		}

		if (foundLogStart && lineBuffer.length > 0) {
			const bufferContent = lineBuffer.join('\n')
			const [event, err] = matchLog(bufferContent, EventMatchers)
			if (err !== null) {
				errors.push(err)
				yield null
			} else if (event !== null) {
				;(event as any).raw = bufferContent.trim()
				yield* handleEvent(event)
			}
		}
	}

	const BaseEventProperties = {
		raw: z.string().trim(),
		time: z.number(),
		chainID: ChainIdSchema,
	}

	export type SquadLogEvent = {
		type: string
	}

	const NewGameDef = eventDef('NEW_GAME', {
		...BaseEventProperties,
		mapClassname: z.string().trim(),
		layerClassname: z.string().trim(),
	})

	export type NewGame = z.infer<typeof NewGameDef['schema']>

	export const NewGameEventMatcher = createLogMatcher({
		regex: /^\[([0-9.:-]+)]\[([ 0-9]*)]LogWorld: Bringing World \/([A-z]+)\/(?:Maps\/)?([A-z0-9-]+)\/(?:.+\/)?([A-z0-9-]+)(?:\.[A-z0-9-]+)/,
		event: NewGameDef,
		onMatch: (args) => ({
			raw: args[0],
			time: parseTimestamp(args[1]),
			chainID: args[2],
			mapClassname: args[3],
			layerClassname: args[5],
		}),
	})

	const RoundWinnerDef = eventDef('ROUND_TEAM_OUTCOME', {
		...BaseEventProperties,
		winner: z.string(),
		layer: z.string(),
	})

	export type RoundTeamOutcome = z.infer<typeof RoundWinnerDef['schema']>

	export const RoundWinnerEventMatcher = createLogMatcher({
		regex: /^\[([0-9.:-]+)]\[([ 0-9]*)]LogGame: Winner: (.+) \(Layer: (.+)\)/,
		event: RoundWinnerDef,
		onMatch: (args) => ({
			raw: args[0],
			time: parseTimestamp(args[1]),
			chainID: args[2],
			winner: args[3],
			layer: args[4],
		}),
	})

	const RoundDecidedBaseProps = {
		...BaseEventProperties,
		team: z.union([z.literal(1), z.literal(2), z.literal(-1)]),
		unit: z.string(),
		faction: z.string(),
		tickets: z.int(),
		layer: z.string(),
		map: z.string(),
	}

	export const RoundDecidedWinnerDef = eventDef('ROUND_DECIDED_WINNER', RoundDecidedBaseProps)
	export type RoundDecidedWinner = z.infer<typeof RoundDecidedWinnerDef['schema']>

	export const RoundDecidedWinnerMatcher = createLogMatcher({
		event: RoundDecidedWinnerDef,
		regex:
			/^\[([0-9.:-]+)]\[([ 0-9]*)]LogSquadGameEvents: Display: Team (-?[0-9]+), (.*) \( ?(.*?) ?\) has won the match with (-?[0-9]+) Tickets on layer (.*) \(level (.*)\)!/,
		onMatch: (args) => {
			return {
				raw: args[0],
				time: parseTimestamp(args[1]),
				chainID: args[2],
				team: parseInt(args[3]) as 1 | 2,
				unit: args[4],
				faction: args[5],
				tickets: parseInt(args[6]),
				layer: args[7],
				map: args[8],
			}
		},
	})

	export const RoundDecidedLoserDef = eventDef('ROUND_DECIDED_LOSER', RoundDecidedBaseProps)
	export type RoundDecidedLoser = z.infer<typeof RoundDecidedLoserDef['schema']>

	export const RoundDecidedLoserMatcher = createLogMatcher({
		event: RoundDecidedLoserDef,
		regex:
			/^\[([0-9.:-]+)]\[([ 0-9]*)]LogSquadGameEvents: Display: Team (-?[0-9]+), (.*) \( ?(.*?) ?\) has lost the match with (-?[0-9]+) Tickets on layer (.*) \(level (.*)\)!/,
		onMatch: (args) => {
			return {
				raw: args[0],
				time: parseTimestamp(args[1]),
				chainID: args[2],
				team: parseInt(args[3]) as 1 | 2,
				unit: args[4],
				faction: args[5],
				tickets: parseInt(args[6]),
				layer: args[7],
				map: args[8],
			}
		},
	})

	export const RoundEndedDef = eventDef('ROUND_ENDED', {
		...BaseEventProperties,
	})

	export type RoundEnded = z.infer<typeof RoundEndedDef['schema']>

	export const RoundEndedMatcher = createLogMatcher({
		event: RoundEndedDef,
		regex: /^\[([0-9.:-]+)]\[([ 0-9]*)]LogGameState: Match State Changed from InProgress to WaitingPostMatch/,
		onMatch: (args) => {
			return {
				raw: args[0],
				time: parseTimestamp(args[1]),
				chainID: args[2],
			}
		},
	})

	export const AdminEndedMatchDef = eventDef('ADMIN_ENDED_MATCH', {
		...BaseEventProperties,
		source: ActionSourceSchema,
	})

	export type AdminEndedMatch = z.infer<typeof AdminEndedMatchDef['schema']>
	export const AdminEndedMatchMatcher = createLogMatcher({
		event: AdminEndedMatchDef,
		regex: new RegExp(
			String.raw`^\[([0-9.:-]+)]\[([ 0-9]*)]LogSquad: ADMIN COMMAND: Match ended from ${ACTION_SOURCE_REGEX_SRC}`,
		),
		onMatch: (args) => {
			return {
				raw: args[0],
				time: parseTimestamp(args[1]),
				chainID: args[2],
				source: parseActionSource(args),
			}
		},
	})

	export const PlayerConnectedDef = eventDef('PLAYER_CONNECTED', {
		...BaseEventProperties,
		playerIds: PlayerIds.IdFields('eos', 'playerController'),
		ip: z.union([z.ipv4(), z.ipv6()]),
	})
	export type PlayerConnected = z.infer<typeof PlayerConnectedDef['schema']>
	export const PlayerConnectedMatcher = createLogMatcher({
		event: PlayerConnectedDef,
		regex:
			/^\[([0-9.:-]+)]\[([ 0-9]*)]LogSquad: PostLogin: NewPlayer: BP_PlayerController\w*_C .+PersistentLevel\.([^\s]+) \(IP: ([\d.]+) \| Online IDs:([^)|]+)\)/,
		onMatch: (args) => {
			return {
				raw: args[0],
				time: parseTimestamp(args[1]),
				chainID: args[2],
				playerIds: PlayerIds.parse({ idsStr: args[5], playerController: args[3] }),
				ip: args[4],
			}
		},
	})

	export const PlayerDisconnectedDef = eventDef('PLAYER_DISCONNECTED', {
		...BaseEventProperties,
		playerIds: PlayerIds.IdFields('eos', 'playerController'),
		ip: z.union([z.ipv4(), z.ipv6()]),
	})
	export type PlayerDisconnected = z.infer<typeof PlayerDisconnectedDef['schema']>
	// Parses UNetDriver::RemoveClientConnection rather than the earlier "Sending CloseBunch" line: CloseBunch
	// fires before the disconnect fully settles, so e.g. a wounded player's Die() lands *after* it, which
	// misorders death handling relative to the disconnect. RemoveClientConnection is the last line of the
	// disconnect sequence. Restricted to GameNetDriver connections: the same line is also emitted for
	// BeaconNetDriver (join-queue) connections closing, which carry the player's EOS but PC: NULL and are not
	// real game disconnects (~60% of raw RemoveClientConnection lines on a busy server are beacon closes).
	export const PlayerDisconnectedMatcher = createLogMatcher({
		event: PlayerDisconnectedDef,
		regex:
			/^\[([0-9.:-]+)]\[([ 0-9]*)]LogNet: UNetDriver::RemoveClientConnection - Removed address ([\d.]+):[\d]+ from MappedClientConnections for: \[UNetConnection\] RemoteAddr: [\d.]+:[\d]+, Name: \w+EOSIpNetConnection_[0-9]+, Driver: Name:GameNetDriver Def:GameNetDriver \w+NetDriver_[0-9]+, IsServer: YES, PC: ([^ ]+), Owner: [^ ]+, UniqueId: RedpointEOS:([\d\w]+)/,
		onMatch: (args) => {
			return {
				raw: args[0],
				time: parseTimestamp(args[1]),
				chainID: args[2],
				ip: args[3],
				playerIds: PlayerIds.parse({
					playerController: args[4],
					eos: args[5],
				}),
			}
		},
	})

	export const PlayerJoinSuccededDef = eventDef('PLAYER_JOIN_SUCCEEDED', {
		...BaseEventProperties,
		player: PlayerIds.IdFields('usernameNoTag'),
	})

	export type PlayerJoinSucceeded = z.infer<typeof PlayerJoinSuccededDef['schema']>
	export const PlayerJoinSuccededMatcher = createLogMatcher({
		event: PlayerJoinSuccededDef,
		regex: /^\[([0-9.:-]+)]\[([ 0-9]*)]LogNet: Join succeeded: (.+)/,
		onMatch: (args) => {
			return {
				raw: args[0],
				time: parseTimestamp(args[1]),
				chainID: args[2],
				player: PlayerIds.parse({ usernameNoTag: args[3] }),
			}
		},
	})

	export const PlayerDiedDef = eventDef('PLAYER_DIED', {
		...BaseEventProperties,
		damage: z.number(),
		// null when the log records `caused by nullptr` (the killing weapon actor was already gone), even though the attacker is known
		weapon: z.string().nullable(),
		attackerIds: PlayerIds.IdFields('eos', 'playerController'),
		victimIds: PlayerIds.IdFields('username'),
	})

	export type PlayerDied = z.infer<typeof PlayerDiedDef['schema']>
	export const PlayerDiedMatcher = createLogMatcher({
		event: PlayerDiedDef,
		regex:
			/^\[([0-9.:-]+)]\[([ 0-9]*)]LogSquadTrace: \[DedicatedServer](?:ASQSoldier::)?Die\(\): Player:(.+) KillingDamage=(?:-)*([0-9.]+) from ([A-z_0-9]+) \(Online IDs:([^)|]+)\| Contoller ID: ([\w\d]+)\) caused by (\S+)/,
		onMatch: (args) => {
			// Bail if invalid IDs
			if (args[6].includes('INVALID')) return null

			return {
				raw: args[0],
				time: parseTimestamp(args[1]),
				chainID: args[2],
				victimIds: PlayerIds.parse({ username: args[3] }),
				damage: parseFloat(args[4]),
				attackerPlayerController: args[5],
				attackerIds: PlayerIds.parse({ idsStr: args[6], playerController: args[7] }),
				weapon: normalizeWeapon(args[8]),
			}
		},
	})

	export const PlayerWoundedDef = eventDef('PLAYER_WOUNDED', {
		...BaseEventProperties,
		damage: z.number(),
		// null when the log records `caused by nullptr` (the wounding weapon actor was already gone), even though the attacker is known
		weapon: z.string().nullable(),
		attackerIds: PlayerIds.IdFields('eos', 'playerController'),
		victimIds: PlayerIds.IdFields('username'),
	})
	export type PlayerWounded = z.infer<typeof PlayerWoundedDef['schema']>
	export const PlayerWoundedMatcher = createLogMatcher({
		event: PlayerWoundedDef,
		regex:
			/^\[([0-9.:-]+)]\[([ 0-9]*)]LogSquadTrace: \[DedicatedServer](?:ASQSoldier::)?Wound\(\): Player:(.+) KillingDamage=(?:-)*([0-9.]+) from ([A-z_0-9]+) \(Online IDs:([^)|]+)\| Controller ID: ([\w\d]+)\) caused by (\S+)/,
		onMatch: (args) => {
			// Bail if invalid IDs
			if (args[6].includes('INVALID')) return null

			return {
				raw: args[0],
				time: parseTimestamp(args[1]),
				chainID: args[2],
				victimIds: PlayerIds.parse({ username: args[3] }),
				damage: parseFloat(args[4]),
				attackerIds: PlayerIds.parse({ idsStr: args[6], playerController: args[7] }),
				weapon: normalizeWeapon(args[8]),
			}
		},
	})

	export const AdminBroadcastDef = eventDef('ADMIN_BROADCAST', {
		...BaseEventProperties,
		message: z.string(),
		source: ActionSourceSchema.optional(),

		// deprecated
		from: z.union([z.literal('RCON'), z.literal('unknown'), PlayerIds.Schema]).optional(),
	})

	export type AdminBroadcast = z.infer<typeof AdminBroadcastDef['schema']>
	export const AdminBroadcastMatcher = createLogMatcher({
		event: AdminBroadcastDef,
		regex: new RegExp(
			String.raw`^\[([0-9.:-]+)]\[([ 0-9]*)]LogSquad: ADMIN COMMAND: Message broadcasted <([\s\S]+)> from ${ACTION_SOURCE_REGEX_SRC}`,
		),
		onMatch: (args) => {
			const source = parseActionSource(args)
			return {
				raw: args[0],
				time: parseTimestamp(args[1]),
				chainID: args[2],
				message: args[3],
				source,
			}
		},
	})

	export const MapSetDef = eventDef('MAP_SET', {
		...BaseEventProperties,
		nextLayer: z.string().trim(),
		nextFactions: z.string().trim().optional(),
		source: ActionSourceSchema,
	})

	export type MapSet = z.infer<typeof MapSetDef['schema']>
	export const MapSetMatcher = createLogMatcher({
		event: MapSetDef,
		regex: new RegExp(
			String
				.raw`^\[([0-9.:-]+)]\[([ 0-9]*)]LogSquad: ADMIN COMMAND: Set next layer to ([^\s]+)(?: ([^[]+))? from ${ACTION_SOURCE_REGEX_SRC}`,
		),
		onMatch: (args) => {
			return {
				raw: args[0],
				time: parseTimestamp(args[1]),
				chainID: args[2],
				nextLayer: args[3],
				nextFactions: args[4]?.trim(),
				source: parseActionSource(args),
			}
		},
	})

	export const LayerChangedDef = eventDef('LAYER_CHANGED', {
		...BaseEventProperties,
		layer: z.string().trim(),
		source: ActionSourceSchema,
	})

	export type LayerChanged = z.infer<typeof LayerChangedDef['schema']>
	export const LayerChangedMatcher = createLogMatcher({
		event: LayerChangedDef,
		regex: new RegExp(String
			.raw`^\[([0-9.:-]+)]\[([ 0-9]*)]LogSquad: ADMIN COMMAND: Change layer to( [^\s]+)( [^\s]+)??( [^\s]+)? ?from ${ACTION_SOURCE_REGEX_SRC}`),
		onMatch: (args) => {
			const source = parseActionSource(args)
			return {
				raw: args[0],
				time: parseTimestamp(args[1]),
				chainID: args[2],
				layer: `${args[3]} ${args[4] ?? ''} ${args[5] ?? ''}`.trim().replace(/\s+/g, ' '),
				source,
			}
		},
	})

	export const KickingPlayerDef = eventDef('KICKING_PLAYER', {
		...BaseEventProperties,
		reason: z.string().trim(),
		playerIds: PlayerIds.IdFields('username'),
	})

	export type KickingPlayer = z.infer<typeof KickingPlayerDef['schema']>
	export const KickingPlayerMatcher = createLogMatcher({
		event: KickingPlayerDef,
		regex: /^\[([0-9.:-]+)]\[([ 0-9]*)]LogOnlineGame: Display: Kicking player:\s+(.+?)\s+;\s+Reason\s+=\s+(.+)/,
		onMatch: (args) => {
			return {
				raw: args[0],
				time: parseTimestamp(args[1]),
				chainID: args[2],
				playerIds: PlayerIds.parse({ username: args[3] }),
				reason: args[4],
			}
		},
	})

	export const PlayerKickedDef = eventDef('PLAYER_KICKED', {
		...BaseEventProperties,
		playerIds: PlayerIds.IdFields('username', 'eos'),
		source: ActionSourceSchema,
	})

	export type PlayerKicked = z.infer<typeof PlayerKickedDef['schema']>
	export const PlayerKickedMatcher = createLogMatcher({
		event: PlayerKickedDef,
		regex: new RegExp(
			String
				.raw`^\[([0-9.:-]+)]\[([ 0-9]*)]LogSquad: ADMIN COMMAND: Kicked player \d+\. \[Online IDs=([^\]]+)\]\s+(.+) from ${ACTION_SOURCE_REGEX_SRC}`,
		),
		onMatch: (args) => {
			return {
				raw: args[0],
				time: parseTimestamp(args[1]),
				chainID: args[2],
				playerIds: PlayerIds.parse({ username: args[4], idsStr: args[3] }),
				source: parseActionSource(args),
			}
		},
	})

	export const PlayerAddedToTeamDef = eventDef('PLAYER_ADDED_TO_TEAM', {
		...BaseEventProperties,
		playerIds: PlayerIds.IdFields('username'),
		teamId: TeamIdSchema,
	})

	export type PlayerAddedToTeam = z.infer<typeof PlayerAddedToTeamDef['schema']>
	export const PlayerAddedToTeamMatcher = createLogMatcher({
		event: PlayerAddedToTeamDef,
		regex: /^\[([0-9.:-]+)]\[([ 0-9]*)]LogSquad: Player\s+(.+) has been added to Team ([12])/,
		onMatch: (args) => ({
			raw: args[0],
			time: parseTimestamp(args[1]),
			chainID: args[2],
			playerIds: PlayerIds.parse({ username: args[3] }),
			teamId: parseInt(args[4]) as 1 | 2,
		}),
	})

	export const PlayerRestartedDef = eventDef('PLAYER_RESTARTED', {
		...BaseEventProperties,
		playerController: z.string(),
		deployRole: z.string(),
	})

	export type PlayerRestarted = z.infer<typeof PlayerRestartedDef['schema']>
	export const PlayerRestartedMatcher = createLogMatcher({
		event: PlayerRestartedDef,
		regex: /^\[([0-9.:-]+)]\[([ 0-9]*)]LogSquadTrace: \[DedicatedServer]RestartPlayer\(\): On Server PC=(\S+) Spawn=\S+ DeployRole=(\S+)/,
		onMatch: (args) => ({
			raw: args[0],
			time: parseTimestamp(args[1]),
			chainID: args[2],
			playerController: args[3],
			deployRole: args[4],
		}),
	})

	// AdminForceTeamChange. The log doesn't state the destination team (it's a swap), so the handler derives it.
	export const ForcedTeamChangeDef = eventDef('ADMIN_FORCED_TEAM_CHANGE', {
		...BaseEventProperties,
		playerIds: PlayerIds.IdFields('username', 'eos'),
		source: ActionSourceSchema,
	})
	export type ForcedTeamChange = z.infer<typeof ForcedTeamChangeDef['schema']>
	export const ForcedTeamChangeMatcher = createLogMatcher({
		event: ForcedTeamChangeDef,
		regex: new RegExp(
			String
				.raw`^\[([0-9.:-]+)]\[([ 0-9]*)]LogSquad: ADMIN COMMAND: Forced team change for player \d+\. \[Online IDs=\s*([^\]]+)\]\s+(.+?) from ${ACTION_SOURCE_REGEX_SRC}`,
		),
		onMatch: (args) => {
			return {
				raw: args[0],
				time: parseTimestamp(args[1]),
				chainID: args[2],
				playerIds: PlayerIds.parse({ username: args[4], idsStr: args[3] }),
				source: parseActionSource(args),
			}
		},
	})

	// AdminDisbandSquad
	export const SquadDisbandedDef = eventDef('ADMIN_DISBANDED_SQUAD', {
		...BaseEventProperties,
		squadId: z.number(),
		teamId: TeamIdSchema,
		squadName: z.string(),
		source: ActionSourceSchema,
	})
	export type SquadDisbanded = z.infer<typeof SquadDisbandedDef['schema']>
	export const SquadDisbandedMatcher = createLogMatcher({
		event: SquadDisbandedDef,
		regex: new RegExp(
			String
				.raw`^\[([0-9.:-]+)]\[([ 0-9]*)]LogSquad: ADMIN COMMAND: Remote admin disbanded squad (\d+) on team (\d+), named "(.*)" from ${ACTION_SOURCE_REGEX_SRC}`,
		),
		onMatch: (args) => {
			return {
				raw: args[0],
				time: parseTimestamp(args[1]),
				chainID: args[2],
				squadId: Number(args[3]),
				teamId: parseInt(args[4]) as 1 | 2,
				squadName: args[5],
				source: parseActionSource(args),
			}
		},
	})

	// AdminRemovePlayerFromSquad. The log only carries the display name (no online ids), so the handler resolves by username.
	export const PlayerRemovedFromSquadDef = eventDef('ADMIN_REMOVED_FROM_SQUAD', {
		...BaseEventProperties,
		playerIds: PlayerIds.IdFields('username'),
		source: ActionSourceSchema,
	})
	export type PlayerRemovedFromSquad = z.infer<typeof PlayerRemovedFromSquadDef['schema']>
	export const PlayerRemovedFromSquadMatcher = createLogMatcher({
		event: PlayerRemovedFromSquadDef,
		regex: new RegExp(
			String
				.raw`^\[([0-9.:-]+)]\[([ 0-9]*)]LogSquad: ADMIN COMMAND: Player\s+(.+?) was removed from squad from ${ACTION_SOURCE_REGEX_SRC}`,
		),
		onMatch: (args) => {
			return {
				raw: args[0],
				time: parseTimestamp(args[1]),
				chainID: args[2],
				playerIds: PlayerIds.parse({ username: args[3] }),
				source: parseActionSource(args),
			}
		},
	})

	const UnknownEventDef = eventDef('UNKNOWN', {
		...BaseEventProperties,
	})
	export type UnknownEvent = z.infer<typeof UnknownEventDef['schema']>
	export const UnknownEventMatcher = createLogMatcher({
		event: UnknownEventDef,
		regex: /^\[([0-9.:-]+)]\[([ 0-9]*)](.*)$/s,
		onMatch: (m) => ({
			raw: m[0],
			time: parseTimestamp(m[1]),
			chainID: m[2].trim(),
		}),
	})

	export type ToEventMap<E extends SquadLogEvent> = {
		[e in E['type']]: (evt: Extract<E, { type: e }>) => void
	}

	export const EventMatchers = [
		NewGameEventMatcher,
		RoundWinnerEventMatcher,
		RoundDecidedWinnerMatcher,
		RoundDecidedLoserMatcher,
		RoundEndedMatcher,
		AdminEndedMatchMatcher,
		PlayerConnectedMatcher,
		PlayerDisconnectedMatcher,
		PlayerJoinSuccededMatcher,
		PlayerDiedMatcher,
		PlayerWoundedMatcher,
		AdminBroadcastMatcher,
		LayerChangedMatcher,
		MapSetMatcher,
		KickingPlayerMatcher,
		PlayerKickedMatcher,
		PlayerAddedToTeamMatcher,
		PlayerRestartedMatcher,
		ForcedTeamChangeMatcher,
		SquadDisbandedMatcher,
		PlayerRemovedFromSquadMatcher,
		UnknownEventMatcher,
	] as const

	type LogEventType = (typeof EventMatchers)[number]['event']['type']
	export const LOG_EVENT_TYPES = z.enum(EventMatchers.map(m => m.event.type) as [LogEventType, ...LogEventType[]])

	export function isLogEvent<T extends { type: string }>(event: T): event is Extract<T, { type: LogEventType }> {
		return (LOG_EVENT_TYPES.options as string[]).includes(event.type)
	}

	export type Event =
		| RoundEnded
		| RoundDecidedWinner
		| RoundDecidedLoser
		| AdminEndedMatch
		| RoundTeamOutcome
		| NewGame
		| PlayerConnected
		| PlayerDisconnected
		| PlayerJoinSucceeded
		| PlayerDied
		| PlayerWounded
		| AdminBroadcast
		| MapSet
		| LayerChanged
		| KickingPlayer
		| PlayerKicked
		| PlayerAddedToTeam
		| PlayerRestarted
		| ForcedTeamChange
		| SquadDisbanded
		| PlayerRemovedFromSquad
		| UnknownEvent

	function parseTimestamp(raw: string) {
		const date = dateFns.parse(
			raw + 'Z',
			'yyyy.MM.dd-HH.mm.ss:SSSX',
			new Date(),
		)
		return date.getTime()
	}

	// Normalizes the `caused by <token>` weapon from Die()/Wound() lines.
	// `nullptr` (weapon actor already destroyed) -> null; blueprint instances `<Name>_C` / `<Name>_C_<instanceId>` -> `<Name>`; anything else kept verbatim.
	function normalizeWeapon(token: string): string | null {
		if (token === 'nullptr') return null
		const match = token.match(/^(.+)_C(?:_\d+)?$/)
		return match ? match[1] : token
	}

	type ChainItemOptions = { primary?: boolean; optional?: boolean }
	const CHAIN_ITEM_OPTIONS_PROPS = ['primary', 'optional'] as const
	type ChainItem = { event: EventSchema } & ChainItemOptions
	type ChainDef = (EventSchema | ChainItem)[]

	const LOG_CHAINS = {
		PLAYER_CONNECTED_CHAIN: [
			{ event: PlayerConnectedDef, primary: true },
			PlayerJoinSuccededDef,
			{ event: PlayerAddedToTeamDef, optional: true },
		],
		ROUND_ENDED_CHAIN: [
			{ event: RoundEndedDef, primary: true },
			{ event: RoundDecidedWinnerDef, optional: true },
			{ event: RoundDecidedLoserDef, optional: true },
			{ event: AdminEndedMatchDef, optional: true },
			{ event: LayerChangedDef, optional: true },
		],
		PLAYER_KICKED_CHAIN: [{ event: KickingPlayerDef, primary: true }, PlayerKickedDef],
	}

	type GetEventSchema<T> = T extends EventSchema ? T : T extends { event: infer E extends EventSchema } ? E : never

	type ChainEvents<Chain extends ChainDef> =
		& { [Item in Exclude<Chain[number], { optional: true }> as GetEventSchema<Item>['type']]: z.infer<GetEventSchema<Item>['schema']> }
		& { [Item in Extract<Chain[number], { optional: true }> as GetEventSchema<Item>['type']]?: z.infer<GetEventSchema<Item>['schema']> }

	type ChainEvent<K extends keyof typeof LOG_CHAINS> = { type: K; events: ChainEvents<(typeof LOG_CHAINS)[K]>; time: number }
	export type AnyChainEvent = { [K in keyof typeof LOG_CHAINS]: ChainEvent<K> }[keyof typeof LOG_CHAINS]
	type ChainMemberType = GetEventSchema<(typeof LOG_CHAINS)[keyof typeof LOG_CHAINS][number]>['type']
	export type NonChainEvent = Exclude<Event, { type: ChainMemberType }>
	export type ParsedEvent = AnyChainEvent | NonChainEvent

	function getChainItemSchema(item: ChainDef[number]): EventSchema {
		return 'event' in item ? item.event : item
	}

	function toChainItem(item: ChainDef[number]): ChainItem {
		if ('event' in item) return item
		return { event: item } as ChainItem
	}

	function chainEventKeys(def: ChainDef): string[] {
		return def.map(getChainItemSchema).map(item => item.type)
	}

	function validateChainEvent(event: AnyChainEvent, chainDef: ChainDef): Error[] {
		const errors: Error[] = []
		for (const _item of chainDef) {
			const item = toChainItem(_item)
			if (!item.optional && !(item.event.type in event.events)) {
				errors.push(new Error(`Missing required event: ${item.event.type}`))
			}
		}
		return errors
	}

	type ChainMembership = { chainKey: keyof typeof LOG_CHAINS } & ChainItemOptions
	const EVENT_CHAIN_MAP: Map<string, ChainMembership> = new Map()
	for (const chainKey of Object.keys(LOG_CHAINS) as (keyof typeof LOG_CHAINS)[]) {
		const chainDef = LOG_CHAINS[chainKey]
		for (let i = 0; i < chainDef.length; i++) {
			const item = toChainItem(chainDef[i])
			EVENT_CHAIN_MAP.set(item.event.type, { chainKey, ...Obj.selectProps(item, CHAIN_ITEM_OPTIONS_PROPS) })
		}
	}
}
