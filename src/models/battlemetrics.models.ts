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

export type PublicPlayerBmData = Record<string, PlayerFlagsAndProfile>
export type PlayerBmDataUpdate = { playerId: string; data: PlayerFlagsAndProfile }
export const PlayerFlagGroupingsSchema = z.array(
	z.object({ label: z.string(), modeIds: z.array(z.string()), associations: z.record(z.uuid(), z.number()), color: z.string() }),
)
export type PlayerFlagGroupings = z.infer<typeof PlayerFlagGroupingsSchema>

export function getGroupingModeIds(groupings: PlayerFlagGroupings): string[] {
	const seen = new Set<string>()
	const result: string[] = []
	for (const group of groupings) {
		for (const modeId of group.modeIds) {
			if (!seen.has(modeId)) {
				seen.add(modeId)
				result.push(modeId)
			}
		}
	}
	return result
}

export function resolvePlayerFlagGroups(players: [SM.PlayerId, PlayerFlag[]][], groupings: PlayerFlagGroupings, modeId: string) {
	const modeGroupings = groupings.filter(g => g.modeIds.includes(modeId))
	const associations: [string, string, number][] = []
	for (const group of modeGroupings) {
		for (const [id, priority] of Object.entries(group.associations)) {
			associations.push([group.label, id, priority])
		}
	}
	associations.sort((a, b) => a[2] - b[2])

	const groups: Map<SM.PlayerId, string> = new Map()

	for (const [playerId, playerFlags] of players) {
		for (const [label, flagId] of associations) {
			if (playerFlags.some(f => f.id === flagId)) {
				groups.set(playerId, label)
				break
			}
		}
	}

	return groups
}

export const UpdatePlayerFlagsInputSchema = z.object({
	steamId: z.string(),
	flagIds: z.array(z.string()),
})

export type UpdatePlayerFlagsInput = z.infer<typeof UpdatePlayerFlagsInputSchema>
