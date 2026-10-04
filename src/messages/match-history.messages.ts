import { def } from '@/models/messages.models'

export const title = def('Match History')

// the page indicator over the table, which names a day rather than a page number
export const noMatchesOnAnyDay = def('No matches')

export const today = def('Today')

export const yesterday = def('Yesterday')

export const timeColumn = def('Time')

export const layerColumn = def('Layer')

export const outcomeColumn = def('Outcome')

// separates the two teams on a phone row, where they share a line instead of taking a column each
export const versus = def('vs')

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

// the rows of the scoreline tooltip on a match history row, one column per team
export const kdRatio = def('K/D')

export const woundRatio = def('W/D')

export const killsDealt = def('Kills')

export const woundsDealt = def('Wounds')

export const deathsSuffered = def('Deaths')

export const scoreline = def('Scoreline')

export const teamBreakdowns = def('Teams Breakdown')

// the panel that holds the teams breakdown, the scoreline and the population chart, one per tab
export const chartsTitle = def('Charts')

// "Teams Breakdown" rather than "Teams", which would read as the queue and teams panel's own tab beside it
export const chartsTab = def(
	'{tab, select, teams {Teams Breakdown} scoreline {Scoreline} population {Population} other {{tab}}}',
	(tab: 'teams' | 'scoreline' | 'population') => ({ tab }),
)

export const chartWindowTitle = def(
	'{tab, select, teams {Teams Breakdown} scoreline {Scoreline} population {Population} other {{tab}}}',
	(tab: 'teams' | 'scoreline' | 'population') => ({ tab }),
)

export const openChartInWindow = def('Open in a window')

// in the panel while its chart is open in a window of its own
export const chartPoppedOut = def('This chart is open in its own window.')

export const returnChartToPanel = def('Return to panel')

export const scorelineMetric = def(
	'{metric, select, kills {Kills} deaths {Deaths} lead {Kill lead} other {{metric}}}',
	(metric: 'kills' | 'deaths' | 'lead') => ({ metric }),
)

export const scorelineDescription = def(
	"Each team's kills, deaths and wounds in this match, and the chosen one over time. Kill lead is how far one team's kills are ahead of the other's, shaded in the leading team's colour. Teamkills and suicides count as deaths but not as kills.",
)

export const tickets = def('Tickets')

export const winner = def('Won')

// in the tickets slot until the round is over
export const ticketsPending = def('Squad reports tickets when the round ends.')

export const noCombatYet = def('No kills yet')

export const populationRange = def('{range, select, match {This match} other {{range}}}', (range: 'match' | '6h' | '24h' | '7d') => ({
	range,
}))

export const populationSplit = def(
	'{split, select, activity {Activity} teams {Teams} stats {Stats} other {{split}}}',
	(split: 'activity' | 'teams' | 'stats') => ({ split }),
)

// the names of the population chart's two groups of pills, for screen readers
export const populationRangeLabel = def('Range')

export const populationSplitLabel = def('Split')

export const populationScaleLabel = def('Scale')

export const populationScale = def('{scale, select, max {Max pop} fitted {Fitted} other {{scale}}}', (scale: 'max' | 'fitted') => ({
	scale,
}))

export const populationPlayers = def('Players')

export const populationActive = def('Active')

export const populationIdle = def('Idle')

export const populationMatchStart = def('Match start')

export const populationRoundEnd = def('Round end')

export const populationDescription = def(
	'How many players were on the server over time. Pick Activity to split the players into active and idle players, or Teams for a line per team.',
)

export const populationIdleRule = def(
	'A player in a squad or in a vehicle is never idle. Anyone else is idle after {minutes} minutes without a kill, wound, death, chat message, or squad, team, role or vehicle change.',
	(minutes: number) => ({ minutes }),
)

export const populationRangeHint = def(
	'Each point averages the players over a few minutes. A solid line marks where a match started and a dashed line where its round ended. Click a match to select it.',
)

// matches the backfill has yet to sample, shown while a range is filling in
export const populationPending = def('{count, plural, one {# match} other {# matches}} in this range not counted yet', (count: number) => ({
	count,
}))

export const noPlayersYet = def('No players yet')

// the population chart's Stats view: one figure per entry, over everything the chosen range covers

export const populationStat = def(
	'{stat, select, peak {Peak} low {Lowest} average {Average} median {Median} full {Time full} idle {Idle} gap {Team gap} joins {Joins} leaves {Leaves} churn {Churn} matches {Matches} other {{stat}}}',
	(stat: 'peak' | 'low' | 'average' | 'median' | 'full' | 'idle' | 'gap' | 'joins' | 'leaves' | 'churn' | 'matches') => ({ stat }),
)

export const populationStatAt = def('at {time}', (time: string) => ({ time }))

export const populationStatPercent = def('{value}%', (value: string) => ({ value }))

export const populationStatPerHour = def('{value} per hour', (value: string) => ({ value }))

export const populationStatFullAt = def('at {cap} players', (cap: number) => ({ cap }))

export const populationStatIdleDetail = def('of the players, on average')

export const populationStatGapDetail = def('largest {gap}', (gap: number) => ({ gap }))

export const populationStatChurnDetail = def('of the players leave each hour')

export const populationStatsHint = def(
	'Team gap is the difference between the two teams’ player counts. Churn is the players who leave in an hour, as a share of the average player count. Over a range of several hours the median is taken over a few minutes at a time.',
)

// the elapsed time a tooltip on the scoreline or population chart is for
export const matchTime = def('{time} into the match', (time: string) => ({ time }))

// the breakdown's own help, behind the "?" beside its heading rather than on every segment's tooltip

export const breakdownDescription = def(
	'Everyone on the server right now, split by team and by the groups of the chosen grouping mode. A player no rule matches counts as Other.',
)

export const breakdownDescriptionHistorical = def(
	'Everyone who played this match, split by the team they spent the most time on and by the groups of the chosen grouping mode. Players under the team attribution thresholds are left out; the Teams view in the activity panel shows the full roster with them flagged.',
)

export const breakdownFilterHint = def('Click a segment to filter the teams panel to its group')

export const breakdownSelectTeamHint = def("Shift-click to also select that team's players in it")

export const breakdownSelectBothHint = def('Ctrl+Shift-click to select the group on both teams')

export const breakdownUnmatchedGroups = def('{count} unmatched', (count: number) => ({ count }))

export const showMoreMatches = def('Show {count} more', (count: number) => ({ count }))

export const minutesAgo = def('{count, plural, one {# minute ago} other {# minutes ago}}', (count: number) => ({ count }))

export const hoursAgo = def('{count, plural, one {# hour ago} other {# hours ago}}', (count: number) => ({ count }))

// a match's start as time since, then how long it ran
export const startedAndLasted = def('{ago} - {minutes, plural, one {# minute} other {# minutes}}', (ago: string, minutes: number) => ({
	ago,
	minutes,
}))

export const startedUnknownLength = def('{ago} - unknown length', (ago: string) => ({ ago }))

// one team's result in a scoreline, as a single letter
export const resultMark = def('{won, select, yes {W} other {L}}', (won: boolean) => ({ won: won ? 'yes' : 'no' }))
