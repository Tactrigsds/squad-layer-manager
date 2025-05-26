import type * as SchemaModels from '$root/drizzle/schema.models'
import * as zUtils from '@/lib/zod'
import { z } from 'zod'
import { OneToManyMap } from '../one-to-many-map'

import * as M from '@/models'
import { assertNever, nullOrUndefined as nullOrUndef } from '../typeGuards'

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

export type ServerStatus = {
	name: string
	maxPlayerCount: number
	playerCount: number
	queueLength: number
	maxQueueLength: number
	currentLayer: M.UnvalidatedMiniLayer
	nextLayer: M.UnvalidatedMiniLayer | null
}
export type NewMatchHistory = Omit<SchemaModels.NewMatchHistory, 'ordinal'>

type MatchDetailsCommon = {
	layerSource: M.LayerSource
	ordinal: number
	layerId: M.LayerId
	lqItemId?: string
	historyEntryId: number
	startTime?: Date
}

// Details about current match besides the layer
export type MatchDetails =
	| ({
		status: 'in-progress'
	} & MatchDetailsCommon)
	| (
		& {
			status: 'post-game'
			endTime: Date
			outcome: {
				type: 'team1' | 'team2'
				team1Tickets: number
				team2Tickets: number
			} | {
				type: 'draw'
			}
		}
		& MatchDetailsCommon
	)

export function getTeamParityForOffset(matchDetails: Pick<MatchDetails, 'ordinal'>, offset: number) {
	return (matchDetails.ordinal + offset) % 2
}

export function getTeamNormalizedOutcome(matchDetails: Extract<MatchDetails, { status: 'post-game' }>) {
	if (matchDetails.outcome.type === 'draw') {
		return matchDetails.outcome
	}
	const teamATickets = matchDetails.ordinal % 2 === 0 ? matchDetails.outcome.team1Tickets : matchDetails.outcome.team2Tickets
	const teamBTickets = matchDetails.ordinal % 2 === 0 ? matchDetails.outcome.team2Tickets : matchDetails.outcome.team1Tickets
	switch (matchDetails.outcome.type) {
		case 'team1':
			return {
				type: matchDetails.ordinal % 2 === 0 ? 'teamA' as const : 'teamB' as const,
				teamATickets,
				teamBTickets,
			}
		case 'team2':
			return {
				type: matchDetails.ordinal % 2 === 0 ? 'teamB' as const : 'teamA' as const,
				teamATickets,
				teamBTickets,
			}
		default:
			assertNever(matchDetails.outcome)
	}
}

export type MatchHistoryPart = {
	matchHistory: Map<number, MatchDetails>
}

/**
 * Converts a match history entry to current match details and validates the data
 */
export function matchHistoryEntryToMatchDetails(entry: SchemaModels.MatchHistory): MatchDetails {
	let layerSource: M.LayerSource

	switch (entry.setByType) {
		case 'gameserver':
		case 'unknown':
		case 'generated': {
			layerSource = { type: entry.setByType }
			break
		}

		case 'manual': {
			if (!entry.setByUserId) throw new Error("Invalid match history: match setByUserId is null but type is 'manual'")
			layerSource = { type: entry.setByType, userId: BigInt(entry.setByUserId) }
			break
		}
		default: {
			assertNever(entry.setByType)
		}
	}
	const shared = {
		layerSource: layerSource,
		layerId: entry.layerId,
		startTime: entry.startTime ?? undefined,
		historyEntryId: entry.id,
		ordinal: entry.ordinal,
		lqItemId: entry.lqItemId ?? undefined,
	} satisfies Partial<MatchDetailsCommon>

	if (entry.endTime && nullOrUndef(entry.outcome)) throw new Error('Match ended without an outcome')
	else if (!entry.endTime && !nullOrUndef(entry.outcome)) throw new Error('Match not ended but outcome is not null')
	else if (entry.endTime && entry.outcome === 'draw') {
		if (!nullOrUndef(entry.team1Tickets) || !nullOrUndef(entry.team2Tickets)) {
			throw new Error('Match ended in a draw but tickets were not null')
		}

		return {
			status: 'post-game',
			...shared,
			endTime: entry.endTime,
			outcome: {
				type: 'draw',
			},
		}
	} else if (entry.endTime && entry.outcome !== 'draw') {
		if (!entry.team1Tickets || !entry.team2Tickets) throw new Error('Match ended in a win but tickets were null or empty')

		return {
			status: 'post-game',
			...shared,
			endTime: entry.endTime,
			outcome: {
				type: entry.outcome!,
				team1Tickets: entry.team1Tickets,
				team2Tickets: entry.team2Tickets,
			},
		}
	} else if (!entry.endTime && nullOrUndef(entry.outcome)) {
		if (!nullOrUndef(entry.team1Tickets) || !nullOrUndef(entry.team2Tickets)) throw new Error('Match not ended but tickets were not null')

		return {
			status: 'in-progress',
			...shared,
		}
	}

	throw new Error('Invalid match state: unknown')
}

export function matchHistoryEntryFromMatchDetails(matchDetails: MatchDetails, layerVote?: M.VoteState): SchemaModels.MatchHistory {
	const entry: SchemaModels.MatchHistory = {
		id: matchDetails.historyEntryId,
		layerId: matchDetails.layerId,
		lqItemId: matchDetails.lqItemId ?? null,
		layerVote: layerVote ?? null,
		ordinal: matchDetails.ordinal,
		startTime: matchDetails.startTime ?? null,
		setByType: matchDetails.layerSource.type,
		setByUserId: matchDetails.layerSource.type === 'manual' ? matchDetails.layerSource.userId : null,
		endTime: null,
		outcome: null,
		team1Tickets: null,
		team2Tickets: null,
	}

	if (matchDetails.status === 'post-game') {
		entry.endTime = matchDetails.endTime

		if (matchDetails.outcome.type === 'draw') {
			entry.outcome = 'draw'
		} else {
			entry.outcome = matchDetails.outcome.type
			entry.team1Tickets = matchDetails.outcome.team1Tickets
			entry.team2Tickets = matchDetails.outcome.team2Tickets
		}
	}

	return entry
}

export type ServerStatusWithCurrentMatch = ServerStatus & {
	currentMatchId?: number
}

export const TeamIdSchema = z.union([z.literal(1), z.literal(2)])
export type TeamId = z.infer<typeof TeamIdSchema>

export const PlayerSchema = z.object({
	playerID: z.number(),
	steamID: zUtils.ParsedBigIntSchema,
	name: z.string().min(1),
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
export type SquadAdmins = OneToManyMap<bigint, string>
export type SquadGroups = OneToManyMap<string, string>
export type AdminList = { admins: SquadAdmins; groups: SquadGroups }

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
export type ServerStatusWithCurrentMatchRes = { code: 'ok'; data: ServerStatusWithCurrentMatch } | RconError
export type PlayerListRes = { code: 'ok'; players: Player[] } | RconError
export type SquadListRes = { code: 'ok'; squads: Squad[] } | RconError

export const RCON_MAX_BUF_LEN = 4152

export const SquadOutcomeTeamSchema = z.object({
	faction: z.string(),
	subfaction: zUtils.StrOrNullIfEmptyOrWhitespace,
	team: TeamIdSchema,
	tickets: z.number().positive(),
})

export type SquadOutcomeTeam = z.infer<typeof SquadOutcomeTeamSchema>
