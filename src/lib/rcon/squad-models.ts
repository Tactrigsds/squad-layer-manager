import { z } from 'zod'

import { parsedBigint, parsedNum } from '@/lib/zod.ts'
import * as M from '@/models'

export const ServerRawInfoSchema = z.object({
	ServerName_s: z.string(),
	MaxPlayers: z.number().int().nonnegative(),
	PublicQueueLimit_I: parsedNum('int', z.number().int().nonnegative()),
	PlayerReserveCount_I: parsedNum('int', z.number().int().nonnegative()),
	PlayerCount_I: parsedNum('int', z.number().int().nonnegative()),
	PublicQueue_I: parsedNum('int', z.number().int().nonnegative()),
	ReservedQueue_I: parsedNum('int', z.number().int().nonnegative()),
	MapName_s: z.string(),
	NextLayer_s: z.string().optional(),
	TeamOne_s: z.string().optional(),
	TeamTwo_s: z.string().optional(),
	MatchTimeout_d: z.number().int().nonnegative(),
	PLAYTIME_I: parsedNum('int', z.number().int().nonnegative()),
	GameVersion_s: z.string(),
})

export type ServerStatus = {
	name: string
	maxPlayers: number
	reserveSlots: number
	currentPlayers: number
	currentPlayersInQueue: number
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
	})
	.catchall(z.string())

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

export const CHATS = z.enum(['admin', 'all', 'team', 'squad'])
export const COMMANDS = ['vote', 'rtv', 'setpool'] as const

export const SquadEventSchema = z.discriminatedUnion('type', [
	z.object({
		type: z.literal('chat-message'),
		chat: CHATS,
		playerId: z.string(),
		message: z.string().trim(),
		eventId: z.number(),
	}),
	z.object({
		type: z.literal('game-ended'),
		currentLayerId: z.string(),
		nextLayerId: z.string(),
		messageId: z.string(),
		eventId: z.number(),
	}),
	z.object({
		type: z.literal('set-next-layer'),
		layerId: z.string(),
		messageId: z.string(),
		eventId: z.number(),
	}),
])

export type SquadEvent = z.infer<typeof SquadEventSchema>
export const AdminListSourceSchema = z.object({ type: z.enum(['remote', 'local', 'ftp']), source: z.string().url() })
export type AdminListSource = z.infer<typeof AdminListSourceSchema>
export type SquadAdminPerms = { [key: string]: boolean }
export type SquadAdmins = Map<bigint, Record<string, boolean>>
