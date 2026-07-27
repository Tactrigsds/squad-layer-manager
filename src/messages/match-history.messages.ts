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

export const winStreak = Msgs.def((length: number) => `(${length} wins)`)

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

export const woundRatio = Msgs.def('Wound Ratio:')

export const teamBreakdowns = Msgs.def('Team Breakdowns')
