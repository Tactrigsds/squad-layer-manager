import * as zUtils from '@/lib/zod'
import type * as L from '@/models/layer'
import type * as MH from '@/models/match-history.models'
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

export const PlayerSchema = z.object({
	playerID: z.number(),
	steamID: zUtils.ParsedBigIntSchema,
	name: z.string().min(1).trim(),
	teamID: TeamIdSchema.nullable(),
	squadID: z.number().nullable(),
	isLeader: z.boolean(),
	role: z.string(),
})

export type Player = z.infer<typeof PlayerSchema>

export const SquadSchema = z.object({
	squadID: z.number(),
	squadName: z.string().min(1),
	size: z.number(),
	locked: z.boolean(),
	creatorName: z.string().min(1),
	teamID: TeamIdSchema.nullable(),
})

export type Squad = z.infer<typeof SquadSchema>

export type PlayerListRes = { code: 'ok'; players: Player[] } | RconError
export type SquadListRes = { code: 'ok'; squads: Squad[] } | RconError

export const CHAT_CHANNEL = z.enum(['ChatAdmin', 'ChatTeam', 'ChatSquad', 'ChatAll'])
export type ChatChannel = z.infer<typeof CHAT_CHANNEL>

export const ChatMessageSchema = z
	.object({
		raw: z.string(),
		chat: CHAT_CHANNEL,
		name: z.string(),
		message: z.string(),
		time: z.date(),
		steamID: z.string().optional(),
		eosID: z.string().optional(),
		playerId: z.string(),
	})
	.refine((msg) => msg.steamID || msg.eosID, {
		message: 'steamID or eosID must be present',
	})
export type ChatMessage = z.infer<typeof ChatMessageSchema>

export const AdminCameraSchema = z
	.object({
		raw: z.string(),
		name: z.string(),
		time: z.date(),
	})
	.catchall(z.string())

export const WarnMessageSchema = z.object({
	raw: z.string(),
	name: z.string(),
	reason: z.string(),
	time: z.date(),
})

export const KickMessageSchema = z
	.object({
		raw: z.string(),
		playerID: z.string(),
		name: z.string(),
		time: z.date(),
	})
	.catchall(z.string())

export const BanMessageSchema = z
	.object({
		raw: z.string(),
		playerID: z.string(),
		name: z.string(),
		interval: z.string(),
		time: z.date(),
	})
	.catchall(z.string())

export const SquadCreatedSchema = z
	.object({
		time: z.date(),
		playerName: z.string(),
		squadID: z.string(),
		squadName: z.string(),
		teamName: z.string(),
	})
	.catchall(z.string())

export const COMMANDS = ['vote', 'rtv', 'setpool'] as const

export const SquadEventSchema = z.discriminatedUnion('type', [
	z.object({
		type: z.literal('chat-message'),
		message: ChatMessageSchema,
	}),
])

export type SquadRconEvent = z.infer<typeof SquadEventSchema>
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
