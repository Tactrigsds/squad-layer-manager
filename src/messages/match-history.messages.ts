import * as Msgs from '@/messages/shared'

export const title = Msgs.def(() => ({ text: () => 'Match History' }))

// the page indicator over the table, which names a day rather than a page number
export const noMatchesOnAnyDay = Msgs.def(() => ({ text: () => 'No matches' }))

export const today = Msgs.def(() => ({ text: () => 'Today' }))

export const yesterday = Msgs.def(() => ({ text: () => 'Yesterday' }))

export const timeColumn = Msgs.def(() => ({ text: () => 'Time' }))

export const layerColumn = Msgs.def(() => ({ text: () => 'Layer' }))

export const outcomeColumn = Msgs.def(() => ({ text: () => 'Outcome' }))

export const layerIndicatorsColumn = Msgs.def(() => ({ text: () => 'Layer Indicators' }))

export const setByColumn = Msgs.def(() => ({ text: () => 'Set By' }))

export const winStreak = Msgs.def((length: number) => ({ text: () => `(${length} wins)` }))

export const noMatches = Msgs.def(() => ({ text: () => 'No matches found' }))

export const switchingLayer = Msgs.def(() => ({ text: () => 'Switching to New Layer...' }))

export const postGame = Msgs.def(() => ({ text: () => 'Post-Game' }))

export const inProgress = Msgs.def(() => ({ text: () => 'In progress' }))

export const draw = Msgs.def(() => ({ text: () => 'Draw' }))

export const rowActions = Msgs.def(() => ({
	text: () => 'Left click to view events, Right click for Context Menu, Click+drag to requeue',
}))

// -------- the stats panel and its charts --------

export const statsTitle = Msgs.def(() => ({ text: () => 'Stats' }))

export const noChartData = Msgs.def(() => ({ text: () => 'No data available for charts' }))

export const kdRatio = Msgs.def(() => ({ text: () => 'K/D Ratio:' }))

export const woundRatio = Msgs.def(() => ({ text: () => 'Wound Ratio:' }))

export const teamBreakdowns = Msgs.def(() => ({ text: () => 'Team Breakdowns' }))
