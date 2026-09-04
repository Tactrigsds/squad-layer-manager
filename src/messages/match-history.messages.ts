import { def } from '@/models/messages.models'

export const title = def('Match History')

// the page indicator over the table, which names a day rather than a page number
export const noMatchesOnAnyDay = def('No matches')

export const today = def('Today')

export const yesterday = def('Yesterday')

export const timeColumn = def('Time')

export const layerColumn = def('Layer')

export const outcomeColumn = def('Outcome')

export const layerIndicatorsColumn = def('Layer Indicators')

export const setByColumn = def('Set By')

export const noMatches = def('No matches found')

export const switchingLayer = def('Switching to New Layer...')

export const postGame = def('Post-Game')

export const inProgress = def('In progress')

export const draw = def('Draw')

export const rowActions = def('Left click to view events, Right click for Context Menu, Click+drag to requeue')

// -------- the stats panel and its charts --------

export const statsTitle = def('Stats')

export const noChartData = def('No data available for charts')

export const kdRatio = def('K/D Ratio:')

export const kdBreakdown = def('{kills} kills, {deaths} deaths', (kills: number, deaths: number) => ({ kills, deaths }))

export const woundRatio = def('Wound Ratio:')

export const woundBreakdown = def('{wounds} wounds dealt, {wounded} taken', (wounds: number, wounded: number) => ({
	wounds,
	wounded,
}))

export const teamBreakdowns = def('Teams Breakdown')

// the breakdown's own help, behind the "?" beside its heading rather than on every segment's tooltip

export const breakdownDescription = def(
	'Everyone on the server right now, split by team and by the groups of the chosen grouping. A player no rule matches counts as Other.',
)

export const breakdownDescriptionHistorical = def(
	'Everyone who played this match, split by the team they spent the most time on and by the groups of the chosen grouping. Players under the team attribution thresholds are left out; the Teams view in the activity panel shows the full roster with them flagged.',
)

export const breakdownFilterHint = def('Click a segment to filter the teams panel to its group')

export const breakdownSelectTeamHint = def("Shift-click to also select that team's players in it")

export const breakdownSelectBothHint = def('Ctrl+Shift-click to select the group on both teams')

export const breakdownUnmatchedGroups = def('{count} unmatched', (count: number) => ({ count }))
