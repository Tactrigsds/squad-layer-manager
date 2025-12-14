import { createLogMatcher, eventDef } from '@/lib/log-parsing'
import type { OneToManyMap } from '@/lib/one-to-many-map'
import * as ZodUtils from '@/lib/zod'
import type * as L from '@/models/layer'
import type * as MH from '@/models/match-history.models'
import * as dateFns from 'date-fns'

import { z } from 'zod'

export const ServerRawInfoSchema = z.object({
	ServerName_s: z.string().default('Unknown'),
	MaxPlayers: z.number().int().nonnegative().default(0),
	PlayerCount_I: ZodUtils.ParsedIntSchema.default('0').pipe(z.number().int().nonnegative()),
	PublicQueue_I: ZodUtils.ParsedIntSchema.pipe(z.number().int().nonnegative().optional()).optional(),
	PublicQueueLimit_I: ZodUtils.ParsedIntSchema.pipe(z.number().int().nonnegative()).optional(),
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
	const SchemaBase = z.object({
		username: z.string(),
		steam: z.bigint().optional(),
		eos: z.string().optional(),
		playerController: z.string().optional(),
	})

	export const Schema = SchemaBase.refine(data => data.steam || data.eos, {
		message: 'At least one of  (steam, eos) must be provided',
	})
	export type Type = z.infer<typeof Schema>

	export const IdQuerySchema = SchemaBase.partial()
	export type IdQuery = z.infer<typeof IdQuerySchema>

	// in order of lookup preference
	const LOOKUP_PROPS = ['steam', 'eos', 'playerController', 'username'] as const

	// expected to be unique in a collection of PlayerIds. maybe playerController is unique too, not sure
	const UNIQUE_PROPS = ['steam', 'eos'] as const

	// old signature
	// export function parsePlayerIds(username: string, idsStr?: string): Type {
	export function parsePlayerIdQuery(opts: { playerController?: string; username?: string; idsStr?: string }) {
		const ids: any = {}
		if (opts.idsStr) {
			for (const { key, value } of matchAllIds(opts.idsStr)) {
				if (value === undefined) continue
				if (key === 'steam') {
					ids[key] = BigInt(value)
				} else {
					ids[key] = value
				}
			}
		}
		return { ...ids, username: opts.username?.trim(), playerController: opts.playerController }
	}

	export function extractPlayerIds(opts: { playerController?: string; username: string; idsStr?: string }): Type {
		const ids: any = {}
		if (opts.idsStr) {
			for (const { key, value } of matchAllIds(opts.idsStr)) {
				if (key === 'steam') {
					ids[key] = BigInt(value)
				} else {
					ids[key] = value
				}
			}
		}
		return { ...ids, username: opts.username.trim(), playerController: opts.playerController }
	}

	export function find(idList: Type[], id: IdQuery): Type | undefined
	export function find<T>(idList: T[], cb: (item: T) => Type, id: IdQuery): T | undefined
	export function find<T>(
		elts: T[] | Type[],
		cbOrId?: ((item: T) => Type) | Partial<Type>,
		id?: Partial<Type>,
	): T | Type | undefined {
		if (typeof cbOrId === 'function') {
			// Overload: find<T>(idList: T[], cb: (item: Type) => boolean, id: Partial<Type> | string): T | undefined
			const cb = cbOrId
			const searchId = id!
			for (const prop of LOOKUP_PROPS) {
				if (!searchId[prop]) continue
				for (const item of elts as T[]) {
					if (cb(item)[prop] === searchId[prop]) return item
				}
			}
			return undefined
		}

		// Original overload: find(idList: Type[], id: Partial<Type> | string): Type | undefined
		const searchId = cbOrId as Partial<Type> | string
		if (typeof searchId === 'string') {
			for (const item of elts as Type[]) {
				for (const prop of UNIQUE_PROPS) {
					if (item[prop]?.toString() === searchId) return item
				}
			}
			return undefined
		}
		for (const prop of LOOKUP_PROPS) {
			if (!searchId[prop]) continue
			for (const item of elts as Type[]) {
				if (item[prop] === searchId[prop]) return item
			}
		}
	}

	export function indexOf(idList: Type[], id: IdQuery): number
	export function indexOf<T>(idList: T[], cb: (item: T) => Type, id: IdQuery): number
	export function indexOf<T>(
		elts: T[] | Type[],
		cbOrId?: ((item: T) => Type) | Partial<Type>,
		id?: Partial<Type>,
	): number {
		if (typeof cbOrId === 'function') {
			// Overload: indexOf<T>(idList: T[], cb: (item: T) => Type, id: Partial<Type>): number
			const cb = cbOrId
			const searchId = id!
			for (const prop of LOOKUP_PROPS) {
				if (!searchId[prop]) continue
				for (let i = 0; i < (elts as T[]).length; i++) {
					if (cb((elts as T[])[i])[prop] === searchId[prop]) return i
				}
			}
			return -1
		}

		// Original overload: indexOf(idList: Type[], id: Partial<Type>): number
		const searchId = cbOrId as Partial<Type> | string
		if (typeof searchId === 'string') {
			for (let i = 0; i < (elts as Type[]).length; i++) {
				for (const prop of UNIQUE_PROPS) {
					if ((elts as Type[])[i][prop]?.toString() === searchId) return i
				}
			}
			return -1
		}
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

	export function remove(idList: Type[], id: IdQuery): boolean
	export function remove<T>(idList: T[], cb: (item: T) => Type, id: IdQuery): boolean
	export function remove<T>(
		elts: T[] | Type[],
		cbOrId?: ((item: T) => Type) | Partial<Type>,
		id?: Partial<Type>,
	): boolean {
		if (typeof cbOrId === 'function') {
			// Overload: delete_<T>(idList: T[], cb: (item: T) => Type, id: Partial<Type>): boolean
			const cb = cbOrId
			const searchId = id!
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

		// Original overload: delete_(idList: Type[], id: Partial<Type>): boolean
		const searchId = cbOrId as Partial<Type> | string
		if (typeof searchId === 'string') {
			for (let i = 0; i < (elts as Type[]).length; i++) {
				for (const prop of UNIQUE_PROPS) {
					if ((elts as Type[])[i][prop]?.toString() === searchId) {
						;(elts as Type[]).splice(i, 1)
						return true
					}
				}
			}
			return false
		}
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

	export function match(a: IdQuery, b: IdQuery): boolean {
		for (const prop of LOOKUP_PROPS) {
			if (a[prop] && b[prop] && a[prop] === b[prop]) return true
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
		return (ids.steam?.toString() ?? ids.steam?.toString())!
	}

	export function prettyPrint(type: IdQuery) {
		const parts: string[] = []
		if (type.username) parts.push(type.username)
		if (type.steam) parts.push(`steam:${type.steam}`)
		if (type.eos) parts.push(`eos:${type.eos}`)
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
	creatorIds: PlayerIds.Schema,
	teamId: TeamIdSchema,
})

export type Squad = z.infer<typeof SquadSchema>

export type PlayerListRes = { code: 'ok'; players: Player[] } | RconError
export type SquadListRes = { code: 'ok'; squads: Squad[] } | RconError
export type TeamsRes = { code: 'ok'; players: Player[]; squads: Squad[] } | RconError
export type Teams = Extract<TeamsRes, { code: 'ok' }>

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
export type SquadAdmins = OneToManyMap<bigint, string>
// group -> permissions
export type SquadGroups = OneToManyMap<string, string>
export type AdminList = { players: SquadAdmins; groups: SquadGroups; admins: Set<bigint> }

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

	export type MapSet = {
		type: 'MAP_SET'
		layerId: L.LayerId
	} & Base

	export type NewGame = {
		type: 'NEW_GAME'
		source: 'slm-started' | 'rcon-reconnected' | 'new-game-detected'
		layerId: L.LayerId
		state: {
			players: Player[]
			squads: Squad[]
		}
	} & Base

	export type Reset = {
		type: 'RESET'
		source: 'slm-started' | 'rcon-reconnected'
		state: {
			players: Player[]
			squads: Squad[]
		}
	} & Base

	export type RconConnected = {
		type: 'RCON_CONNECTED'
		reconnected: boolean
	} & Base

	export type RconDisconnected = {
		type: 'RCON_DISCONNECTED'
	} & Base

	export type RoundEnded = {
		type: 'ROUND_ENDED'
	} & Base

	export type PlayerConnected = {
		type: 'PLAYER_CONNECTED'
		player: Player
	} & Base

	export type PlayerDisconnected = {
		type: 'PLAYER_DISCONNECTED'
		playerIds: PlayerIds.IdQuery
	} & Base

	export type SquadCreated = {
		type: 'SQUAD_CREATED'
		squad: Squad
	} & Base

	export type ChatMessage = {
		type: 'CHAT_MESSAGE'
		playerIds: PlayerIds.Type
		message: string
		channel: ChatChannel
	} & Base

	export type AdminBroadcast = {
		type: 'ADMIN_BROADCAST'
		message: string
		from: LogEvents.AdminBroadcast['from']
	} & Base

	// synthetic events from player state
	export type PlayerDetailsChanged = {
		type: 'PLAYER_DETAILS_CHANGED'
		playerIds: PlayerIds.Type
		details: Pick<Player, (typeof PLAYER_DETAILS)[number]>
	} & Base

	export type PlayerChangedTeam = {
		type: 'PLAYER_CHANGED_TEAM'
		playerIds: PlayerIds.Type
		newTeamId: TeamId | null
	} & Base

	// can originate if the player manually leaves the squad, or is removed for some other reason
	export type PlayerLeftSquad = {
		type: 'PLAYER_LEFT_SQUAD'
		playerIds: PlayerIds.Type
		squadId: SquadId
		teamId: TeamId
	} & Base

	// this event is redundant in terms of state transfer, as it could be inferred as the last player leaving a particular squad
	export type SquadDisbanded = {
		type: 'SQUAD_DISBANDED'
		squadId: SquadId
		teamId: TeamId
	} & Base

	export type SquadDetailsChanged = {
		type: 'SQUAD_DETAILS_CHANGED'
		squadId: SquadId
		teamId: TeamId
		details: {
			locked: boolean
		}
	} & Base

	/**
	 * Player joined pre-existing squad
	 */
	export type PlayerJoinedSquad = {
		type: 'PLAYER_JOINED_SQUAD'
		playerIds: PlayerIds.Type
		squadId: SquadId
		teamId: TeamId
	} & Base

	export type PlayerPromotedToLeader = {
		type: 'PLAYER_PROMOTED_TO_LEADER'
		squadId: SquadId
		teamId: TeamId
		newLeaderIds: PlayerIds.Type
	} & Base
	export type PlayerKicked = RconEvents.PlayerKicked & Base
	export type PossessedAdminCamera = RconEvents.PossessedAdminCamera & Base
	export type UnpossessedAdminCamera = RconEvents.UnpossessedAdminCamera & Base
	export type PlayerBanned = RconEvents.PlayerBanned & Base
	export type PlayerWarned = RconEvents.PlayerWarned & Base

	export type PlayerDied = {
		type: 'PLAYER_DIED'
		victimIds: PlayerIds.Type
		attackerIds: PlayerIds.Type
		damage: number
		weapon: string
		variant: PlayerWoundedOrDiedVariant
	} & Base

	export type PlayerWoundedOrDiedVariant = 'normal' | 'suicide' | 'teamkill'

	export type PlayerWounded = {
		type: 'PLAYER_WOUNDED'
		victimIds: PlayerIds.Type
		attackerIds: PlayerIds.Type
		damage: number
		weapon: string
		variant: PlayerWoundedOrDiedVariant
	} & Base

	export type Event =
		| MapSet
		| NewGame
		| Reset
		| RconConnected
		| RconDisconnected
		| RoundEnded
		| PlayerConnected
		| PlayerDisconnected
		| SquadCreated
		| ChatMessage
		| AdminBroadcast
		// from rcon
		| PossessedAdminCamera
		| UnpossessedAdminCamera
		| PlayerKicked
		| PlayerBanned
		| PlayerWarned
		| PlayerDied
		| PlayerWounded
		// synthetic
		| PlayerDetailsChanged
		| PlayerChangedTeam
		| PlayerLeftSquad
		| SquadDisbanded
		| SquadDetailsChanged
		| PlayerJoinedSquad
		| PlayerPromotedToLeader
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
				playerIds: PlayerIds.extractPlayerIds({ username: match[3], idsStr: match[2] }),
			}
		},
	})

	const PlayerWarnedSchema = eventDef('PLAYER_WARNED', {
		time: z.number(),
		reason: z.string(),
		playerIds: PlayerIds.IdQuerySchema,
	})
	export type PlayerWarned = z.infer<typeof PlayerWarnedSchema['schema']>

	export const PlayerWarnedMatcher = createLogMatcher({
		event: PlayerWarnedSchema,
		regex: /Remote admin has warned player (.*)\. Message was "(.*)"/,
		onMatch: (match) => {
			return {
				time: Date.now(),
				reason: match[2],
				playerIds: PlayerIds.extractPlayerIds({ username: match[1] }),
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
				playerIds: PlayerIds.extractPlayerIds({ username: match[2], idsStr: match[1] }),
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
				playerIds: PlayerIds.extractPlayerIds({ username: match[2], idsStr: match[1] }),
			}
		},
	})

	const PlayerKickedSchema = eventDef('PLAYER_KICKED', {
		time: z.number(),
		playerIds: PlayerIds.Schema,
	})
	export type PlayerKicked = z.infer<typeof PlayerKickedSchema['schema']>

	export const PlayerKickedMatcher = createLogMatcher({
		event: PlayerKickedSchema,
		regex: /Kicked player ([0-9]+)\. \[Online IDs=([^\]]+)\] (.*)/,
		onMatch: (match) => {
			return {
				time: Date.now(),
				playerIds: PlayerIds.extractPlayerIds({ username: match[3], idsStr: match[2] }),
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
				creatorIds: PlayerIds.extractPlayerIds({ username: match.groups!.playerName, idsStr: match[2] }),
			}
		},
	})

	const PlayerBannedSchema = eventDef('PLAYER_BANNED', {
		time: z.number(),
		playerID: z.string(),
		interval: z.string(),
		playerIds: PlayerIds.Schema,
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
				playerIds: PlayerIds.extractPlayerIds({ username: match[3], idsStr: match[2] }),
			}
		},
	})

	export const matchers = [
		ChatMessageMatcher,
		PlayerWarnedMatcher,
		PossessedAdminCameraMatcher,
		UnpossessedAdminCameraMatcher,
		PlayerKickedMatcher,
		SquadCreatedMatcher,
		PlayerBannedMatcher,
	] as const

	export type Event = z.infer<(typeof matchers)[number]['event']['schema']>
}

