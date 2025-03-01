import { z } from 'zod'
import { ParsedBigIntSchema, ParsedIntSchema } from '@/lib/zod'

import * as M from '@/models'

export const ServerRawInfoSchema = z.object({
	ServerName_s: z.string(),
	MaxPlayers: z.number().int().nonnegative(),
	PlayerCount_I: ParsedIntSchema.pipe(z.number().int().nonnegative()),
	PublicQueue_I: ParsedIntSchema.pipe(z.number().int().nonnegative()),
	PublicQueueLimit_I: ParsedIntSchema.pipe(z.number().int().nonnegative()),
	MapName_s: z.string(),
	GameMode_s: z.string(),
	GameVersion_s: z.string(),
	LICENSEDSERVER_b: z.boolean(),
	PLAYTIME_I: ParsedIntSchema.pipe(z.number().int().nonnegative()),
	Flags_I: ParsedIntSchema.pipe(z.number().int().nonnegative()),
	MATCHHOPPER_s: z.string(),
	MatchTimeout_d: z.number().int().nonnegative(),
	SESSIONTEMPLATENAME_s: z.string(),
	Password_b: z.boolean(),
	CurrentModLoadedCount_I: ParsedIntSchema.pipe(z.number().int().nonnegative()),
	AllModsWhitelisted_b: z.boolean(),
	'ap-east-1_I': ParsedIntSchema.pipe(z.number().int().nonnegative()),
	'ap-southeast-2_I': ParsedIntSchema.pipe(z.number().int().nonnegative()),
	'me-central-1_I': ParsedIntSchema.pipe(z.number().int().nonnegative()),
	'us-east-1_I': ParsedIntSchema.pipe(z.number().int().nonnegative()),
	'us-west-1_I': ParsedIntSchema.pipe(z.number().int().nonnegative()),
	'eu-west-2_I': ParsedIntSchema.pipe(z.number().int().nonnegative()),
	'eu-central-1_I': ParsedIntSchema.pipe(z.number().int().nonnegative()),
	'eu-north-1_I': ParsedIntSchema.pipe(z.number().int().nonnegative()),
	'ap-southeast-1_I': ParsedIntSchema.pipe(z.number().int().nonnegative()),
	Region_s: z.string(),
	NextLayer_s: z.string().optional(),
	TeamOne_s: z.string().optional(),
	TeamTwo_s: z.string().optional(),
})

export type ServerStatus = {
	name: string
	maxPlayerCount: number
	playerCount: number
	queueLength: number
	maxQueueLength: number
	currentLayer: M.PossibleUnknownMiniLayer
	nextLayer: M.PossibleUnknownMiniLayer | null
}

export const PlayerSchema = z.object({
	playerID: z.number(),
	steamID: ParsedBigIntSchema,
	name: z.string().min(1),
	teamID: z.number(),
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
	teamID: z.number(),
})

export type Squad = z.infer<typeof SquadSchema>

export const COMMAND_SCOPES = z.enum(['admin', 'public'])
export type CommandScope = z.infer<typeof COMMAND_SCOPES>

export const CHAT_CHANNEL = z.enum(['ChatAdmin', 'ChatTeam', 'ChatSquad', 'ChatAll'])
export type ChatChannel = z.infer<typeof CHAT_CHANNEL>
export const CHAT_SCOPE_MAPPINGS = {
	[COMMAND_SCOPES.Values.admin]: ['ChatAdmin'],
	[COMMAND_SCOPES.Values.public]: ['ChatTeam', 'ChatSquad', 'ChatAll'],
}
export function getScopesForChat(chat: ChatChannel): CommandScope[] {
	const matches: CommandScope[] = []
	for (const [scope, chats] of Object.entries(CHAT_SCOPE_MAPPINGS)) {
		if (chats.includes(chat)) {
			matches.push(scope as CommandScope)
		}
	}
	return matches
}

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

export type SquadEvent = z.infer<typeof SquadEventSchema>
export const AdminListSourceSchema = z.object({
	type: z.enum(['remote', 'local', 'ftp']),
	source: z.string(),
})
export type AdminListSource = z.infer<typeof AdminListSourceSchema>
export type SquadAdminPerms = { [key: string]: boolean }
export type SquadAdmins = Map<bigint, Record<string, boolean>>

export const BiomeSchema = z.object({
	name: z.string(),
	maps: z.array(z.string()),
	factions: z.array(z.string()),
})
export type Biome = z.infer<typeof BiomeSchema>

export const AllianceSchema = z.object({
	name: z.string(),
	factions: z.array(z.string()),
})
export type Alliance = z.infer<typeof AllianceSchema>

const bluefor = ['ADF', 'BAF', 'CAF', 'USA', 'USMC'] as const
const pac = ['PLA', 'PLAAGF', 'PLANMC'] as const
const redfor = ['RGF', 'VDV'] as const
export const BIOME_FACTIONS = {
	'Afghanistan / Central Asia': [...bluefor, 'MEA', 'INS', 'TLF', 'WPMC', ...redfor, ...pac],
	'Middle East': [...bluefor, 'MEA', 'INS', 'TLF', 'WPMC', ...redfor, ...pac],
	// https://docs.google.com/spreadsheets/d/1uRUfh-HvOncjHo36uciChQn4MD2oK78g3WLoHLtTREk/edit?pli=1&gid=1025614852#gid=1025614852 sheet appears to be wrong, no  IMF
	'Eastern Europe': [...bluefor, 'MEA', 'TLF', 'WPMC', 'IMF', ...redfor, ...pac],
	'Northern Europe': [...bluefor, 'WPMC', 'IMF', ...redfor],
	'North America': [...bluefor, 'WPMC', ...redfor, ...pac],
	Asia: [...bluefor, 'WPMC', ...pac],
}

export type RconError = { code: 'err:rcon'; msg: string }
export type ServerStatusRes = { code: 'ok'; data: ServerStatus } | RconError
export type PlayerListRes = { code: 'ok'; players: Player[] } | RconError
export type SquadListRes = { code: 'ok'; squads: Squad[] } | RconError

export const RCON_MAX_BUF_LEN = 4152
