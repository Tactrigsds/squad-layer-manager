import * as ChatPrt from '@/frame-partials/chat.partial'
import type * as Chart from '@/lib/chart'
import * as DH from '@/lib/display-helpers'
import * as RSel from '@/lib/reselect'
import * as L_Msgs from '@/messages/layer.messages'
import * as BM from '@/models/battlemetrics.models'
import type * as CHAT from '@/models/chat.models'
import * as L from '@/models/layer'
import type * as MH from '@/models/match-history.models'
import * as PG from '@/models/player-groupings.models'
import * as SM from '@/models/squad.models'
import type { ClientOnlySettingsStore } from '@/systems/client-only-settings.client'
import type { PublicSettings } from '@/systems/settings.server'

export type TeamDisplay = { label: string; color: string }

// A count over a total, kept unreduced so a tooltip can name both halves. `value` is null where the denominator is
// zero and the numerator is not, i.e. the ratio the display shows as infinite.
export type Ratio = { numerator: number; denominator: number; value: number | null }
export type TeamCombat = { kd: Ratio; wounds: Ratio }
export type CombatStats = { team1: TeamCombat; team2: TeamCombat }

export type BreakdownMember = { id: SM.PlayerId; name: string }

export type Breakdown = {
	series: Chart.Series[]
	rows: Chart.Row[]
	// who is behind each bar segment, indexed [rowIndex][seriesIndex]. Carries ids as well as names because a
	// segment is clickable: what it selects is exactly what it counted.
	members: BreakdownMember[][][]
}

export namespace Sel {
	type TeamInputs = [
		store: ChatPrt.Store,
		currentMatch: MH.MatchDetails | undefined,
		recentMatches: readonly MH.MatchDetails[],
		clientSettings: ClientOnlySettingsStore,
	]
	type BreakdownInputs = [...TeamInputs, bmData: BM.PublicPlayerBmData, bmStore: BM.StoreState, settings: PublicSettings | undefined]

	const displayMatch = (...[store, currentMatch, recentMatches]: TeamInputs) =>
		ChatPrt.Sel.displayMatch(store, currentMatch, recentMatches)
	const teamInputs = (args: BreakdownInputs) => args.slice(0, 4) as TeamInputs

	// how the two teams are named and coloured for this match: raw slots, or normalized to A/B by the match's parity
	export const teams = RSel.createDeepSelector(
		[
			(...args: TeamInputs) => displayMatch(...args)?.layerId,
			(...args: TeamInputs) => displayMatch(...args)?.ordinal,
			(...[, , , clientSettings]: TeamInputs) => clientSettings.displayTeamsNormalized,
		],
		(layerId, ordinal, normalized): [TeamDisplay, TeamDisplay] => {
			const layer = layerId ? L.toLayer(layerId) : null
			const factions = layer && L.isKnownLayer(layer) ? [layer.Faction_1, layer.Faction_2] : [null, null]
			if (!normalized) {
				return [
					{ label: L_Msgs.teamName(1, factions[0]).text(), color: DH.TEAM_COLORS.team1 },
					{ label: L_Msgs.teamName(2, factions[1]).text(), color: DH.TEAM_COLORS.team2 },
				]
			}
			const parity = ordinal ?? 0
			const normedLabels = ['A', 'B'] as const
			const normedColors = [DH.TEAM_COLORS.teamA, DH.TEAM_COLORS.teamB]
			return ([1, 2] as const).map((teamId) => {
				const normedIdx = (parity + teamId - 1) % 2
				return { label: L_Msgs.teamName(normedLabels[normedIdx], factions[teamId - 1]).text(), color: normedColors[normedIdx] }
			}) as [TeamDisplay, TeamDisplay]
		},
	)

	// Kills and wounds per team over the displayed match. Historical events arrive from a query rather than a store,
	// so they parameterise the selector; the live buffer is mutated in place, and its generation counter is what
	// invalidates the cache.
	export const combatStats = RSel.memoizeFactory((historicalEvents: CHAT.EventEnriched[] | null) =>
		RSel.createDeepSelector(
			[
				(...[store]: TeamInputs) => store.chat.eventGeneration,
				(...[store]: TeamInputs) => ChatPrt.Sel.chatEvents(store),
				(...[store]: TeamInputs) => ChatPrt.Sel.selectedMatchOrdinal(store),
				(...args: TeamInputs) => displayMatch(...args)?.historyEntryId,
			],
			(_generation, buffer, selectedOrdinal, liveMatchId): CombatStats | null => {
				const events = selectedOrdinal !== null ? historicalEvents : liveMatchId === undefined ? null : buffer
				if (!events || events.length === 0) return null
				// a historical match's events are already scoped to it; the live buffer spans several
				const matchId = selectedOrdinal !== null ? null : liveMatchId

				const kills = [0, 0]
				const deaths = [0, 0]
				const wounds = [0, 0]
				const wounded = [0, 0]
				for (const event of events) {
					if (event.type !== 'PLAYER_DIED' && event.type !== 'PLAYER_WOUNDED') continue
					if (matchId !== null && event.matchId !== matchId) continue
					// unknown team ids fall outside 0..1 and so count towards neither side
					const victimIdx = (event.victim.teamId ?? 0) - 1
					const attackerIdx = (event.attacker.teamId ?? 0) - 1
					const [inflicted, suffered] = event.type === 'PLAYER_DIED' ? [kills, deaths] : [wounds, wounded]
					if (victimIdx === 0 || victimIdx === 1) suffered[victimIdx]++
					// teamkills and suicides are still deaths, but they are not the attacking team's doing
					if (event.variant === 'normal' && (attackerIdx === 0 || attackerIdx === 1)) inflicted[attackerIdx]++
				}

				const team = (idx: number): TeamCombat => ({ kd: ratio(kills[idx], deaths[idx]), wounds: ratio(wounds[idx], wounded[idx]) })
				return { team1: team(0), team2: team(1) }
			},
		),
	)

