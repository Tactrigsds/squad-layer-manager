import { Observable } from 'rxjs'
import { z } from 'zod'

import { parsedBigint, parsedNum } from '@/lib/zod.ts'
import * as M from '@/models'
import * as C from '@/server/context.ts'

export const ServerRawInfoSchema = z.object({
	ServerName_s: z.string(),
	MaxPlayers: z.number().int().nonnegative(),
	PlayerCount_I: parsedNum('int', z.number().int().nonnegative()),
	MapName_s: z.string(),
	GameMode_s: z.string(),
	GameVersion_s: z.string(),
	LICENSEDSERVER_b: z.boolean(),
	PLAYTIME_I: parsedNum('int', z.number().int().nonnegative()),
	Flags_I: parsedNum('int', z.number().int().nonnegative()),
	MATCHHOPPER_s: z.string(),
	MatchTimeout_d: z.number().int().nonnegative(),
	SESSIONTEMPLATENAME_s: z.string(),
	Password_b: z.boolean(),
	CurrentModLoadedCount_I: parsedNum('int', z.number().int().nonnegative()),
	AllModsWhitelisted_b: z.boolean(),
	'ap-east-1_I': parsedNum('int', z.number().int().nonnegative()),
	'ap-southeast-2_I': parsedNum('int', z.number().int().nonnegative()),
	'me-central-1_I': parsedNum('int', z.number().int().nonnegative()),
	'us-east-1_I': parsedNum('int', z.number().int().nonnegative()),
	'us-west-1_I': parsedNum('int', z.number().int().nonnegative()),
	'eu-west-2_I': parsedNum('int', z.number().int().nonnegative()),
	'eu-central-1_I': parsedNum('int', z.number().int().nonnegative()),
	'eu-north-1_I': parsedNum('int', z.number().int().nonnegative()),
	'ap-southeast-1_I': parsedNum('int', z.number().int().nonnegative()),
	Region_s: z.string(),
	NextLayer_s: z.string().optional(),
	TeamOne_s: z.string().optional(),
	TeamTwo_s: z.string().optional(),
})

export type ServerStatus = {
	name: string
	maxPlayers: number
	currentPlayers: number
	currentLayer: M.MiniLayer
	nextLayer: M.MiniLayer | null
}

export const PlayerSchema = z.object({
	playerID: z.number(),
	steamID: parsedBigint(),
	name: z.string().min(1),
	teamID: z.number(),
	squadID: z.number().optional(),
	isLeader: z.boolean(),
	role: z.string(),
	onlineIDs: z.record(z.string(), z.string()),
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

export const ChatMessageSchema = z
	.object({
		raw: z.string(),
		chat: z.string(),
		name: z.string(),
		message: z.string(),
		time: z.date(),
		steamID: z.string().optional(),
		eosID: z.string().optional(),
		playerId: z.string(),
	})
	.refine((msg) => msg.steamID || msg.eosID, { message: 'steamID or eosID must be present' })
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

export const CHAT_CHANNEL = z.enum(['admin', 'team', 'squad'])
export type ChatChannel = z.infer<typeof CHAT_CHANNEL>
export const COMMANDS = ['vote', 'rtv', 'setpool'] as const

export const SquadEventSchema = z.discriminatedUnion('type', [
	z.object({
		type: z.literal('chat-message'),
		message: ChatMessageSchema,
	}),
])

export type SquadEvent = z.infer<typeof SquadEventSchema>
export const AdminListSourceSchema = z.object({ type: z.enum(['remote', 'local', 'ftp']), source: z.string() })
export type AdminListSource = z.infer<typeof AdminListSourceSchema>
export type SquadAdminPerms = { [key: string]: boolean }
export type SquadAdmins = Map<bigint, Record<string, boolean>>

export interface ISquadRcon {
	event$: Observable<SquadEvent>
	getCurrentMap(ctx: C.Log): Promise<M.MiniLayer>

	getNextLayer(ctx: C.Log): Promise<M.MiniLayer>

	getListPlayers(ctx: C.Log): Promise<Player[]>

	getSquads(ctx: C.Log): Promise<Squad[]>

	broadcast(ctx: C.Log, message: string): Promise<void>

	setFogOfWar(ctx: C.Log, on: boolean): Promise<void>

	warn(ctx: C.Log, anyID: string, message: string): Promise<void>

	ban(ctx: C.Log, anyID: string, banLength: string, message: string): Promise<void>

	switchTeam(ctx: C.Log, anyID: string): Promise<void>

	setNextLayer(ctx: C.Log, layer: M.AdminSetNextLayerOptions): Promise<void>

	endGame(_ctx: C.Log): Promise<void>

	leaveSquad(ctx: C.Log, playerId: number): Promise<void>

	getPlayerQueueLength(ctx: C.Log): Promise<number>

	getCurrentLayer(ctx: C.Log): Promise<M.MiniLayer>

	getServerStatus(ctx: C.Log): Promise<ServerStatus>
}

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
