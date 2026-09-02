import type { Mutex } from 'async-mutex'

import type * as SchemaModels from '$root/drizzle/schema.models'
import * as CD from '@/lib/ctx-def'
import type * as Rx from '@/lib/rxjs'
import type { Parts } from '@/lib/types'
import { z } from '@/lib/zod'
import * as CS from '@/models/context-shared'
import type * as LL from '@/models/layer-list.models'
import type * as SM from '@/models/squad.models'
import type * as USR from '@/models/users.models'

import { assertNever, isNullOrUndef } from '../lib/type-guards'
import * as L from './layer'

export type NewMatchHistory = Omit<SchemaModels.NewMatchHistory, 'ordinal'>

/** How many matches the in-memory window getRecentMatches reads from holds. */
export const MAX_RECENT_MATCHES = 100

type MatchDetailsCommon = {
	layerSource: LL.Source
	ordinal: number
	// parsed layerId may be from NewMatchHistory.rawLayerCommandText if the layerId is not known
	layerId: L.LayerId
	serverId: string
	rawLayerCommandText?: string
	lqItemId?: string
	historyEntryId: number
	startTime?: Date
	isCurrentMatch: boolean
	createdAt: Date | null
}

// Details about current match besides the layer
export type MatchDetails =
	| ({
			status: 'in-progress'
	  } & MatchDetailsCommon)
	| ({
			status: 'post-game'
			endTime: Date | 'unknown'
			outcome: MatchOutcome
	  } & MatchDetailsCommon)

export const MatchOutcomeSchema = z.discriminatedUnion('type', [
	z.object({ type: z.literal('team1'), team1Tickets: z.number(), team2Tickets: z.number() }),
	z.object({ type: z.literal('team2'), team1Tickets: z.number(), team2Tickets: z.number() }),
	z.object({ type: z.literal('draw') }),
	z.object({ type: z.literal('unknown') }),
])
export type MatchOutcome = z.infer<typeof MatchOutcomeSchema>
export type NormalizedMatchOutcome =
	| {
			type: NormedTeamProp
			teamATickets: number
			teamBTickets: number
	  }
	| {
			type: 'draw'
	  }
	| {
			type: 'unknown'
	  }

export type PostGameMatchDetails = Extract<MatchDetails, { status: 'post-game' }>

export type PublicMatchHistoryState = {
	recentMatches: MatchDetails[]
}

export const NormedTeamIdSchema = z.enum(['A', 'B'])
export type NormedTeamId = z.infer<typeof NormedTeamIdSchema>

export const NormedTeamPropSchema = z.enum(['teamA', 'teamB'])
export type NormedTeamProp = z.infer<typeof NormedTeamPropSchema>

export const NormedTeamIdOrPropSchema = z.union([NormedTeamIdSchema, NormedTeamPropSchema])
export type NormedTeamIdOrProp = z.infer<typeof NormedTeamIdOrPropSchema>

/** 'teamA' | 'A' -> 'A'. Neither form says which in-game team that is; see getDenormedTeamId. */
export function toNormedTeamId(team: NormedTeamIdOrProp): NormedTeamId {
	return team.slice(team.length - 1) as NormedTeamId
}
/** 'A' | 'teamA' -> 'teamA'. The property-name form, as stored on layers and settings. */
export function toNormedTeamProp(team: NormedTeamIdOrProp): NormedTeamProp {
	if (team.startsWith('team')) {
		return team as NormedTeamProp
	}
	return `team${team}` as NormedTeamProp
}

/**
 * The team1/team2 <-> A/B mapping for a match `offset` matches after this one, since sides swap every
 * match. Every norm/denorm function below takes this rather than a match, so callers can ask about
 * the next match as easily as the current one. Pass offset 0 for this match.
 */
export function getTeamParityForOffset(matchDetails: Pick<MatchDetails, 'ordinal'>, offset: number) {
	return (matchDetails.ordinal + offset) % 2
}

