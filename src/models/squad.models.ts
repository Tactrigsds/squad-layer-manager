import type { ServerEventPlayerAssocType } from '$root/drizzle/enums'
import * as SchemaModels from '$root/drizzle/schema.models'
import * as Arr from '@/lib/array'
import { createLogMatcher, eventDef, matchLog } from '@/lib/log-parsing'
import type { OneToManyMap } from '@/lib/one-to-many-map'
import * as ZodUtils from '@/lib/zod'
import type * as L from '@/models/layer'
import type * as MH from '@/models/match-history.models'
import * as dateFns from 'date-fns'
import superjson from 'superjson'

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
export type ServerInfoRes = { code: 'ok'; data: ServerInfo } | RconError
export type LayerStatusRes = { code: 'ok'; data: LayersStatus } | RconError
export type LayersStatusResExt = { code: 'ok'; data: LayersStatusExt } | RconError

export const TeamIdSchema = z.union([z.literal(1), z.literal(2)])
export type TeamId = z.infer<typeof TeamIdSchema>

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
	export const Schema = IdFields('username', 'eos')

	export function getPlayerId(ids: IdQuery<'eos'>) {
		return ids.eos
	}
	export function queryFromPlayerId(id: PlayerId): IdQuery<'eos'> {
		return { eos: id }
	}

	export type IdQueryOrPlayerId = IdQuery | PlayerId
	function normalizeIdQuery(id: IdQueryOrPlayerId): IdQuery {
		return typeof id === 'string' ? queryFromPlayerId(id) : id
	}

	export type Type = z.infer<typeof Schema>

	// in order of lookup preference
	const LOOKUP_PROPS = ['eos', 'steam', 'epic', 'playerController', 'username'] as const

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
		if (opts.username && opts.usernameNoTag) {
			;[ids.usernameNoTag, ids.tag] = opts.username.split(/\s+/, 2)
			if (!ids.tag) throw new Error('No tag-denoting whitespace in parsed username ' + opts.username)
		}
		return {
			...ids,
			usernameNoTag: opts.usernameNoTag?.trim(),
			username: opts.username?.trim(),
			playerController: opts.playerController?.trim(),
			eos: opts.eos?.trim() ?? ids.eos,
		}
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
			for (const prop of LOOKUP_PROPS) {
				if (!searchId[prop]) continue
				for (const item of elts as T[]) {
					if (cb(item)[prop] === searchId[prop]) return item
				}
			}
			return undefined
		}

		const searchId = normalizeIdQuery(cbOrId!)
		for (const prop of LOOKUP_PROPS) {
			if (!searchId[prop]) continue
			for (const item of elts as Type[]) {
				if (item[prop] === searchId[prop]) return item
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
			for (const prop of LOOKUP_PROPS) {
				if (!searchId[prop]) continue
				for (let i = 0; i < (elts as T[]).length; i++) {
					if (cb((elts as T[])[i])[prop] === searchId[prop]) return i
				}
			}
			return -1
		}

		const searchId = normalizeIdQuery(cbOrId!)
		for (const prop of LOOKUP_PROPS) {
			if (!searchId[prop]) continue
			for (let i = 0; i < (elts as Type[]).length; i++) {
				if ((elts as Type[])[i][prop] === searchId[prop]) return i
			}
		}
		return -1
	}

	// returns a version of the element with merged ids
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
			const existing = find(elts as T[], cb, searchId)
			if (existing) {
				const existingIds = cb(existing)
				for (const prop of UNIQUE_PROPS) {
					if (!searchId[prop]) continue
					if (existingIds[prop] !== searchId[prop]) {
						console.error(`ID conflict: ${prop}=${searchId[prop]} vs ${existingIds[prop]}. keeping ${existingIds[prop]}`)
						return
					}
				}
				Object.assign(existingIds, searchId)
				Object.assign(existing, newItem)
				return existing
			}
			Object.assign(cb(newItem), searchId)
			;(elts as T[]).push(newItem)
			return newItem
		}

		// Original overload: upsert(idList: Type[], id: Type): Type
		const searchId = cbOrId as Type
		const existing = find(elts as Type[], searchId)
		if (existing) {
			for (const prop of UNIQUE_PROPS) {
				if (!searchId[prop]) continue
				if (existing[prop] !== searchId[prop]) {
					console.error(`ID conflict: ${prop}=${searchId[prop]} vs ${existing[prop]}. keeping ${existing[prop]}`)
					return existing
				}
			}
			Object.assign(existing, searchId)
			return existing
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
		return false
	}

	const ID_MATCHER = /\s*(?<name>[^\s:]+)\s*:\s*(?<id>[^\s]+)/g

	function* matchAllIds(idsStr: string) {
		for (const match of idsStr.matchAll(ID_MATCHER)) {
			yield { key: match.groups!.name.toLowerCase(), value: match.groups!.id }
		}
	}

	// gets generic id for use in commands(ex warns)
	export function resolvePlayerId(ids: Type): string {
		return (ids.eos?.toString() ?? ids.eos?.toString())!
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
export type PlayerAssoc<Type extends SchemaModels.ServerEventPlayerAssocType = 'player', Value = PlayerId> = { [key in Type]: Value }
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

export type PlayerListRes = { code: 'ok'; players: Player[] } | RconError
export type SquadListRes = { code: 'ok'; squads: Squad[] } | RconError
export type Teams<P = Player> = { players: P[]; squads: Squad[] }
export type TeamsRes<P = Player> = { code: 'ok' } & Teams<P> | RconError

export namespace Squads {
	// identifies a squad across teams
	export type Key = { squadId: SquadId; teamId: TeamId }
	export type PartialKey = { squadId: SquadId | null; teamId: TeamId | null }

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
export const AdminListSourceSchema = z.object({
	type: z.enum(['remote', 'local', 'ftp']),
	source: z.string(),
})
export type AdminListSource = z.infer<typeof AdminListSourceSchema>
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
	| { type: 'ChatSquad'; teamId: TeamId; squadId: SquadId }

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

export namespace Events {
	export type Base = {
		id: number
		time: number
		matchId: number
	}

	export type EventMeta = {
		playerAssocs: ServerEventPlayerAssocType[]
	}

	function meta<T extends ServerEventPlayerAssocType[]>(playerAssocs?: T) {
		return { playerAssocs: playerAssocs ?? [] } satisfies EventMeta
	}

	export type MapSet = {
		type: 'MAP_SET'
		layerId: L.LayerId
	} & Base
	export const MAP_SET_META = meta()

	export type NewGame = {
		type: 'NEW_GAME'
		source: 'slm-started' | 'rcon-reconnected' | 'new-game-detected'
		layerId: L.LayerId
		state: Teams
	} & Base
	export const NEW_GAME_META = meta()

	export type Reset = {
		type: 'RESET'
		source: 'slm-started' | 'rcon-reconnected'
		state: Teams
	} & Base

	export const RESET_META = meta()

	export type RconConnected = {
		type: 'RCON_CONNECTED'
		reconnected: boolean
	} & Base
	export const RCON_CONNECTED_META = meta()

	export type RconDisconnected = {
		type: 'RCON_DISCONNECTED'
	} & Base
	export const RCON_DISCONNECTED_META = meta()

	export type RoundEnded = {
		type: 'ROUND_ENDED'
	} & Base
	export const ROUND_ENDED_META = meta()

	export type PlayerConnected<P = Player> =
		& {
			type: 'PLAYER_CONNECTED'
		}
		& PlayerAssoc<'player', P>
		& Base
	export const PLAYER_CONNECTED_META = meta(['player'])
	if (PLAYER_CONNECTED_META.playerAssocs.length !== 1) {
		throw new Error('Multiple associations for PLAYER_CONNECTED, we need to update how we save these events')
	}

	export type PlayerDisconnected<P = PlayerId> =
		& {
			type: 'PLAYER_DISCONNECTED'
		}
		& PlayerAssoc<'player', P>
		& Base
	export const PLAYER_DISCONNECTED_META = meta(['player'])

	export type SquadCreated = {
		type: 'SQUAD_CREATED'
		squad: Squad
	} & Base

	export const SQUAD_CREATED_META = meta()

	export type ChatMessage<P = PlayerId> =
		& {
			type: 'CHAT_MESSAGE'
			message: string
			// has indirect SquadAssoc through channel if ChatSquad
			channel: ChatChannel
		}
		& PlayerAssoc<'player', P>
		& Base
	export const CHAT_MESSAGE_META = meta(['player'])

	export type AdminBroadcast = {
		type: 'ADMIN_BROADCAST'
		message: string
		from: LogEvents.AdminBroadcast['from']
	} & Base
	export const ADMIN_BROADCAST_META = meta()

	// synthetic events from player state
	export type PlayerDetailsChanged<P = PlayerId> =
		& {
			type: 'PLAYER_DETAILS_CHANGED'
			details: Pick<Player, (typeof PLAYER_DETAILS)[number]>
		}
		& PlayerAssoc<'player', P>
		& Base
	export const PLAYER_DETAILS_CHANGED_META = meta(['player'])

	export type PlayerChangedTeam<P = PlayerId> =
		& {
			type: 'PLAYER_CHANGED_TEAM'
			newTeamId: TeamId | null
		}
		& PlayerAssoc<'player', P>
		& Base
	export const PLAYER_CHANGED_TEAM_META = meta(['player'])

	// can originate if the player manually leaves the squad, or is removed for some other reason
	export type PlayerLeftSquad<P = PlayerId> =
		& {
			type: 'PLAYER_LEFT_SQUAD'
			squadId: SquadId
			teamId: TeamId
		}
		& PlayerAssoc<'player', P>
		& Base
	export const PLAYER_LEFT_SQUAD_META = meta(['player'])

	// this event is redundant in terms of state transfer, as it could be inferred as the last player leaving a particular squad
	export type SquadDisbanded = {
		type: 'SQUAD_DISBANDED'
		squadId: SquadId
		teamId: TeamId
	} & Base
	export const SQUAD_DISBANDED_META = meta()

	export type SquadDetailsChanged = {
		type: 'SQUAD_DETAILS_CHANGED'
		squadId: SquadId
		teamId: TeamId
		details: {
			locked?: boolean
			squadName?: string
		}
	} & Base
	export const SQUAD_DETAILS_CHANGED_META = meta()

	/**
	 * Player joined pre-existing squad
	 */
	export type PlayerJoinedSquad<P = PlayerId> =
		& {
			type: 'PLAYER_JOINED_SQUAD'
			squadId: SquadId
			teamId: TeamId
		}
		& PlayerAssoc<'player', P>
		& Base
	export const PLAYER_JOINED_SQUAD_META = meta(['player'])

	export type PlayerPromotedToLeader<P = PlayerId> =
		& {
			type: 'PLAYER_PROMOTED_TO_LEADER'
			squadId: SquadId
			teamId: TeamId
		}
		& PlayerAssoc<'player', P>
		& Base
	export const PLAYER_PROMOTED_TO_LEADER_META = meta(['player'])

	export type PlayerKicked<P = PlayerId> =
		& {
			type: 'PLAYER_KICKED'
			reason?: string
		}
		& PlayerAssoc<'player', P>
		& Base
	export const PLAYER_KICKED_META = meta(['player'])

	export type PossessedAdminCamera<P = PlayerId> =
		& {
			type: 'POSSESSED_ADMIN_CAMERA'
		}
		& PlayerAssoc<'player', P>
		& Base
	export const POSSESSED_ADMIN_CAMERA_META = meta(['player'])

	export type UnpossessedAdminCamera<P = PlayerId> =
		& {
			type: 'UNPOSSESSED_ADMIN_CAMERA'
		}
		& PlayerAssoc<'player', P>
		& Base
	export const UNPOSSESSED_ADMIN_CAMERA_META = meta(['player'])

	export type PlayerBanned<P = PlayerId> = { type: 'PLAYER_BANNED'; interval: string } & PlayerAssoc<'player', P> & Base
	export const PLAYER_BANNED_META = meta(['player'])

	export type PlayerWarned<P = PlayerId> = { type: 'PLAYER_WARNED'; reason: string } & PlayerAssoc<'player', P> & Base
	export const PLAYER_WARNED_META = meta(['player'])

	export type PlayerDied<P = PlayerId> =
		& {
			type: 'PLAYER_DIED'
			damage: number
			weapon: string
			variant: PlayerWoundedOrDiedVariant
		}
		& PlayerAssoc<'victim', P>
		& PlayerAssoc<'attacker', P>
		& Base
	export const PLAYER_DIED_META = meta(['victim', 'attacker'])

	export type PlayerWoundedOrDiedVariant = 'normal' | 'suicide' | 'teamkill'

	export type PlayerWounded<P = PlayerId> =
		& {
			type: 'PLAYER_WOUNDED'
			damage: number
			weapon: string
			variant: PlayerWoundedOrDiedVariant
		}
		& PlayerAssoc<'victim', P>
		& PlayerAssoc<'attacker', P>
		& Base
	export const PLAYER_WOUNDED_META = meta(['victim', 'attacker'])

	export type Event<P = PlayerId> =
		| MapSet
		| NewGame
		| Reset
		| RconConnected
		| RconDisconnected
		| RoundEnded
		| PlayerConnected<Player>
		| PlayerDisconnected<P>
		| SquadCreated
		| ChatMessage<P>
		| AdminBroadcast
		// from rcon
		| PossessedAdminCamera<P>
		| UnpossessedAdminCamera<P>
		| PlayerKicked<P>
		| PlayerBanned<P>
		| PlayerWarned<P>
		| PlayerDied<P>
		| PlayerWounded<P>
		// synthetic
		| PlayerDetailsChanged<P>
		| PlayerChangedTeam<P>
		| PlayerLeftSquad<P>
		| SquadDisbanded
		| SquadDetailsChanged
		| PlayerJoinedSquad<P>
		| PlayerPromotedToLeader<P>

	export const EVENT_META = {
		MAP_SET: MAP_SET_META,
		NEW_GAME: NEW_GAME_META,
		RESET: RESET_META,
		RCON_CONNECTED: RCON_CONNECTED_META,
		RCON_DISCONNECTED: RCON_DISCONNECTED_META,
		ROUND_ENDED: ROUND_ENDED_META,
		PLAYER_CONNECTED: PLAYER_CONNECTED_META,
		PLAYER_DISCONNECTED: PLAYER_DISCONNECTED_META,
		SQUAD_CREATED: SQUAD_CREATED_META,
		CHAT_MESSAGE: CHAT_MESSAGE_META,
		ADMIN_BROADCAST: ADMIN_BROADCAST_META,
		PLAYER_DETAILS_CHANGED: PLAYER_DETAILS_CHANGED_META,
		PLAYER_CHANGED_TEAM: PLAYER_CHANGED_TEAM_META,
		PLAYER_LEFT_SQUAD: PLAYER_LEFT_SQUAD_META,
		SQUAD_DISBANDED: SQUAD_DISBANDED_META,
		SQUAD_DETAILS_CHANGED: SQUAD_DETAILS_CHANGED_META,
		PLAYER_JOINED_SQUAD: PLAYER_JOINED_SQUAD_META,
		PLAYER_PROMOTED_TO_LEADER: PLAYER_PROMOTED_TO_LEADER_META,
		PLAYER_KICKED: PLAYER_KICKED_META,
		POSSESSED_ADMIN_CAMERA: POSSESSED_ADMIN_CAMERA_META,
		UNPOSSESSED_ADMIN_CAMERA: UNPOSSESSED_ADMIN_CAMERA_META,
		PLAYER_BANNED: PLAYER_BANNED_META,
		PLAYER_WARNED: PLAYER_WARNED_META,
		PLAYER_DIED: PLAYER_DIED_META,
		PLAYER_WOUNDED: PLAYER_WOUNDED_META,
	} satisfies Record<Event['type'], EventMeta>

	// TODO Zod?
	export function fromEventRow(row: SchemaModels.ServerEvent): Event {
		return {
			...(superjson.deserialize(row.data as any, { inPlace: true }) as any),
			id: row.id,
			type: row.type,
			time: row.time.getTime(),
			matchId: row.matchId,
		}
	}

	export function* iterAssocPlayerIds(event: Event<PlayerId | Player>) {
		const meta = Events.EVENT_META[event.type]
		if (event.type === 'NEW_GAME' || event.type === 'RESET') {
			for (const player of event.state.players) {
				yield [SchemaModels.SERVER_EVENT_PLAYER_ASSOC_TYPE.enum['game-participant'], PlayerIds.getPlayerId(player.ids)] as const
			}
			return
		}

		for (const prop of meta.playerAssocs) {
			let playerId: PlayerId
			// @ts-expect-error  idgaf
			const player = event[prop] as Player | PlayerId
			if (!player) return
			if (typeof player === 'string') playerId = player
			else playerId = PlayerIds.getPlayerId(player.ids)
			yield [SchemaModels.SERVER_EVENT_PLAYER_ASSOC_TYPE.enum['player'], playerId] as const
		}
	}

	export function* iterAssocPlayers(event: Event<Player>): Generator<[SchemaModels.ServerEventPlayerAssocType, Player]> {
		const meta = Events.EVENT_META[event.type]
		if (event.type === 'NEW_GAME' || event.type === 'RESET') {
			for (const player of event.state.players) {
				yield [SchemaModels.SERVER_EVENT_PLAYER_ASSOC_TYPE.enum['game-participant'], player] as const
			}
			return
		}

		for (const prop of meta.playerAssocs) {
			// @ts-expect-error  idgaf
			const player = event[prop] as Player | undefined
			if (!player) continue
			yield [SchemaModels.SERVER_EVENT_PLAYER_ASSOC_TYPE.enum[prop], player] as const
		}
	}
}

export namespace RconEvents {
	const ChatMessageSchema = eventDef('CHAT_MESSAGE', {
		time: z.number(),
		channelType: CHAT_CHANNEL_TYPE,
		message: z.string(),
		playerIds: PlayerIds.Schema,
	})
	export type ChatMessage = z.infer<typeof ChatMessageSchema['schema']>

	export const ChatMessageMatcher = createLogMatcher({
		event: ChatMessageSchema,
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

	const PlayerWarnedSchema = eventDef('PLAYER_WARNED', {
		time: z.number(),
		reason: z.string(),
		playerIds: PlayerIds.IdFields('username'),
	})
	export type PlayerWarned = z.infer<typeof PlayerWarnedSchema['schema']>

	export const PlayerWarnedMatcher = createLogMatcher({
		event: PlayerWarnedSchema,
		regex: /Remote admin has warned player (.*)\. Message was "(.*)"/,
		onMatch: (match) => {
			return {
				time: Date.now(),
				reason: match[2],
				playerIds: PlayerIds.parse({ username: match[1] }),
			}
		},
	})

	const PossessedAdminCameraSchema = eventDef('POSSESSED_ADMIN_CAMERA', {
		time: z.number(),
		playerIds: PlayerIds.Schema,
	})
	export type PossessedAdminCamera = z.infer<typeof PossessedAdminCameraSchema['schema']>

	export const PossessedAdminCameraMatcher = createLogMatcher({
		event: PossessedAdminCameraSchema,
		regex: /\[Online Ids:([^\]]+)\] (.+) has possessed admin camera\./,
		onMatch: (match) => {
			return {
				type: 'POSSESSED_ADMIN_CAMERA' as const,
				time: Date.now(),
				playerIds: PlayerIds.parse({ username: match[2], idsStr: match[1] }),
			}
		},
	})

	const UnpossessedAdminCameraSchema = eventDef('UNPOSSESSED_ADMIN_CAMERA', {
		time: z.number(),
		playerIds: PlayerIds.Schema,
	})
	export type UnpossessedAdminCamera = z.infer<typeof UnpossessedAdminCameraSchema['schema']>

	export const UnpossessedAdminCameraMatcher = createLogMatcher({
		event: UnpossessedAdminCameraSchema,
		regex: /\[Online IDs:([^\]]+)\] (.+) has unpossessed admin camera\./,
		onMatch: (match) => {
			return {
				time: Date.now(),
				playerIds: PlayerIds.parse({ username: match[2], idsStr: match[1] }),
			}
		},
	})

	const SquadCreatedSchema = eventDef('SQUAD_CREATED', {
		time: z.number(),
		squadId: ZodUtils.ParsedIntSchema,
		squadName: z.string(),
		teamName: z.string(),
		creatorIds: PlayerIds.Schema,
	})
	export type SquadCreated = z.infer<typeof SquadCreatedSchema['schema']>

	export const SquadCreatedMatcher = createLogMatcher({
		event: SquadCreatedSchema,
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

	const PlayerBannedSchema = eventDef('PLAYER_BANNED', {
		time: z.number(),
		playerID: z.string(),
		interval: z.string(),
		playerIds: PlayerIds.IdFields('username', 'eos'),
	})
	export type PlayerBanned = z.infer<typeof PlayerBannedSchema['schema']>

	export const PlayerBannedMatcher = createLogMatcher({
		event: PlayerBannedSchema,
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

	export const matchers = [
		ChatMessageMatcher,
		PlayerWarnedMatcher,
		PossessedAdminCameraMatcher,
		UnpossessedAdminCameraMatcher,
		SquadCreatedMatcher,
		PlayerBannedMatcher,
	] as const

	export type Event = z.infer<(typeof matchers)[number]['event']['schema']>
}

export const RCON_EVENT_MATCHERS = RconEvents.matchers

export namespace LogEvents {
	const logStartRegex = /^([[0-9.:-]+]\[[ 0-9]*]).+$/
	const logPreambleRegex = /^\w+: /

	export async function* parse(chunk$: AsyncGenerator<string>) {
		let foundLogStart: boolean = false
		let lineBuffer: string[] = []

		let carry = ''
		for await (const chunk of chunk$) {
			const lines = chunk.split(/\r?\n/)
			lines[0] = carry + lines[0]
			carry = lines.pop() ?? ''
			if (lines.length === 0) continue
			for (const line of lines) {
				if (logPreambleRegex.test(line)) {
					if (foundLogStart) {
						const [event, err] = matchLog(lineBuffer.join('\n'), EventMatchers)
						lineBuffer = []
						foundLogStart = false
						if (event === null && err == null) continue
						yield [event, err] as const
					}
					continue
				}
				const match = line.match(logStartRegex)
				if (!match && !foundLogStart) continue
				if (match && foundLogStart) {
					const [event, err] = matchLog(lineBuffer.join('\n'), EventMatchers)
					lineBuffer = [line]
					if (event === null && err == null) continue
					yield [event, err] as const
					continue
				}
				if (match && !foundLogStart) {
					foundLogStart = true
					lineBuffer = [line]
					continue
				}
				if (!match && foundLogStart) {
					lineBuffer.push(line)
					continue
				}
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

	const NewGameSchema = eventDef('NEW_GAME', {
		...BaseEventProperties,
		mapClassname: z.string().trim(),
		layerClassname: z.string().trim(),
	})

	export type NewGame = z.infer<typeof NewGameSchema['schema']>

	export const NewGameEventMatcher = createLogMatcher({
		regex: /^\[([0-9.:-]+)]\[([ 0-9]*)]LogWorld: Bringing World \/([A-z]+)\/(?:Maps\/)?([A-z0-9-]+)\/(?:.+\/)?([A-z0-9-]+)(?:\.[A-z0-9-]+)/,
		event: NewGameSchema,
		onMatch: (args) => ({
			raw: args[0],
			time: parseTimestamp(args[1]),
			chainID: args[2],
			mapClassname: args[3],
			layerClassname: args[5],
		}),
	})

	const RoundWinnerSchema = eventDef('ROUND_TEAM_OUTCOME', {
		...BaseEventProperties,
		winner: z.string(),
		layer: z.string(),
	})

	export type RoundTeamOutcome = z.infer<typeof RoundWinnerSchema['schema']>

	export const RoundWinnerEventMatcher = createLogMatcher({
		regex: /^\[([0-9.:-]+)]\[([ 0-9]*)]LogGame: Winner: (.+) \(Layer: (.+)\)/,
		event: RoundWinnerSchema,
		onMatch: (args) => ({
			raw: args[0],
			time: parseTimestamp(args[1]),
			chainID: args[2],
			winner: args[3],
			layer: args[4],
		}),
	})

	export const RoundDecidedSchema = eventDef('ROUND_DECIDED', {
		...BaseEventProperties,
		team: TeamIdSchema,
		unit: z.string(),
		faction: z.string(),
		action: z.enum(['won', 'lost']),
		tickets: z.int(),
		layer: z.string(),
		map: z.string(),
	})

	export type RoundDecided = z.infer<typeof RoundDecidedSchema['schema']>

	export const RoundDecidedMatcher = createLogMatcher({
		event: RoundDecidedSchema,
		regex:
			/^\[([0-9.:-]+)]\[([ 0-9]*)]LogSquadGameEvents: Display: Team ([0-9]+), (.*) \( ?(.*?) ?\) has (won|lost) the match with ([0-9]+) Tickets on layer (.*) \(level (.*)\)!/,
		onMatch: (args) => {
			return {
				raw: args[0],
				time: parseTimestamp(args[1]),
				chainID: args[2],
				team: parseInt(args[3]) as 1 | 2,
				unit: args[4],
				faction: args[5],
				action: args[6] as 'won' | 'lost',
				tickets: parseInt(args[7]),
				layer: args[8],
				map: args[9],
			}
		},
	})

	export const RoundEndedSchema = eventDef('ROUND_ENDED', {
		...BaseEventProperties,
	})

	export type RoundEnded = z.infer<typeof RoundEndedSchema['schema']>

	export const RoundEndedMatcher = createLogMatcher({
		event: RoundEndedSchema,
		regex: /^\[([0-9.:-]+)]\[([ 0-9]*)]LogGameState: Match State Changed from InProgress to WaitingPostMatch/,
		onMatch: (args) => {
			return {
				raw: args[0],
				time: parseTimestamp(args[1]),
				chainID: args[2],
			}
		},
	})

	export const PlayerConnectedSchema = eventDef('PLAYER_CONNECTED', {
		...BaseEventProperties,
		playerIds: PlayerIds.IdFields('eos', 'playerController'),
		ip: z.union([z.ipv4(), z.ipv6()]),
	})
	export type PlayerConnected = z.infer<typeof PlayerConnectedSchema['schema']>
	export const PlayerConnectedMatcher = createLogMatcher({
		event: PlayerConnectedSchema,
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

	export const PlayerDisconnectedSchema = eventDef('PLAYER_DISCONNECTED', {
		...BaseEventProperties,
		playerIds: PlayerIds.IdFields('eos', 'playerController'),
		ip: z.union([z.ipv4(), z.ipv6()]),
	})
	export type PlayerDisconnected = z.infer<typeof PlayerDisconnectedSchema['schema']>
	export const PlayerDisconnectedMatcher = createLogMatcher({
		event: PlayerDisconnectedSchema,
		regex:
			/^\[([0-9.:-]+)]\[([ 0-9]*)]LogNet: UChannel::Close: Sending CloseBunch\. ChIndex == [0-9]+\. Name: \[UChannel\] ChIndex: [0-9]+, Closing: [0-9]+ \[UNetConnection\] RemoteAddr: ([\d.]+):[\d]+, Name: \w+EOSIpNetConnection_[0-9]+, Driver: .*?NetDriver_[0-9]+, IsServer: YES, PC: ([^ ]+), Owner: [^ ]+, UniqueId: RedpointEOS:([\d\w]+)/,
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

	export const PlayerJoinSuccededSchema = eventDef('PLAYER_JOIN_SUCCEEDED', {
		...BaseEventProperties,
		player: PlayerIds.IdFields('usernameNoTag'),
	})

	export type PlayerJoinSucceeded = z.infer<typeof PlayerJoinSuccededSchema['schema']>
	export const PlayerJoinSuccededMatcher = createLogMatcher({
		event: PlayerJoinSuccededSchema,
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

	export const PlayerDiedSchema = eventDef('PLAYER_DIED', {
		...BaseEventProperties,
		damage: z.number(),
		weapon: z.string(),
		attackerIds: PlayerIds.IdFields('eos', 'playerController'),
		victimIds: PlayerIds.IdFields('username'),
	})

	export type PlayerDied = z.infer<typeof PlayerDiedSchema['schema']>
	export const PlayerDiedMatcher = createLogMatcher({
		event: PlayerDiedSchema,
		regex:
			/^\[([0-9.:-]+)]\[([ 0-9]*)]LogSquadTrace: \[DedicatedServer](?:ASQSoldier::)?Die\(\): Player:(.+) KillingDamage=(?:-)*([0-9.]+) from ([A-z_0-9]+) \(Online IDs:([^)|]+)\| Contoller ID: ([\w\d]+)\) caused by ([A-z_0-9-]+)_C/,
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
				weapon: args[8],
			}
		},
	})

	export const PlayerWoundedSchema = eventDef('PLAYER_WOUNDED', {
		...BaseEventProperties,
		damage: z.number(),
		weapon: z.string(),
		attackerIds: PlayerIds.IdFields('eos', 'playerController'),
		victimIds: PlayerIds.IdFields('username'),
	})
	export type PlayerWounded = z.infer<typeof PlayerWoundedSchema['schema']>
	export const PlayerWoundedMatcher = createLogMatcher({
		event: PlayerWoundedSchema,
		regex:
			/^\[([0-9.:-]+)]\[([ 0-9]*)]LogSquadTrace: \[DedicatedServer](?:ASQSoldier::)?Wound\(\): Player:(.+) KillingDamage=(?:-)*([0-9.]+) from ([A-z_0-9]+) \(Online IDs:([^)|]+)\| Controller ID: ([\w\d]+)\) caused by ([A-z_0-9-]+)_C/,
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
				weapon: args[8],
			}
		},
	})

	export const AdminBroadcastSchema = eventDef('ADMIN_BROADCAST', {
		...BaseEventProperties,
		message: z.string(),
		from: z.union([z.literal('RCON'), z.literal('unknown'), PlayerIds.Schema]),
	})

	export type AdminBroadcast = z.infer<typeof AdminBroadcastSchema['schema']>
	export const AdminBroadcastMatcher = createLogMatcher({
		event: AdminBroadcastSchema,
		regex: /^\[([0-9.:-]+)]\[([ 0-9]*)]LogSquad: ADMIN COMMAND: Message broadcasted <(.+)> from (.+)/,
		// TODO multiline broadcasts will be truncated. eventually we could set up sftp-tail to handle special cases like this, or maybe use multiple matchers and a flag to reconstruct the full broadcast
		onMatch: (args) => {
			let from: AdminBroadcast['from']
			if (args[4] === 'RCON') {
				from = 'RCON'
			} else {
				const match = args[4].trim().match(/player \d+\. \[Online IDs= ([^\]]+)\]  (.+)/)
				if (match) {
					from = PlayerIds.parse({ username: match[2], idsStr: match[1] })
				} else {
					from = 'unknown'
				}
			}
			return {
				raw: args[0],
				time: parseTimestamp(args[1]),
				chainID: args[2],
				message: args[3],
				from,
			}
		},
	})

	export const MapSetSchema = eventDef('MAP_SET', {
		...BaseEventProperties,
		nextLayer: z.string().trim(),
		nextFactions: z.string().trim().optional(),
	})

	export type MapSet = z.infer<typeof MapSetSchema['schema']>
	export const MapSetMatcher = createLogMatcher({
		event: MapSetSchema,
		regex: /^\[([0-9.:-]+)]\[([ 0-9]*)]LogSquad: ADMIN COMMAND: Set next layer to ([^\s]+)(?: ([^[]+))? from .+/,
		onMatch: (args) => {
			return {
				raw: args[0],
				time: parseTimestamp(args[1]),
				chainID: args[2],
				nextLayer: args[3],
				nextFactions: args[4]?.trim(),
			}
		},
	})

	export const KickingPlayerSchema = eventDef('KICKING_PLAYER', {
		...BaseEventProperties,
		reason: z.string().trim(),
		playerIds: PlayerIds.IdFields('username'),
	})

	export type KickingPlayer = z.infer<typeof KickingPlayerSchema['schema']>
	export const KickingPlayerMatcher = createLogMatcher({
		event: KickingPlayerSchema,
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

	export const PlayerKickedSchema = eventDef('PLAYER_KICKED', {
		...BaseEventProperties,
		playerIds: PlayerIds.IdFields('username', 'eos'),
	})

	export type PlayerKicked = z.infer<typeof PlayerKickedSchema['schema']>
	export const PlayerKickedMatcher = createLogMatcher({
		event: PlayerKickedSchema,
		regex: /^\[([0-9.:-]+)]\[([ 0-9]*)]LogSquad: ADMIN COMMAND: Kicked player \d+\. \[Online IDs=([^\]]+)\]\s+(.+) from .+/,
		onMatch: (args) => {
			return {
				raw: args[0],
				time: parseTimestamp(args[1]),
				chainID: args[2],
				playerIds: PlayerIds.parse({ username: args[4], idsStr: args[3] }),
			}
		},
	})

	export type ToEventMap<E extends SquadLogEvent> = {
		[e in E['type']]: (evt: Extract<E, { type: e }>) => void
	}

	export const EventMatchers = [
		NewGameEventMatcher,
		RoundWinnerEventMatcher,
		RoundDecidedMatcher,
		RoundEndedMatcher,
		PlayerConnectedMatcher,
		PlayerDisconnectedMatcher,
		PlayerJoinSuccededMatcher,
		PlayerDiedMatcher,
		PlayerWoundedMatcher,
		AdminBroadcastMatcher,
		MapSetMatcher,
		KickingPlayerMatcher,
		PlayerKickedMatcher,
	] as const

	export type Event =
		| RoundDecided
		| RoundEnded
		| RoundTeamOutcome
		| NewGame
		| PlayerConnected
		| PlayerDisconnected
		| PlayerJoinSucceeded
		| PlayerDied
		| PlayerWounded
		| AdminBroadcast
		| MapSet
		| KickingPlayer
		| PlayerKicked

	function parseTimestamp(raw: string) {
		const date = dateFns.parse(
			raw + 'Z',
			'yyyy.MM.dd-HH.mm.ss:SSSX',
			new Date(),
		)
		return date.getTime()
	}
}
