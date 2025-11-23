import { createLogMatcher } from '@/lib/log-parsing'
import * as zUtils from '@/lib/zod'
import type * as L from '@/models/layer'
import type * as MH from '@/models/match-history.models'
import * as dateFns from 'date-fns'
import { z } from 'zod'
import type { OneToManyMap } from '../lib/one-to-many-map'

export const ServerRawInfoSchema = z.object({
	ServerName_s: z.string(),
	MaxPlayers: z.number().int().nonnegative(),
	PlayerCount_I: zUtils.ParsedIntSchema.pipe(z.number().int().nonnegative()),
	PublicQueue_I: zUtils.ParsedIntSchema.pipe(z.number().int().nonnegative()),
	PublicQueueLimit_I: zUtils.ParsedIntSchema.pipe(z.number().int().nonnegative()),
	MapName_s: z.string(),
	GameMode_s: z.string(),
	GameVersion_s: z.string(),
	LICENSEDSERVER_b: z.boolean(),
	PLAYTIME_I: zUtils.ParsedIntSchema.pipe(z.number().int().nonnegative()),
	Flags_I: zUtils.ParsedIntSchema.pipe(z.number().int().nonnegative()),
	MATCHHOPPER_s: z.string(),
	MatchTimeout_d: z.number().int().nonnegative(),
	SESSIONTEMPLATENAME_s: z.string(),
	Password_b: z.boolean(),
	CurrentModLoadedCount_I: zUtils.ParsedIntSchema.pipe(z.number().int().nonnegative()),
	AllModsWhitelisted_b: z.boolean(),
	Region_s: z.string(),
	NextLayer_s: z.string().optional(),
	TeamOne_s: z.string().optional(),
	TeamTwo_s: z.string().optional(),
})

export type LayersStatus = {
	currentLayer: L.UnvalidatedLayer
	nextLayer: L.UnvalidatedLayer | null
}

export type ServerInfo = {
	name: string
	maxPlayerCount: number
	playerCount: number
	queueLength: number
	maxQueueLength: number
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
	export const Schema = z.object({
		username: z.string(),
		steam: z.bigint().optional(),
		eos: z.string().optional(),
		playerController: z.string().optional(),
	})
		.refine(data => data.steam || data.eos, {
			message: 'Either steam or eos must be provided',
		})

	// in order of lookup preference
	const LOOKUP_PROPS = ['steam', 'eos', 'playerController', 'username'] as const

	// expected to be unique in a collection of PlayerIds. maybe playerController is unique too, not sure
	const UNIQUE_PROPS = ['steam', 'eos'] as const

	export type Type = z.infer<typeof Schema>
	export type IdQuery = Partial<Type>

	export function parsePlayerIds(username: string, idsStr?: string): Type {
		if (!idsStr) {
			return Schema.parse({ username })
		}
		const ids: any = {}
		for (const { key, value } of matchAllIds(idsStr)) {
			ids[key] = value
		}
		return Schema.parse({ ...ids, username })
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

	export function upsert(idList: Type[], id: Type): Type
	export function upsert<T>(idList: T[], cb: (item: T) => Type, newItem: T): T
	export function upsert<T>(
		elts: T[] | Type[],
		cbOrId: ((item: T) => Type) | Type,
		itemOrId?: T | Type,
	): T | Type {
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
						return existing
					}
				}
				Object.assign(existingIds, searchId)
				Object.assign(existing, newItem)
				return existing
			}
			const parsedIds = Schema.parse(searchId)
			Object.assign(cb(newItem), parsedIds)
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
		const newId = Schema.parse(searchId)
		;(elts as Type[]).push(newId)
		return newId
	}

	const ID_MATCHER = /\s*(?<name>[^\s:]+)\s*:\s*(?<id>[^\s]+)/g

	function* matchAllIds(idsStr: string) {
		for (const match of idsStr.matchAll(ID_MATCHER)) {
			yield { key: match.groups!.name, value: match.groups!.id }
		}
	}

	// gets generic id for use in commands(ex warns)
	export function resolvePlayerId(ids: PlayerIds.Type): string {
		return (ids.steam?.toString() ?? ids.steam?.toString())!
	}
}