/** Restates a finished match's outcome in terms of team A and team B. Draws and unknowns pass through. */
export function getTeamNormalizedOutcome(matchDetails: Extract<MatchDetails, { status: 'post-game' }>): NormalizedMatchOutcome {
	if (matchDetails.outcome.type === 'draw' || matchDetails.outcome.type === 'unknown') {
		return matchDetails.outcome
	}
	const teamATickets = matchDetails.ordinal % 2 === 0 ? matchDetails.outcome.team1Tickets : matchDetails.outcome.team2Tickets
	const teamBTickets = matchDetails.ordinal % 2 === 0 ? matchDetails.outcome.team2Tickets : matchDetails.outcome.team1Tickets
	switch (matchDetails.outcome.type) {
		case 'team1':
			return {
				type: matchDetails.ordinal % 2 === 0 ? ('teamA' as const) : ('teamB' as const),
				teamATickets,
				teamBTickets,
			}
		case 'team2':
			return {
				type: matchDetails.ordinal % 2 === 0 ? ('teamB' as const) : ('teamA' as const),
				teamATickets,
				teamBTickets,
			}
		default:
			assertNever(matchDetails.outcome)
	}
}

/** The inverse of getTeamNormalizedOutcome: back to the raw team1/team2 the game reported. */
export function getTeamDenormalizedOutcome(matchDetails: { ordinal: number }, normalizedOutcome: NormalizedMatchOutcome): MatchOutcome {
	if (normalizedOutcome.type === 'draw' || normalizedOutcome.type === 'unknown') {
		return normalizedOutcome
	}

	const [team1Tickets, team2Tickets] =
		matchDetails.ordinal % 2 === 0
			? [normalizedOutcome.teamATickets, normalizedOutcome.teamBTickets]
			: [normalizedOutcome.teamBTickets, normalizedOutcome.teamATickets]

	switch (normalizedOutcome.type) {
		case 'teamA':
			return {
				type: matchDetails.ordinal % 2 === 0 ? ('team1' as const) : ('team2' as const),
				team1Tickets: team1Tickets!,
				team2Tickets: team2Tickets!,
			}
		case 'teamB':
			return {
				type: matchDetails.ordinal % 2 === 0 ? ('team2' as const) : ('team1' as const),
				team1Tickets: team1Tickets!,
				team2Tickets: team2Tickets!,
			}
		default:
			assertNever(normalizedOutcome)
	}
}

export type MatchHistoryPart = {
	matchHistory: Map<number, MatchDetails>
}

/**
 * Converts a match history entry to current match details and validates the data
 */