	const groupingIds = RSel.createDeepSelector(
		[(...[, , , , , , settings]: BreakdownInputs) => settings?.playerGroupings],
		(playerGroupings) => (playerGroupings ? PG.getGroupingIds(playerGroupings) : []),
	)

	const activeGroupingId = RSel.createSelector(
		[groupingIds, (...[, , , , , bmStore]: BreakdownInputs) => bmStore.selectedGroupingId],
		(ids, selected) => (selected !== null && ids.includes(selected) ? selected : (ids[0] ?? null)),
	)

	// what the grouping switcher above the chart renders: every configured grouping, and the one in effect
	export const groupings = RSel.createDeepSelector([groupingIds, activeGroupingId], (ids, active) => ({ ids, active }))

	// The live roster split by team and by the active grouping. A historical match has no roster to break down, so
	// the chart is absent rather than empty while one is selected.
	export const breakdown = RSel.createDeepSelector(
		[
			(...[store]: BreakdownInputs) => ChatPrt.Sel.selectedMatchOrdinal(store),
			(...[store]: BreakdownInputs) => ChatPrt.Sel.chatState(store).players,
			(...[, , , , bmData]: BreakdownInputs) => bmData,
			(...[, , , , , bmStore]: BreakdownInputs) => bmStore.slsOnly,
			(...[, , , , , bmStore]: BreakdownInputs) => bmStore.orgFlags,
			(...[, , , , , , settings]: BreakdownInputs) => settings?.playerGroupings,
			activeGroupingId,
			(...args: BreakdownInputs) => teams(...teamInputs(args)),
		],
		(selectedOrdinal, players, bmData, slsOnly, orgFlags, playerGroupings, groupingId, teamDisplays): Breakdown | null => {
			if (selectedOrdinal !== null || !playerGroupings || groupingId === null) return null
			const grouping = playerGroupings[groupingId]
			if (!grouping) return null

			const rostered = slsOnly ? players.filter((p) => p.isLeader) : players
			// bmData is keyed by EOS id, so players without one can only fall into the ungrouped series
			const playerFacts: [SM.PlayerId, PG.PlayerFacts][] = rostered
				.filter((p) => p.ids.eos != null)
				.map((p) => [p.ids.eos!, PG.playerFacts(p, BM.resolveFlags(bmData[p.ids.eos!]?.flagIds ?? [], orgFlags))])
			const groups = PG.resolvePlayerGroups(playerFacts, playerGroupings, groupingId)

			const labels = [...PG.getGroupNames(grouping), PG.UNGROUPED_LABEL]
			const labelToIdx = new Map(labels.map((label, i) => [label, i]))
			const ungroupedIdx = labels.length - 1
			const counts = [labels.map(() => 0), labels.map(() => 0)]
			const members: BreakdownMember[][][] = [labels.map((): BreakdownMember[] => []), labels.map((): BreakdownMember[] => [])]

			for (const player of rostered) {
				const rowIndex = (player.teamId ?? 0) - 1
				if (rowIndex !== 0 && rowIndex !== 1) continue
				const group = player.ids.eos != null ? groups.get(player.ids.eos) : undefined
				const seriesIndex = group != null ? (labelToIdx.get(group) ?? -1) : ungroupedIdx
				if (seriesIndex === -1) continue
				counts[rowIndex][seriesIndex]++
				members[rowIndex][seriesIndex].push({
					id: SM.PlayerIds.getPlayerId(player.ids),
					name: player.ids.usernameNoTag ?? player.ids.username ?? player.ids.steam ?? '?',
				})
			}

			return {
				series: labels.map((label) => ({ key: label, label, color: PG.getGroupColor(grouping, label, orgFlags) })),
				rows: teamDisplays.map((team, rowIndex) => ({ key: `team${rowIndex + 1}`, label: team.label, values: counts[rowIndex] })),
				members,
			}
		},
	)

	// whether the panel has anything at all to draw, so it can show its empty state without every child duplicating
	// the question
	export const hasData = RSel.memoizeFactory((historicalEvents: CHAT.EventEnriched[] | null) =>
		RSel.createSelector(
			[(...args: BreakdownInputs) => combatStats(historicalEvents)(...teamInputs(args)), breakdown],
			(combat, breakdown) => combat !== null || breakdown !== null,
		),
	)
}

function ratio(numerator: number, denominator: number): Ratio {
	return { numerator, denominator, value: denominator === 0 ? (numerator > 0 ? null : 0) : numerator / denominator }
}
