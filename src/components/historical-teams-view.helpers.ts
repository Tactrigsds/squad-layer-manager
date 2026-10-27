import * as ChatPrt from '@/frame-partials/chat.partial'
import * as TeamsPanelPrt from '@/frame-partials/teams-panel.partial'
import * as RSel from '@/lib/reselect'
import { assertNever } from '@/lib/type-guards'
import type * as BM from '@/models/battlemetrics.models'
import * as CHAT from '@/models/chat.models'
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
	// the squad the player last occupied on this team
	squad: SM.RecentSquad | null
}

export type HistoricalSquadGroup = {
	// null groups the players who ended the match squadless on this team
	squad: SM.RecentSquad | null
	members: HistoricalMember[]
	score: CHAT.PlayerStats
}

export type HistoricalTeam = {
	display: StatsModels.TeamDisplay
	playerCount: number
	squads: HistoricalSquadGroup[]
}

// a team as the view lays it out under the picked sort and search: players under their squads, or in one run
export type SortedHistoricalTeam = {
	display: StatsModels.TeamDisplay
	playerCount: number
	// how many of the team's players the search leaves
	shownCount: number
	layout: { kind: 'squads'; squads: HistoricalSquadGroup[] } | { kind: 'players'; members: HistoricalMember[] }
}

const byName = (a: HistoricalMember, b: HistoricalMember) =>
	(a.player.ids.username ?? '').localeCompare(b.player.ids.username ?? '', undefined, { sensitivity: 'base' })

const byLeaderThenName = (a: HistoricalMember, b: HistoricalMember) => Number(b.player.isLeader) - Number(a.player.isLeader) || byName(a, b)

// equal infinite ratios would otherwise subtract to NaN
function compareNumbers(a: number, b: number) {
	return a === b ? 0 : a < b ? -1 : 1
}

// Unassigned last
const bySquadId = (a: HistoricalSquadGroup, b: HistoricalSquadGroup) =>
	a.squad === null ? 1 : b.squad === null ? -1 : a.squad.squadId - b.squad.squadId

type SortKey = Exclude<CHAT.HistoricalTeamsSort['key'], 'default'>

// ascending; the caller flips it for a descending sort
function memberComparator(key: SortKey) {
	switch (key) {
		case 'name':
			return byName
		case 'time':
			return (a: HistoricalMember, b: HistoricalMember) => a.timeMs - b.timeMs
		default:
			return (a: HistoricalMember, b: HistoricalMember) => compareNumbers(CHAT.statForSort(a.stats, key), CHAT.statForSort(b.stats, key))
	}
}

// Squads compare by their summed stats. Squad numbers order them for a sort by name or time, which a squad has no
// total of. Unassigned is not a squad, so it stays last in both directions.
function squadComparator(key: SortKey, dir: number) {
	return (a: HistoricalSquadGroup, b: HistoricalSquadGroup) => {
		if (a.squad === null || b.squad === null) return bySquadId(a, b)
		if (key === 'name' || key === 'time') return dir * bySquadId(a, b)
		return dir * compareNumbers(CHAT.statForSort(a.score, key), CHAT.statForSort(b.score, key)) || bySquadId(a, b)
	}
}

function layoutTeam(squads: HistoricalSquadGroup[], sort: CHAT.HistoricalTeamsSort): SortedHistoricalTeam['layout'] {
	if (sort.key === 'default') {
		return { kind: 'squads', squads: squads.map((group) => ({ ...group, members: group.members.toSorted(byLeaderThenName) })) }
	}
	const dir = sort.desc ? -1 : 1
	const compareMembers = memberComparator(sort.key)
	const members = (a: HistoricalMember, b: HistoricalMember) => dir * compareMembers(a, b) || byName(a, b)
	switch (sort.scope) {
		case 'squads':
			return {
				kind: 'squads',
				squads: squads
					.toSorted(squadComparator(sort.key, dir))
					.map((group) => ({ ...group, members: group.members.toSorted(members) })),
			}
		case 'players':
			return { kind: 'players', members: squads.flatMap((group) => group.members).sort(members) }
		default:
			assertNever(sort.scope)
	}
}

// Keeps the squads with a member the filters leave, and only those members. Scores stay those of the whole squad.
// `countedOnly` keeps the players the team breakdown counts.
function filterTeam(team: HistoricalTeam, query: string, countedOnly: boolean): HistoricalSquadGroup[] {
	const searching = query.trim() !== ''
	if (!searching && !countedOnly) return team.squads
	const result: HistoricalSquadGroup[] = []
	for (const group of team.squads) {
		let members = countedOnly ? group.members.filter((m) => m.eligible) : group.members
		if (searching) {
			const matched = TeamsPanelPrt.matchPlayersBySearch(
				members.map((m) => m.player),
				query,
			)
			members = members.filter((_, i) => matched.has(i))
		}
		if (members.length > 0) result.push({ ...group, members })
	}
	return result
}

function sortTeam(team: HistoricalTeam, sort: CHAT.HistoricalTeamsSort, query: string, countedOnly: boolean): SortedHistoricalTeam {
	const squads = filterTeam(team, query, countedOnly)
	return {
		display: team.display,
		playerCount: team.playerCount,
		shownCount: squads.reduce((n, group) => n + group.members.length, 0),
		layout: layoutTeam(squads, sort),
	}
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
	const teams = RSel.memoizeFactory((historicalEvents: CHAT.EventEnriched[] | null) =>
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
						squad: null,
					}
					const lastSquadId = attr.lastSquadByTeam[teamId - 1]
					// an unresolvable squad reference lands the player in Unassigned rather than a second phantom group
					const squadId = lastSquadId !== null && squadsById.has(lastSquadId) ? lastSquadId : null
					if (squadId !== null) member.squad = squadsById.get(squadId)!
					const group = groups[teamId - 1]
					if (!group.has(squadId)) group.set(squadId, [])
					group.get(squadId)!.push(member)
				}

				return teamDisplays.map((display, teamIdx): HistoricalTeam => {
					const group = groups[teamIdx]
					const squads: HistoricalSquadGroup[] = [...group.entries()]
						.map(([squadId, members]): HistoricalSquadGroup => ({
							squad: squadId === null ? null : (squadsById.get(squadId) ?? null),
							members,
							score: CHAT.sumPlayerStats(members.map((m) => m.stats)),
						}))
						.sort(bySquadId)
					return { display, playerCount: [...group.values()].reduce((n, members) => n + members.length, 0), squads }
				}) as [HistoricalTeam, HistoricalTeam]
			},
		),
	)

	export const sortedTeams = RSel.memoizeFactory((historicalEvents: CHAT.EventEnriched[] | null) =>
		RSel.createSelector(
			[
				teams(historicalEvents),
				(...[store]: Inputs) => ChatPrt.Sel.historicalTeamsSort(store),
				(...[store]: Inputs) => ChatPrt.Sel.historicalTeamsSearch(store),
				(...[store]: Inputs) => ChatPrt.Sel.historicalTeamsCountedOnly(store),
			],
			(teams, sort, query, countedOnly): [SortedHistoricalTeam, SortedHistoricalTeam] | null =>
				teams && [sortTeam(teams[0], sort, query, countedOnly), sortTeam(teams[1], sort, query, countedOnly)],
		),
	)
}