export const PlayerSchema = z.object({
	ids: PlayerIds.Schema,
	teamID: TeamIdSchema.nullable(),
	squadID: z.number().nullable(),
	isLeader: z.boolean(),
	role: z.string(),
})

export type Player = z.infer<typeof PlayerSchema>

export type SquadId = number
export const SquadSchema = z.object({
	squadID: z.number(),
	squadName: z.string().min(1),
	size: z.number(),
	locked: z.boolean(),
	creatorName: z.string().min(1),
	creator: PlayerIds.Schema,
	teamID: TeamIdSchema.nullable(),
})

export type Squad = z.infer<typeof SquadSchema>

export type PlayerListRes = { code: 'ok'; players: Player[] } | RconError
export type SquadListRes = { code: 'ok'; squads: Squad[] } | RconError

export const CHAT_CHANNEL = z.enum(['ChatAdmin', 'ChatTeam', 'ChatSquad', 'ChatAll'])
export type ChatChannel = z.infer<typeof CHAT_CHANNEL>

export const COMMANDS = ['vote', 'rtv', 'setpool'] as const

export const AdminListSourceSchema = z.object({
	type: z.enum(['remote', 'local', 'ftp']),
	source: z.string(),
})
export type AdminListSource = z.infer<typeof AdminListSourceSchema>
export type SquadAdmins = OneToManyMap<bigint, string>
export type SquadGroups = OneToManyMap<string, string>
export type AdminList = { admins: SquadAdmins; groups: SquadGroups }

export const RCON_MAX_BUF_LEN = 4152