export function matchHistoryEntryToMatchDetails(entry: SchemaModels.MatchHistory, isCurrentMatch: boolean): MatchDetails {
	let layerSource: LL.Source

	switch (entry.setByType) {
		case 'gameserver':
		case 'unknown':
		case 'ingame-vote':
		case 'generated': {
			layerSource = { type: entry.setByType }
			break
		}

		case 'plugin': {
			if (!entry.setByPluginId) throw new Error("Invalid match history: match setByPluginId is null but type is 'plugin'")
			layerSource = { type: entry.setByType, pluginId: entry.setByPluginId }
			break
		}

		case 'manual': {
			if (!entry.setByUserId) throw new Error("Invalid match history: match setByUserId is null but type is 'manual'")
			layerSource = { type: entry.setByType, userId: entry.setByUserId }
			break
		}
		default: {
			assertNever(entry.setByType)
		}
	}
	const shared = {
		layerSource: layerSource,
		// TODO: find a smart way to handle legacy layer ids
		layerId: entry.layerId,
		rawLayerCommandText: entry.rawLayerCommandText ?? undefined,
		startTime: entry.startTime ?? undefined,
		historyEntryId: entry.id,
		ordinal: entry.ordinal,
		lqItemId: entry.lqItemId ?? undefined,
		serverId: entry.serverId,
		isCurrentMatch,
		createdAt: entry.createdAt,
	} satisfies Partial<MatchDetailsCommon>

	if (!isNullOrUndef(entry.endTime) && isNullOrUndef(entry.outcome)) throw new Error('Match ended without an outcome')
	else if (isNullOrUndef(entry.endTime) && !isNullOrUndef(entry.outcome)) throw new Error('Match not ended but outcome is not null')
	else if (!isNullOrUndef(entry.endTime) && entry.outcome === 'draw') {
		if (!isNullOrUndef(entry.team1Tickets) || !isNullOrUndef(entry.team2Tickets)) {
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
		if (isNullOrUndef(entry.team1Tickets) || isNullOrUndef(entry.team2Tickets)) {
			throw new Error('Match ended in a win but tickets were null or empty')
		}

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
	} else if (isNullOrUndef(entry.endTime) && isNullOrUndef(entry.outcome)) {
		if (!isNullOrUndef(entry.team1Tickets) || !isNullOrUndef(entry.team2Tickets)) {
			throw new Error('Match not ended but tickets were not null')
		}
		if (!isCurrentMatch) {
			return {
				status: 'post-game',
				endTime: 'unknown',
				outcome: { type: 'unknown' },
				...shared,
			}
		}

		return {
			status: 'in-progress',
			...shared,
		}
	}

	throw new Error('Invalid match state: unknown')
}

// The parsed layer parts stored alongside a match, for the layer-config searches that run over history. All
// null for a layer this build's engine can't resolve -- a RAW: id, or one retired from the layer components --
// which is what keeps such a match out of layer-filtered results rather than silently mismatching one.
// reconcileLayerParts fills them in later if a newer engine artifact recognises the id.
export type LayerParts = Pick<
	SchemaModels.MatchHistory,
	'layerMap' | 'layerGamemode' | 'layerVersion' | 'layerTeam1Faction' | 'layerTeam1Unit' | 'layerTeam2Faction' | 'layerTeam2Unit'
>

export const NO_LAYER_PARTS: LayerParts = {
	layerMap: null,
	layerGamemode: null,
	layerVersion: null,
	layerTeam1Faction: null,
	layerTeam1Unit: null,
	layerTeam2Faction: null,
	layerTeam2Unit: null,
}

export function layerParts(layerId: string): LayerParts {
	let layer: L.UnvalidatedLayer
	try {
		layer = L.toLayer(layerId)
	} catch {
		// toLayer reaches the layer components, which throw when layer data isn't loaded yet
		return NO_LAYER_PARTS
	}
	if (!layer || !L.isKnownLayer(layer)) return NO_LAYER_PARTS
	return {
		layerMap: layer.Map,
		layerGamemode: layer.Gamemode,
		layerVersion: layer.LayerVersion,
		layerTeam1Faction: layer.Faction_1,
		layerTeam1Unit: layer.Unit_1,
		layerTeam2Faction: layer.Faction_2,
		layerTeam2Unit: layer.Unit_2,
	}
}

export function matchHistoryEntryFromMatchDetails(matchDetails: MatchDetails): SchemaModels.MatchHistory {
	let layerId = matchDetails.layerId
	if (!L.isKnownLayer(layerId) && matchDetails.rawLayerCommandText) {
		const layer = L.parseRawLayerText(matchDetails.rawLayerCommandText)
		if (layer && L.isKnownLayer(layer)) layerId = layer.id
	}
	const entry: SchemaModels.MatchHistory = {
		id: matchDetails.historyEntryId,
		layerId,
		serverId: matchDetails.serverId,
		rawLayerCommandText: matchDetails.rawLayerCommandText ?? null,
		lqItemId: matchDetails.lqItemId ?? null,
		ordinal: matchDetails.ordinal,
		startTime: matchDetails.startTime ?? null,
		setByType: matchDetails.layerSource.type,
		setByUserId: matchDetails.layerSource.type === 'manual' ? matchDetails.layerSource.userId : null,
		setByPluginId: matchDetails.layerSource.type === 'plugin' ? matchDetails.layerSource.pluginId : null,
		...layerParts(layerId),
		endTime: null,
		outcome: null,
		team1Tickets: null,
		team2Tickets: null,
		createdAt: matchDetails.createdAt,
	}

	if (matchDetails.status === 'post-game') {
		if (matchDetails.endTime === 'unknown') {
			entry.endTime = null
		} else {
			entry.endTime = matchDetails.endTime
		}

		if (matchDetails.outcome.type === 'draw') {
			entry.outcome = 'draw'
		} else if (matchDetails.outcome.type === 'unknown') {
			entry.outcome = null
		} else {
			entry.outcome = matchDetails.outcome.type
			entry.team1Tickets = matchDetails.outcome.team1Tickets
			entry.team2Tickets = matchDetails.outcome.team2Tickets
		}
	}

	return entry
}

/** Which of a layer's Faction_1/Faction_2 belongs to the given normalized team. */
export function getTeamNormalizedFactionProp(offset: number, team: NormedTeamIdOrProp) {
	const props = ['Faction_1', 'Faction_2'] as const
	const normedTeam = toNormedTeamId(team)
	return props[(offset + Number(normedTeam === 'B')) % 2]
}

/** Which of a layer's Unit_1/Unit_2 belongs to the given normalized team. */
export function getTeamNormalizedUnitProp(offset: number, team: NormedTeamIdOrProp) {
	const props = ['Unit_1', 'Unit_2'] as const
	const normedTeam = toNormedTeamId(team)
	return props[(offset + Number(normedTeam === 'B')) % 2]
}

/** Which of a layer's Alliance_1/Alliance_2 belongs to the given normalized team. */
export function getTeamNormalizedAllianceProp(offset: number, team: NormedTeamIdOrProp) {
	const props = ['Alliance_1', 'Alliance_2'] as const
	const normedTeam = toNormedTeamId(team)
	return props[(offset + Number(normedTeam === 'B')) % 2]
}

/** The faction the given normalized team is playing in this match, e.g. "GFI". */
export function getNormedTeamFaction(match: Pick<MatchDetails, 'ordinal' | 'layerId'>, team: NormedTeamId): string | undefined {
	return L.toLayer(match.layerId)[getTeamNormalizedFactionProp(match.ordinal, team)] ?? undefined
}

/** The faction the given in-game (denormalized) team is playing in this match, e.g. "PLA". */
export function getTeamFaction(match: Pick<MatchDetails, 'ordinal' | 'layerId'>, teamId: SM.TeamId): string | undefined {
	return getNormedTeamFaction(match, getNormedTeamId(teamId, match.ordinal))
}

/**
 * The left-to-right order teams should be laid out in. Normalized display keeps team A on the left
 * across matches, denormalized display keeps in-game team 1 on the left.
 */
export function getDisplayedTeamOrder(parity: number, displayTeamsNormalized: boolean): [NormedTeamId, NormedTeamId] {
	if (displayTeamsNormalized) return ['A', 'B']
	return [getNormedTeamId(1, parity), getNormedTeamId(2, parity)]
}

/** In-game team 1|2 -> the persistent side A|B that held it, for a match with the given parity. */
export function getNormedTeamId(teamId: SM.TeamId, parity: number) {
	const normIds = ['A', 'B'] as const
	return normIds[(parity + teamId - 1) % 2]
}
/** A|B -> the in-game team 1|2 that side holds in a match with the given parity. Passes 1|2 through. */
export function getDenormedTeamId(normedTeamId: NormedTeamId | SM.TeamId, parity: number) {
	if (typeof normedTeamId === 'number') return normedTeamId
	if (parity % 2 === 0) {
		return normedTeamId === 'A' ? 1 : 2
	} else {
		return normedTeamId === 'A' ? 2 : 1
	}
}

// `source` attributes a match no queue item accounts for -- the server picked the layer itself.
export function getNewMatchHistoryEntry(opts: {
	layerId: L.LayerId
	serverId: string
	startTime: Date
	lqItem?: LL.Item
	source?: LL.Source
}) {
	const source = opts.lqItem?.source ?? opts.source
	const newEntry: Omit<SchemaModels.NewMatchHistory, 'ordinal'> = {
		layerId: opts.lqItem?.layerId ?? opts.layerId,
		serverId: opts.serverId,
		rawLayerCommandText: L.getLayerCommand(opts.layerId, 'set-next'),
		startTime: opts.startTime,
		setByType: source?.type ?? 'unknown',
		setByUserId: source?.type === 'manual' ? source.userId : undefined,
		setByPluginId: source?.type === 'plugin' ? source.pluginId : undefined,
		lqItemId: opts.lqItem?.itemId,
	}
	return newEntry
}

export const RECENT_HISTORY_ITEMS_PER_PAGE = 10

export namespace Ctx {
	export type Recent = CS.Ctx & {
		recentMatches: MatchDetails[]
	}
	export const RecentDef = CD.defCtx<Recent>()(['recentMatches'], { name: 'recentMatches' })
}

export type Ctx = CS.Ctx & { matchHistory: Ctx.Payload } & CS.ServerId
export const CtxDef = CD.defCtx<Ctx>()(['matchHistory'], { name: 'matchHistory', extends: [CS.ServerIdDef] })

export namespace Ctx {
	export type Payload = {
		mtx: Mutex
		update$: Rx.Subject<void>
		dispatchUpdate: () => void
		// fires once per match that reaches post-game, after the outcome is persisted and state reloaded
		finalized$: Rx.Subject<{ matchId: number }>
		recentMatches: MatchDetails[]
	} & Parts<USR.UserPart>
}
