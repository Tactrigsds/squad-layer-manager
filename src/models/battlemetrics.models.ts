import type * as SM from '@/models/squad.models'
import { z } from 'zod'

// ---- JSON:API shared shapes ----

const JsonApiResourceRef = z.object({
	type: z.string(),
	id: z.string(),
})

// ---- Player flags ----

const FlagPlayerInclude = z.object({
	type: z.literal('flagPlayer'),
	id: z.string(),
	attributes: z.object({
		removedAt: z.string().nullable().optional(),
	}).nullable().optional(),
	relationships: z.object({
		playerFlag: z.object({
			data: JsonApiResourceRef,
		}),
		player: z.object({
			data: JsonApiResourceRef,
		}).optional(),
		organization: z.object({
			data: JsonApiResourceRef,
		}).optional(),
	}).nullable().optional(),
})

export const PlayerFlagAttributes = z.object({
	name: z.string(),
	color: z.string().nullable(),
	description: z.string().nullable(),
	icon: z.string().nullable(),
})

export type PlayerFlag = z.infer<typeof PlayerFlagAttributes> & { id: string }

const PlayerFlagInclude = z.object({
	type: z.literal('playerFlag'),
	id: z.string(),
	attributes: PlayerFlagAttributes,
})

// ---- GET /players?include=identifier,flagPlayer,playerFlag (list) ----

const IdentifierInclude = z.object({
	type: z.literal('identifier'),
	id: z.string(),
	attributes: z.object({
		type: z.string(),
		identifier: z.string(),
	}),
	relationships: z.object({
		player: z.object({
			data: JsonApiResourceRef,
		}),
	}).optional(),
})

const PlayerServerRef = z.object({
	type: z.literal('server'),
	id: z.string(),
	meta: z.object({
		timePlayed: z.number().nullable().optional(),
	}).optional(),
})

export const PlayerListResponse = z.object({
	data: z.array(z.object({
		type: z.literal('player'),
		id: z.string(),
		relationships: z.object({
			servers: z.object({
				data: z.array(PlayerServerRef).optional(),
			}).optional(),
		}).optional(),
	})),
	included: z.array(z.discriminatedUnion('type', [
		IdentifierInclude,
		FlagPlayerInclude,
		PlayerFlagInclude,
	])).nullable().optional(),
	links: z.object({
		next: z.string().nullable().optional(),
		prev: z.string().nullable().optional(),
	}).nullable().optional(),
})

// ---- POST /players/quick-match ----

export const PlayerQuickMatchResponse = z.object({
	data: z.array(z.object({
		type: z.literal('identifier'),
		id: z.string(),
		attributes: z.object({
			type: z.string(),
			identifier: z.string(),
		}),
		relationships: z.object({
			player: z.object({
				data: z.object({ type: z.literal('player'), id: z.string() }),
			}).optional(),
		}).optional(),
	})),
})

// ---- GET /players/{player_id} (single player detail with flags) ----

export const PlayerDetailResponse = z.object({
	data: z.object({
		type: z.literal('player'),
		id: z.string(),
		relationships: z.object({
			servers: z.object({
				data: z.array(PlayerServerRef).optional(),
			}).optional(),
		}).optional(),
	}),
	included: z.array(z.discriminatedUnion('type', [
		IdentifierInclude,
		FlagPlayerInclude,
		PlayerFlagInclude,
	])).nullable().optional(),
})

// ---- Composite types used by server + client ----

export type PlayerFlagsAndProfile = {
	bmPlayerId: string
	flagIds: string[]
	playerIds: SM.PlayerIds.IdQuery<'eos'>
	profileUrl: string
	hoursPlayed: number
}

export type PlayerProfile = {
	hoursPlayer: number
	profileUrl: string
	bmPlayerId: string
}

export type PublicPlayerBmData = Record<string, PlayerFlagsAndProfile>
export type PlayerBmDataUpdate = { playerId: string; data: PlayerFlagsAndProfile }
export function resolveFlags(flagIds: string[], orgFlags: PlayerFlag[]): PlayerFlag[] {
	return flagIds.flatMap((id) => {
		const flag = orgFlags.find((f) => f.id === id)
		return flag ? [flag] : []
	})
}

export const UpdatePlayerFlagsInputSchema = z.object({
	steamId: z.string(),
	flagIds: z.array(z.string()),
})

export type UpdatePlayerFlagsInput = z.infer<typeof UpdatePlayerFlagsInputSchema>

// Flags carry no history of their own on BattleMetrics, so the note is the only durable record of who touched a
// player's flags and why. Both the web workflows and the in-game commands post through here so a profile reads the
// same regardless of where the action came from.
export function flagChangeNote(
	opts: { action: 'added' | 'removed'; flagNames: string[]; actor: string; reason?: string },
): string {
	const flags = opts.flagNames.map((name) => `"${name}"`).join(', ')
	const noun = opts.flagNames.length === 1 ? 'Flag' : 'Flags'
	const reason = opts.reason?.trim()
	return [
		`${noun} ${flags} ${opts.action} by ${opts.actor} via SLM.`,
		...(reason ? [`Reason: ${reason}`] : []),
	].join('\n')
}

// which of `flagIds` require a reason before they can be added. shared by the client (to mark the field required
// up-front) and the server (which enforces it).
export function flagsRequiringNote(flagIds: string[], requiring: string[]): string[] {
	return flagIds.filter((id) => requiring.includes(id))
}

export type StoreState = {
	selectedGroupingId: string | null
	slsOnly: boolean
	orgFlags: PlayerFlag[]
}
