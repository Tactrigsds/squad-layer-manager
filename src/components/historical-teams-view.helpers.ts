import type * as ChatPrt from '@/frame-partials/chat.partial'
import * as RSel from '@/lib/reselect'
import type * as BM from '@/models/battlemetrics.models'
import type * as CHAT from '@/models/chat.models'
import type * as MH from '@/models/match-history.models'
import type * as SM from '@/models/squad.models'
import * as StatsModels from '@/models/stats-panel.models'
import type * as TA from '@/models/team-attribution.models'
import type { ClientOnlySettingsStore } from '@/systems/client-only-settings.client'
import type { PublicSettings } from '@/systems/settings.server'

export type HistoricalMember = {
	player: SM.Player
	// time on the team this row sits under / on the other one
	timeMs: number
	otherTeamMs: number
	exclusionReasons: TA.ExclusionReason[]
	eligible: boolean
	stats: CHAT.PlayerStats
}

export type HistoricalSquadGroup = {
	// null groups the players who ended the match squadless on this team
	squad: SM.RecentSquad | null
	members: HistoricalMember[]
}

export type HistoricalTeam = {
	display: StatsModels.TeamDisplay
	playerCount: number
	squads: HistoricalSquadGroup[]
}

export namespace Sel {
	// same tuple as the stats panel's breakdown inputs, so its attribution/teams selectors compose here
	type Inputs = [
		store: ChatPrt.Store,
		currentMatch: MH.MatchDetails | undefined,
		recentMatches: readonly MH.MatchDetails[],
		clientSettings: ClientOnlySettingsStore,
		bmData: BM.PublicPlayerBmData,
		bmStore: BM.StoreState,
		settings: PublicSettings | undefined,
	]

	// The full roster of a historical match, by attributed team and by the squad each player last occupied there.
	// Ineligible players are present and flagged: the roster is the one place carved-out players stay visible.
	export const teams = RSel.memoizeFactory((historicalEvents: CHAT.EventEnriched[] | null) =>
		RSel.createDeepSelector(
			[
				StatsModels.Sel.attribution(historicalEvents),
				(...args: Inputs) =>
					StatsModels.Sel.teams(
						...(args.slice(0, 4) as [
							ChatPrt.Store,
							MH.MatchDetails | undefined,
							readonly MH.MatchDetails[],
							ClientOnlySettingsStore,
						]),
					),
			],
			(attribution, teamDisplays): [HistoricalTeam, HistoricalTeam] | null => {
				if (!attribution) return null
				const squadsById = new Map(attribution.squads.map((s) => [s.uniqueId, s]))
				const groups: Map<number | null, HistoricalMember[]>[] = [new Map(), new Map()]

				for (const attr of attribution.players) {
					// carved-out players with no attributable team fall back to wherever they were last seen
					const teamId = attr.primaryTeamId ?? attr.player.teamId
					if (teamId !== 1 && teamId !== 2) continue
					const member: HistoricalMember = {
						player: attr.player,
						timeMs: attr.teamMs[teamId - 1],
						otherTeamMs: attr.teamMs[2 - teamId],
						exclusionReasons: attr.exclusionReasons,
						eligible: attr.eligible,
						stats: attr.stats,
					}
					const lastSquadId = attr.lastSquadByTeam[teamId - 1]
					// an unresolvable squad reference lands the player in Unassigned rather than a second phantom group
					const squadId = lastSquadId !== null && squadsById.has(lastSquadId) ? lastSquadId : null
					const group = groups[teamId - 1]
					if (!group.has(squadId)) group.set(squadId, [])
					group.get(squadId)!.push(member)
				}

				const byName = (a: HistoricalMember, b: HistoricalMember) =>
					Number(b.player.isLeader) - Number(a.player.isLeader) ||
					(a.player.ids.username ?? '').localeCompare(b.player.ids.username ?? '', undefined, { sensitivity: 'base' })

				return teamDisplays.map((display, teamIdx): HistoricalTeam => {
					const group = groups[teamIdx]
					const squads: HistoricalSquadGroup[] = [...group.entries()]
						.map(
							([squadId, members]): HistoricalSquadGroup => ({
								squad: squadId === null ? null : (squadsById.get(squadId) ?? null),
								members: members.toSorted(byName),
							}),
						)
						.sort((a, b) => (a.squad === null ? 1 : b.squad === null ? -1 : a.squad.squadId - b.squad.squadId))
					return { display, playerCount: [...group.values()].reduce((n, members) => n + members.length, 0), squads }
				}) as [HistoricalTeam, HistoricalTeam]
			},
		),
	)
}
