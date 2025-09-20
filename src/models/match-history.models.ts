import type * as SchemaModels from '$root/drizzle/schema.models'
import * as BAL from '@/models/balance-triggers.models'
import * as LL from '@/models/layer-list.models'
import * as V from '@/models/vote.models'

import { assertNever, isNullOrUndef } from '../lib/type-guards'
import * as L from './layer'

export type NewMatchHistory = Omit<SchemaModels.NewMatchHistory, 'ordinal'>

type MatchDetailsCommon = {
	layerSource: LL.LayerSource
	ordinal: number
	// parsed layerId may be from NewMatchHistory.rawLayerCommandText if the layerId is not known
	layerId: L.LayerId
	rawLayerCommandText?: string
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
			outcome: MatchOutcome
		}
		& MatchDetailsCommon
	)

export type MatchOutcome = {
	type: 'team1' | 'team2'
	team1Tickets: number
	team2Tickets: number
} | {
	type: 'draw'
}
export type NormalizedMatchOutcome = {
	type: 'teamA' | 'teamB'
	teamATickets: number
	teamBTickets: number
} | {
	type: 'draw'
}

export type PostGameMatchDetails = Extract<MatchDetails, { status: 'post-game' }>

export type PublicMatchHistoryState = {
	recentMatches: MatchDetails[]
	recentBalanceTriggerEvents: BAL.BalanceTriggerEvent[]
}

export function getTeamParityForOffset(matchDetails: Pick<MatchDetails, 'ordinal'>, offset: number) {
	return (matchDetails.ordinal + offset) % 2
}

export function getTeamNormalizedOutcome(
	matchDetails: Extract<MatchDetails, { status: 'post-game' }>,
): NormalizedMatchOutcome {
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

export function getTeamDenormalizedOutcome(
	matchDetails: { ordinal: number },
	normalizedOutcome: NormalizedMatchOutcome,
): MatchOutcome {
	if (normalizedOutcome.type === 'draw') {
		return normalizedOutcome
	}

	const [team1Tickets, team2Tickets] = matchDetails.ordinal % 2 === 0
		? [normalizedOutcome.teamATickets, normalizedOutcome.teamBTickets]
		: [normalizedOutcome.teamBTickets, normalizedOutcome.teamATickets]

	switch (normalizedOutcome.type) {
		case 'teamA':
			return {
				type: matchDetails.ordinal % 2 === 0 ? 'team1' as const : 'team2' as const,
				team1Tickets: team1Tickets!,
				team2Tickets: team2Tickets!,
			}
		case 'teamB':
			return {
				type: matchDetails.ordinal % 2 === 0 ? 'team2' as const : 'team1' as const,
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
export function matchHistoryEntryToMatchDetails(entry: SchemaModels.MatchHistory): MatchDetails {
	let layerSource: LL.LayerSource

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
		// TODO: find a smart way to handle legacy layer ids
		layerId: entry.layerId,
		rawLayerCommandText: entry.rawLayerCommandText ?? undefined,
		startTime: entry.startTime ?? undefined,
		historyEntryId: entry.id,
		ordinal: entry.ordinal,
		lqItemId: entry.lqItemId ?? undefined,
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

		return {
			status: 'in-progress',
			...shared,
		}
	}

	throw new Error('Invalid match state: unknown')
}

export function matchHistoryEntryFromMatchDetails(matchDetails: MatchDetails, layerVote?: V.VoteState): SchemaModels.MatchHistory {
	let layerId = matchDetails.layerId
	if (!L.isKnownLayer(layerId) && matchDetails.rawLayerCommandText) {
		const layer = L.parseRawLayerText(matchDetails.rawLayerCommandText)
		if (layer && L.isKnownLayer(layer)) layerId = layer.id
	}
	const entry: SchemaModels.MatchHistory = {
		id: matchDetails.historyEntryId,
		layerId,
		rawLayerCommandText: matchDetails.rawLayerCommandText ?? null,
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

export function getTeamNormalizedFactionProp(offset: number, team: 'A' | 'B' | 'teamA' | 'teamB') {
	const props = ['Faction_1', 'Faction_2'] as const
	team = team.slice(team.length - 1) as 'A' | 'B'
	return props[(offset + Number(team === 'B')) % 2]
}

export function getTeamNormalizedUnitProp(offset: number, team: 'A' | 'B' | 'teamA' | 'teamB') {
	const props = ['Unit_1', 'Unit_2'] as const
	return props[(offset + Number(team === 'B')) % 2]
}

export function getTeamNormalizedAllianceProp(offset: number, team: 'A' | 'B' | 'teamA' | 'teamB') {
	const props = ['Alliance_1', 'Alliance_2'] as const
	return props[(offset + Number(team === 'B')) % 2]
}

export function getActiveTriggerEvents(state: PublicMatchHistoryState) {
	const currentMatch = state.recentMatches[state.recentMatches.length - 1] as MatchDetails | undefined
	const previousMatch = state.recentMatches[state.recentMatches.length - 2] as MatchDetails | undefined
	const active: BAL.BalanceTriggerEvent[] = []
	for (let i = state.recentBalanceTriggerEvents.length - 1; i >= 0; i--) {
		const event = state.recentBalanceTriggerEvents[i]
		if (
			(currentMatch && currentMatch.historyEntryId === event.matchTriggeredId && currentMatch.status === 'post-game')
			|| (previousMatch && previousMatch.historyEntryId === event.matchTriggeredId && currentMatch!.status === 'in-progress')
		) {
			active.push(event)
		}
	}
	return Array.from(active)
}

export function getNewMatchHistoryEntry(opts: { layerId: L.LayerId; startTime: Date; lqItem?: LL.LayerListItem }) {
	const newEntry: Omit<SchemaModels.NewMatchHistory, 'ordinal'> = {
		layerId: opts.layerId,
		rawLayerCommandText: L.getLayerCommand(opts.layerId, 'set-next'),
		startTime: opts.startTime,
		setByType: 'unknown',
	}

	if (opts.lqItem) {
		newEntry.layerId = LL.getActiveItemLayerId(opts.lqItem) ?? newEntry.layerId
		newEntry.lqItemId = opts.lqItem.itemId
		newEntry.layerVote = { choices: opts.lqItem.choices }
		newEntry.setByType = opts.lqItem.source.type

		const setByUserId = opts.lqItem.source.type === 'manual'
			? opts.lqItem.source.userId
			: undefined
		newEntry.setByType = opts.lqItem.source.type
		newEntry.setByUserId = setByUserId
	}
	return newEntry
}

export const RECENT_HISTORY_ITEMS_PER_PAGE = 10
