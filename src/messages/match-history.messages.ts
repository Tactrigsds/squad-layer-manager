import * as Msgs from '@/messages/shared'

export const title = Msgs.def('Match History')

// the page indicator over the table, which names a day rather than a page number
export const noMatchesOnAnyDay = Msgs.def('No matches')

export const today = Msgs.def('Today')

export const yesterday = Msgs.def('Yesterday')

export const timeColumn = Msgs.def('Time')

export const layerColumn = Msgs.def('Layer')

export const outcomeColumn = Msgs.def('Outcome')

export const layerIndicatorsColumn = Msgs.def('Layer Indicators')

export const setByColumn = Msgs.def('Set By')

export const winStreak = Msgs.def('({length} wins)', (length: number) => ({ length }))

export const noMatches = Msgs.def('No matches found')

export const switchingLayer = Msgs.def('Switching to New Layer...')

export const postGame = Msgs.def('Post-Game')

export const inProgress = Msgs.def('In progress')

export const draw = Msgs.def('Draw')

export const rowActions = Msgs.def('Left click to view events, Right click for Context Menu, Click+drag to requeue')

// -------- the stats panel and its charts --------

export const statsTitle = Msgs.def('Stats')

export const noChartData = Msgs.def('No data available for charts')

export const kdRatio = Msgs.def('K/D Ratio:')

export const kdBreakdown = Msgs.def('{kills} kills, {deaths} deaths', (kills: number, deaths: number) => ({ kills, deaths }))

export const woundRatio = Msgs.def('Wound Ratio:')

export const woundBreakdown = Msgs.def('{wounds} wounds dealt, {wounded} taken', (wounds: number, wounded: number) => ({
	wounds,
	wounded,
}))

export const teamBreakdowns = Msgs.def('Team Breakdowns')

// what a click on one of the breakdown's bar segments does, said on the segment's own tooltip
export const breakdownFilterHint = Msgs.def('Click to filter the teams panel to {group}', (group: string) => ({ group }))

export const breakdownSelectTeamHint = Msgs.def('Shift-click to select them')

export const breakdownSelectBothHint = Msgs.def('Ctrl+Shift-click to select {group} on both teams', (group: string) => ({ group }))