export const SquadOutcomeTeamSchema = z.object({
	faction: z.string(),
	unit: zUtils.StrOrNullIfEmptyOrWhitespace,
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
	export type NewGame = {
		type: 'NEW_GAME'
		time: Date
		mapClassname: string
		layerClassname: string
	}

	export type RoundEnded = {
		type: 'ROUND_ENDED'
		time: Date
		winner: SquadOutcomeTeam | null
		loser: SquadOutcomeTeam | null
	}

	export type Event =
		// from logs
		| NewGame
		| RoundEnded
		// from rcon
		| RconEvents.ChatMessage
		| RconEvents.PossessedAdminCamera
		| RconEvents.UnpossessedAdminCamera
		| RconEvents.PlayerKicked
		| RconEvents.SquadCreated
		| RconEvents.PlayerBanned
		| RconEvents.PlayerWarned

	export type DebugTicketOutcome = { team1: number; team2: number }
}

export namespace RconEvents {
	const ChatMessageSchema = z.object({
		type: z.literal('CHAT_MESSAGE'),
		time: z.date(),
		chat: CHAT_CHANNEL,
		message: z.string(),
		playerIds: PlayerIds.Schema,
	})
	export type ChatMessage = z.infer<typeof ChatMessageSchema>

	export const ChatMessageMatcher = createLogMatcher<ChatMessage>({
		schema: ChatMessageSchema,
		regex: /\[(ChatAll|ChatTeam|ChatSquad|ChatAdmin)] \[Online IDs:([^\]]+)\] (.+?) : (.*)/,
		onMatch: (match) => {
			return {
				type: 'CHAT_MESSAGE' as const,
				time: new Date(),
				chat: match[1] as ChatChannel,
				message: match[4],
				playerIds: PlayerIds.parsePlayerIds(match[3], match[2]),
			}
		},
	})

	const PlayerWarnedSchema = z.object({
		type: z.literal('PLAYER_WARNED'),
		time: z.date(),
		reason: z.string(),
		player: PlayerIds.Schema,
	})
	export type PlayerWarned = z.infer<typeof PlayerWarnedSchema>

	export const PlayerWarnedMatcher = createLogMatcher({
		schema: PlayerWarnedSchema,
		regex: /Remote admin has warned player (.*)\. Message was "(.*)"/,
		onMatch: (match) => {
			return {
				type: 'PLAYER_WARNED' as const,
				time: new Date(),
				reason: match[2],
				player: PlayerIds.parsePlayerIds(match[1]),
			}
		},
	})

	const PossessedAdminCameraSchema = z.object({
		type: z.literal('POSSESSED_ADMIN_CAMERA'),
		time: z.date(),
		player: PlayerIds.Schema,
	})
	export type PossessedAdminCamera = z.infer<typeof PossessedAdminCameraSchema>

	export const PossessedAdminCameraMatcher = createLogMatcher({
		schema: PossessedAdminCameraSchema,
		regex: /\[Online Ids:([^\]]+)\] (.+) has possessed admin camera\./,
		onMatch: (match) => {
			return {
				type: 'POSSESSED_ADMIN_CAMERA' as const,
				time: new Date(),
				player: PlayerIds.parsePlayerIds(match[2], match[1]),
			}
		},
	})

	const UnpossessedAdminCameraSchema = z.object({
		type: z.literal('UNPOSSESSED_ADMIN_CAMERA'),
		time: z.date(),
		player: PlayerIds.Schema,
	})
	export type UnpossessedAdminCamera = z.infer<typeof UnpossessedAdminCameraSchema>

	export const UnpossessedAdminCameraMatcher = createLogMatcher({
		schema: UnpossessedAdminCameraSchema,
		regex: /\[Online IDs:([^\]]+)\] (.+) has unpossessed admin camera\./,
		onMatch: (match) => {
			return {
				type: 'UNPOSSESSED_ADMIN_CAMERA' as const,
				time: new Date(),
				player: PlayerIds.parsePlayerIds(match[2], match[1]),
			}
		},
	})

	const PlayerKickedSchema = z.object({
		type: z.literal('PLAYER_KICKED'),
		time: z.date(),
		player: PlayerIds.Schema,
	})
	export type PlayerKicked = z.infer<typeof PlayerKickedSchema>

	export const PlayerKickedMatcher = createLogMatcher({
		schema: PlayerKickedSchema,
		regex: /Kicked player ([0-9]+)\. \[Online IDs=([^\]]+)\] (.*)/,
		onMatch: (match) => {
			return {
				type: 'PLAYER_KICKED' as const,
				time: new Date(),
				player: PlayerIds.parsePlayerIds(match[3], match[2]),
			}
		},
	})

	const SquadCreatedSchema = z.object({
		type: z.literal('SQUAD_CREATED'),
		time: z.date(),
		squadID: z.string(),
		squadName: z.string(),
		teamName: z.string(),
		player: PlayerIds.Schema,
	})
	export type SquadCreated = z.infer<typeof SquadCreatedSchema>

	export const SquadCreatedMatcher = createLogMatcher({
		schema: SquadCreatedSchema,
		regex: /(?<playerName>.+) \(Online IDs:([^)]+)\) has created Squad (?<squadID>\d+) \(Squad Name: (?<squadName>.+)\) on (?<teamName>.+)/,
		onMatch: (match) => {
			return {
				type: 'SQUAD_CREATED' as const,
				time: new Date(),
				squadID: match.groups!.squadID,
				squadName: match.groups!.squadName,
				teamName: match.groups!.teamName,
				player: PlayerIds.parsePlayerIds(match.groups!.playerName, match[2]),
			}
		},
	})

	const PlayerBannedSchema = z.object({
		type: z.literal('PLAYER_BANNED'),
		time: z.date(),
		playerID: z.string(),
		interval: z.string(),
		player: PlayerIds.Schema,
	})
	export type PlayerBanned = z.infer<typeof PlayerBannedSchema>

	export const PlayerBannedMatcher = createLogMatcher({
		schema: PlayerBannedSchema,
		regex: /Banned player ([0-9]+)\. \[Online IDs=([^\]]+)\] (.*) for interval (.*)/,
		onMatch: (match) => {
			return {
				type: 'PLAYER_BANNED' as const,
				time: new Date(),
				playerID: match[1],
				interval: match[4],
				player: PlayerIds.parsePlayerIds(match[3], match[2]),
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

	export type Event = z.infer<(typeof matchers)[number]['schema']>
}

export const RCON_EVENT_MATCHERS = RconEvents.matchers

export namespace LogEvents {
	const BaseEventProperties = {
		raw: z.string().trim(),
		time: z.date(),
		chainID: z.string(),
	}

	export type SquadLogEvent = {
		type: string
	}

	const NewGameSchema = z.object({
		...BaseEventProperties,
		type: z.literal('NEW_GAME'),
		mapClassname: z.string().trim(),
		layerClassname: z.string().trim(),
	})

	export type NewGame = z.infer<typeof NewGameSchema>

	export const NewGameEventMatcher = createLogMatcher({
		regex: /^\[([0-9.:-]+)]\[([ 0-9]*)]LogWorld: Bringing World \/([A-z]+)\/(?:Maps\/)?([A-z0-9-]+)\/(?:.+\/)?([A-z0-9-]+)(?:\.[A-z0-9-]+)/,
		schema: NewGameSchema,
		onMatch: (args) => ({
			type: 'NEW_GAME' as const,
			raw: args[0],
			time: parseTimestamp(args[1]),
			chainID: args[2],
			mapClassname: args[3],
			layerClassname: args[5],
		}),
	})

	const RoundWinnerSchema = z.object({
		...BaseEventProperties,
		type: z.literal('ROUND_TEAM_OUTCOME'),
		winner: z.string(),
		layer: z.string(),
	})

	export type RoundTeamOutcome = z.infer<typeof RoundWinnerSchema>

	export const RoundWinnerEventMatcher = createLogMatcher({
		regex: /^\[([0-9.:-]+)]\[([ 0-9]*)]LogGame: Winner: (.+) \(Layer: (.+)\)/,
		schema: RoundWinnerSchema,
		onMatch: (args) => ({
			type: 'ROUND_TEAM_OUTCOME' as const,
			raw: args[0],
			time: parseTimestamp(args[1]),
			chainID: args[2],
			winner: args[3],
			layer: args[4],
		}),
	})

	export const RoundDecidedSchema = z.object({
		...BaseEventProperties,
		type: z.literal('ROUND_DECIDED'),
		team: TeamIdSchema,
		unit: z.string(),
		faction: z.string(),
		action: z.enum(['won', 'lost']),
		tickets: z.number().int(),
		layer: z.string(),
		map: z.string(),
	})

	export type RoundDecided = z.infer<typeof RoundDecidedSchema>

	export const RoundDecidedMatcher = createLogMatcher({
		schema: RoundDecidedSchema,
		regex:
			/^\[([0-9.:-]+)]\[([ 0-9]*)]LogSquadGameEvents: Display: Team ([0-9]+), (.*) \( ?(.*?) ?\) has (won|lost) the match with ([0-9]+) Tickets on layer (.*) \(level (.*)\)!/,
		onMatch: (args) => {
			return {
				type: 'ROUND_DECIDED' as const,
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

	export const RoundEndedSchema = z.object({
		...BaseEventProperties,
		type: z.literal('ROUND_ENDED'),
	})

	export type RoundEnded = z.infer<typeof RoundEndedSchema>

	export const RoundEndedMatcher = createLogMatcher({
		schema: RoundEndedSchema,
		regex: /^\[([0-9.:-]+)]\[([ 0-9]*)]LogGameState: Match State Changed from InProgress to WaitingPostMatch/,
		onMatch: (args) => {
			return {
				type: 'ROUND_ENDED' as const,
				raw: args[0],
				time: parseTimestamp(args[1]),
				chainID: args[2],
			}
		},
	})

	export const PlayerConnectedSchema = z.object({
		type: z.literal('PLAYER_CONNECTED'),
		time: z.date(),
		chainID: z.string(),
		player: PlayerIds.Schema,
	})
	export const PlayerConnectedMatcher = createLogMatcher({
		schema: PlayerConnectedSchema,
		regex: /^\[([0-9.:-]+)]\[([ 0-9]*)]LogGameState: Player Connected/,
		onMatch: (args) => {
			return {
				type: 'PLAYER_CONNECTED' as const,
				raw: args[0],
				time: parseTimestamp(args[1]),
				chainID: args[2],
				player: PlayerIds.parsePlayerIds(args[3]),
			}
		},
	})

	export type ToEventMap<E extends SquadLogEvent> = {
		[e in E['type']]: (evt: Extract<E, { type: e }>) => void
	}

	export const EventMatchers = [NewGameEventMatcher, RoundWinnerEventMatcher, RoundDecidedMatcher, RoundEndedMatcher] as const
	export type Event = RoundDecided | RoundEnded | RoundTeamOutcome | NewGame

	function parseTimestamp(raw: string) {
		const date = dateFns.parse(
			raw + 'Z',
			'yyyy.MM.dd-HH.mm.ss:SSSX',
			new Date(),
		)
		return date
	}
}