export const RCON_EVENT_MATCHERS = RconEvents.matchers

export namespace LogEvents {
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
		tickets: z.number().int(),
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
		player: PlayerIds.IdQuerySchema,
		ip: z.string().ip(),
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
				player: PlayerIds.parsePlayerIdQuery({ idsStr: args[5], playerController: args[3] }),
				ip: args[4],
			}
		},
	})

	export const PlayerDisconnectedSchema = eventDef('PLAYER_DISCONNECTED', {
		...BaseEventProperties,
		playerIds: PlayerIds.IdQuerySchema,
		ip: z.string().ip(),
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
				playerIds: {
					playerController: args[4].trim(),
					eos: args[5].trim(),
				},
			}
		},
	})

	export const PlayerJoinSuccededSchema = eventDef('PLAYER_JOIN_SUCCEEDED', {
		...BaseEventProperties,
		player: PlayerIds.IdQuerySchema,
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
				player: { username: args[3].trim() },
			}
		},
	})

	export const PlayerDiedSchema = eventDef('PLAYER_DIED', {
		...BaseEventProperties,
		victimName: z.string(),
		damage: z.number(),
		attackerPlayerController: z.string(),
		attackerIds: PlayerIds.IdQuerySchema,
		weapon: z.string(),
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
				victimName: args[3].trim(),
				damage: parseFloat(args[4]),
				attackerPlayerController: args[5],
				attackerIds: PlayerIds.parsePlayerIdQuery({ idsStr: args[6], playerController: args[7] }),
				weapon: args[8],
			}
		},
	})

	export const PlayerWoundedSchema = eventDef('PLAYER_WOUNDED', {
		...BaseEventProperties,
		victimName: z.string(),
		damage: z.number(),
		attackerPlayerController: z.string(),
		attackerIds: PlayerIds.IdQuerySchema,
		weapon: z.string(),
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
				victimName: args[3].trim(),
				damage: parseFloat(args[4]),
				attackerPlayerController: args[5],
				attackerIds: PlayerIds.parsePlayerIdQuery({ idsStr: args[6], playerController: args[7] }),
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
					from = PlayerIds.extractPlayerIds({ username: match[2], idsStr: match[1] })
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

	function parseTimestamp(raw: string) {
		const date = dateFns.parse(
			raw + 'Z',
			'yyyy.MM.dd-HH.mm.ss:SSSX',
			new Date(),
		)
		return date.getTime()
	}
}
