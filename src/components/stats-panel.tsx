import { useQuery } from '@tanstack/react-query'
import * as Icons from 'lucide-react'
import React from 'react'

import { LineChart } from '@/components/charts/line-chart'
import { useMeasuredWidth } from '@/components/charts/measure'
import { IdleSwatch, PopulationChart as PopulationChartSvg } from '@/components/charts/population-chart'
import { StackedBarChart } from '@/components/charts/stacked-bar-chart'
import HistoricalMatchBanner from '@/components/historical-match-banner'
import { TabBar } from '@/components/tab-bar'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import * as ChatPrt from '@/frame-partials/chat.partial'
import * as TeamsPanelPrt from '@/frame-partials/teams-panel.partial'
import * as SquadServerFrame from '@/frames/squad-server.frame'
import * as Chart from '@/lib/chart'
import * as DH from '@/lib/display-helpers'
import { assertNever } from '@/lib/type-guards'
import { cn } from '@/lib/utils'
import * as Zus from '@/lib/zustand'
import * as APP_Msgs from '@/messages/app.messages'
import * as MsgFmt from '@/messages/format'
import * as MH_Msgs from '@/messages/match-history.messages'
import * as PG_Msgs from '@/messages/player-groupings.messages'
import * as SM_Msgs from '@/messages/squad.messages'
import * as UI_Msgs from '@/messages/ui.messages'
import type * as CHAT from '@/models/chat.models'
import * as MH from '@/models/match-history.models'
import * as Pop from '@/models/population.models'
import * as StatsModels from '@/models/stats-panel.models'
import * as BattlemetricsClient from '@/systems/battlemetrics.client'
import * as ClientOnlySettings from '@/systems/client-only-settings.client'
import * as MatchHistoryClient from '@/systems/match-history.client'
import { tr } from '@/systems/messages.client'
import * as SettingsClient from '@/systems/settings.client'
import * as SquadServerClient from '@/systems/squad-server.client'

import { closeChartWindow, useChartPoppedOut, useOpenChartWindow } from './charts-window.helpers'

void import('@/components/charts-window')

// The Charts panel: one chart at a time behind folder tabs. `wide` is the two-column dashboard's form, where the two
// teams of the breakdown face each other as mirrored bars. Narrow stacks them, for a side column or a phone.
//
// A chart holds its space while its data loads, so the panel does not change height when the data arrives.
const trTooltip = tr.withTags({ label: (chunks) => <span className="font-semibold">{chunks}</span> })

// the scoreline chart's height in the panel; in a window it fills the window instead
const SCORELINE_CHART_HEIGHT = 150

export default function StatsPanel(props: { stores: SquadServerFrame.KeyProp; wide?: boolean; className?: string }) {
	const tab = Zus.useStore(ClientOnlySettings.Store, ClientOnlySettings.Sel.chartsTab)
	const idPrefix = React.useId()
	const tabId = (value: ClientOnlySettings.ChartsTab) => `${idPrefix}-tab-${value}`
	const panelId = (value: ClientOnlySettings.ChartsTab) => `${idPrefix}-panel-${value}`

	return (
		<section data-tour="teams-breakdown" aria-labelledby={`${idPrefix}-title`} className={cn('flex flex-col w-full', props.className)}>
			<TabBar
				tabs={ClientOnlySettings.CHARTS_TABS.map((value) => ({ value, label: tr.text(MH_Msgs.chartsTab(value)) }))}
				value={tab}
				onChange={ClientOnlySettings.Actions.setChartsTab}
				tabId={tabId}
				panelId={panelId}
				tourId={(value) => `charts-tab-${value}`}
				leading={
					<h3 id={`${idPrefix}-title`} className="fd-cond font-bold flex items-center gap-1.5 min-w-0">
						<Icons.BarChart2 className="h-3.5 w-3.5 shrink-0" />
						<span className="truncate">{tr.text(MH_Msgs.chartsTitle())}</span>
					</h3>
				}
			/>
			<div role="tabpanel" id={panelId(tab)} aria-labelledby={tabId(tab)} className="fd-tabbody flex flex-col min-w-0">
				<PanelChart stores={props.stores} tab={tab} wide={props.wide} />
			</div>
		</section>
	)
}

// The chart in the panel, or while it is open in its window, a note saying so with a button that brings it back.
function PanelChart(props: { stores: SquadServerFrame.KeyProp; tab: ClientOnlySettings.ChartsTab; wide?: boolean }) {
	const serverId = props.stores.squadServer!.serverId
	const poppedOut = useChartPoppedOut(serverId, props.tab)
	if (!poppedOut) return <ChartBody stores={props.stores} tab={props.tab} wide={props.wide} />
	return (
		<div className="flex flex-col items-center justify-center gap-2 px-2.5 py-6 text-center">
			<p className="text-sm text-text-3">{tr.text(MH_Msgs.chartPoppedOut())}</p>
			<button type="button" className="fd-btn fd-btn-sm" onClick={() => closeChartWindow(serverId, props.tab)}>
				<Icons.PanelTopClose />
				{tr.text(MH_Msgs.returnChartToPanel())}
			</button>
		</div>
	)
}

/**
 * One chart with its controls and the historical match banner. The panel and the chart's window both render it.
 * `inWindow` lets the chart fill the space it is given instead of holding the panel's fixed height.
 */
export function ChartBody(props: {
	stores: SquadServerFrame.KeyProp
	tab: ClientOnlySettings.ChartsTab
	wide?: boolean
	inWindow?: boolean
}) {
	const squadServer = props.stores.squadServer!
	const selectedMatchOrdinal = Zus.useStore(squadServer, ChatPrt.Sel.selectedMatchOrdinal)
	const historicalEventsQuery = useQuery(MatchHistoryClient.matchEventsQueryOptions(squadServer.serverId, selectedMatchOrdinal))
	const historicalEvents = historicalEventsQuery.data?.events ?? null

	let chart: React.ReactNode
	switch (props.tab) {
		case 'teams':
			chart = <TeamsChart stores={props.stores} historicalEvents={historicalEvents} wide={props.wide} inWindow={props.inWindow} />
			break
		case 'scoreline':
			chart = <ScorelineChart stores={props.stores} historicalEvents={historicalEvents} inWindow={props.inWindow} />
			break
		case 'population':
			chart = <PopulationChart stores={props.stores} historicalEvents={historicalEvents} inWindow={props.inWindow} />
			break
		default:
			assertNever(props.tab)
	}
	return (
		<div className={cn('flex flex-col min-w-0', props.inWindow && 'flex-1 min-h-0')}>
			<HistoricalMatchBanner stores={props.stores} returnToLive className="shrink-0" />
			{chart}
		</div>
	)
}

// The row above a chart: its own controls first, then its legend, then help and the pop-out button. Each group
// wraps as a unit when the row runs out of room. `legendBelow` gives the legend a row of its own under the rest, for
// the narrow form, so it does not push the buttons onto a row of their own.
function ChartToolbar(props: {
	stores: SquadServerFrame.KeyProp
	tab: ClientOnlySettings.ChartsTab
	inWindow?: boolean
	controls?: React.ReactNode
	legend?: React.ReactNode
	legendBelow?: boolean
	help: React.ReactNode
}) {
	const openWindow = useOpenChartWindow()
	return (
		<div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-2.5 pt-1.5 min-w-0">
			{props.controls}
			{props.legend && (
				<div className={cn('flex min-w-0 items-center', props.legendBelow ? 'order-last basis-full' : 'grow basis-48')}>
					{props.legend}
				</div>
			)}
			<span className="flex items-center gap-0.5 ms-auto">
				{props.help}
				{!props.inWindow && (
					<Tooltip>
						<TooltipTrigger asChild>
							<button
								type="button"
								data-tour={`chart-pop-out-${props.tab}`}
								className="fd-btn fd-btn-ghost fd-btn-ico fd-btn-sm"
								aria-label={tr.text(MH_Msgs.openChartInWindow())}
								onClick={(e) => {
									const panel = e.currentTarget.closest<HTMLElement>('[role="tabpanel"]')
									const box = panel?.getBoundingClientRect()
									const size = box ? { width: box.width, height: box.height } : undefined
									// anchored below the panel rather than the button, so the window leaves the note that stands in for
									// the chart, and its button, in view
									openWindow({ stores: props.stores, tab: props.tab, size }, panel ?? e.currentTarget)
								}}
							>
								<Icons.PictureInPicture2 />
							</button>
						</TooltipTrigger>
						<TooltipContent>{tr.text(MH_Msgs.openChartInWindow())}</TooltipContent>
					</Tooltip>
				)}
			</span>
		</div>
	)
}

function HelpButton(props: { children: React.ReactNode }) {
	return (
		<Tooltip help>
			<TooltipTrigger asChild>
				<button type="button" className="fd-btn fd-btn-ghost fd-btn-ico fd-btn-sm" aria-label={tr.text(SM_Msgs.help())}>
					<Icons.CircleHelp />
				</button>
			</TooltipTrigger>
			<TooltipContent className="max-w-xs space-y-1.5">{props.children}</TooltipContent>
		</Tooltip>
	)
}

// ---- Teams ----

function TeamsChart(props: {
	stores: SquadServerFrame.KeyProp
	historicalEvents: CHAT.EventEnriched[] | null
	wide?: boolean
	inWindow?: boolean
}) {
	const squadServer = props.stores.squadServer!
	const serverId = squadServer.serverId
	const selectedMatchOrdinal = Zus.useStore(squadServer, ChatPrt.Sel.selectedMatchOrdinal)
	const groupings = Zus.useStore_Susp(
		squadServer,
		MatchHistoryClient.currentMatch$(serverId),
		MatchHistoryClient.recentMatches$(serverId),
		ClientOnlySettings.Store,
		BattlemetricsClient.playerBmData$,
		BattlemetricsClient.Store,
		SettingsClient.PublicSettingsStore,
		StatsModels.Sel.groupings,
	)
	const hasData = Zus.useStore_Susp(
		squadServer,
		MatchHistoryClient.currentMatch$(serverId),
		MatchHistoryClient.recentMatches$(serverId),
		ClientOnlySettings.Store,
		BattlemetricsClient.playerBmData$,
		BattlemetricsClient.Store,
		SettingsClient.PublicSettingsStore,
		StatsModels.Sel.hasData(props.historicalEvents),
	)
	const [legendSlot, setLegendSlot] = React.useState<HTMLElement | null>(null)
	// a window picks its layout from its own width; the panel is told by the dashboard
	const [body, setBody] = React.useState<HTMLDivElement | null>(null)
	const bodyWidth = useMeasuredWidth(props.inWindow ? body : null)
	const wide = props.inWindow ? bodyWidth >= 520 : !!props.wide
	const interactive = selectedMatchOrdinal === null

	const controls = hasData && groupings.ids.length > 1 && (
		<span className="flex flex-wrap gap-0.5">
			{groupings.ids.map((groupingId) => (
				<button
					type="button"
					key={groupingId}
					onClick={() => BattlemetricsClient.Actions.setSelectedGroupingId(groupingId || null)}
					className="fd-pill"
					data-state={groupings.active === groupingId ? 'on' : 'off'}
				>
					{tr.text(PG_Msgs.groupingName(groupingId))}
				</button>
			))}
		</span>
	)

	return (
		<>
			<ChartToolbar
				stores={props.stores}
				tab="teams"
				inWindow={props.inWindow}
				controls={controls}
				legend={<span ref={setLegendSlot} className="flex items-center min-w-0" />}
				legendBelow={!wide}
				help={
					<HelpButton>
						<p>{tr.text(interactive ? MH_Msgs.breakdownDescription() : MH_Msgs.breakdownDescriptionHistorical())}</p>
						{interactive && (
							<ul className="text-text-2">
								<li>{tr.text(MH_Msgs.breakdownFilterHint())}</li>
								<li>{tr.text(MH_Msgs.breakdownSelectTeamHint())}</li>
								<li>{tr.text(MH_Msgs.breakdownSelectBothHint())}</li>
							</ul>
						)}
					</HelpButton>
				}
			/>
			<div
				ref={setBody}
				data-tour="teams-breakdown-chart"
				className="px-2.5 pt-1 pb-1.5"
				style={{ minHeight: Chart.stackedBarsHeight(2, wide) + 10 }}
			>
				{hasData ? (
					<TeamBreakdown stores={props.stores} historicalEvents={props.historicalEvents} wide={wide} legendPortal={legendSlot} />
				) : (
					<div className="text-text-3 text-sm text-center py-3">{tr.text(MH_Msgs.noChartData())}</div>
				)}
			</div>
		</>
	)
}

function TeamBreakdown(props: {
	stores: SquadServerFrame.KeyProp
	historicalEvents: CHAT.EventEnriched[] | null
	wide: boolean
	legendPortal: HTMLElement | null
}) {
	const squadServer = props.stores.squadServer!
	const serverId = squadServer.serverId
	const selectedMatchOrdinal = Zus.useStore(squadServer, ChatPrt.Sel.selectedMatchOrdinal)
	const currentMatch$ = MatchHistoryClient.currentMatch$(serverId)
	const recentMatches$ = MatchHistoryClient.recentMatches$(serverId)
	const breakdown = Zus.useStore_Susp(
		squadServer,
		currentMatch$,
		recentMatches$,
		ClientOnlySettings.Store,
		BattlemetricsClient.playerBmData$,
		BattlemetricsClient.Store,
		SettingsClient.PublicSettingsStore,
		StatsModels.Sel.breakdown(props.historicalEvents),
	)
	const teams = Zus.useStore_Susp(squadServer, currentMatch$, recentMatches$, ClientOnlySettings.Store, StatsModels.Sel.teams)
	if (!breakdown) return null

	// series a real player on the server actually matched; the rest still exist in the grouping config but would
	// only ever render empty segments, so they move behind the "N unmatched" popover instead
	const keptIndices = breakdown.series
		.map((_, seriesIndex) => seriesIndex)
		.filter((seriesIndex) => breakdown.rows.some((row) => row.values[seriesIndex] > 0))
	const chartSeries = keptIndices.map((i) => breakdown.series[i])
	const chartRows = breakdown.rows.map((row) => ({ ...row, values: keptIndices.map((i) => row.values[i]) }))
	const unmatchedSeries = breakdown.series.filter((_, i) => !keptIndices.includes(i))

	// A segment names a group on one team, which is the pair the teams panel filters and selects by. Plain click
	// filters, shift adds that team's members to the selection, ctrl+shift takes the group on both teams. The teams
	// panel only shows the live roster, so a historical chart's segments are not clickable.
	const onSegmentClick =
		selectedMatchOrdinal !== null
			? undefined
			: (datum: Chart.Datum, modifiers: { shift: boolean; ctrl: boolean }) => {
					const originalIndex = keptIndices[datum.seriesIndex]
					let group = chartSeries[datum.seriesIndex].label
					if (group === breakdown.ungroupedLabel) group = TeamsPanelPrt.FILTER_NONE
					if (modifiers.shift) {
						const rows = modifiers.ctrl ? breakdown.members : [breakdown.members[datum.rowIndex]]
						SquadServerFrame.Actions.selectPlayerIds(
							props.stores,
							rows.flatMap((row) => row[originalIndex].map((member) => member.id)),
						)
					} else {
						// clicking the group the panel is already filtered to lifts the filter, so the segment is its own undo. A
						// selection always wants its players on screen, so those variants only ever set it.
						const filtered = Zus.getState(squadServer, TeamsPanelPrt.Sel.groupFilter)
						TeamsPanelPrt.Actions.setGroupFilter({ teamsPanel: squadServer }, !modifiers.shift && filtered === group ? null : group)
					}
					SquadServerClient.PrimaryPanelActions.showTeams()
					// on a single-column layout the teams panel is behind a tab of its own
					SquadServerClient.DashboardTabActions.setTab('teams')
				}

	const renderTooltip = (datum: Chart.Datum) => {
		const series = chartSeries[datum.seriesIndex]
		const members = breakdown.members[datum.rowIndex][keptIndices[datum.seriesIndex]]
		return (
			<div className="flex flex-col gap-1">
				<span className="font-semibold">{breakdown.rows[datum.rowIndex].label}</span>
				<span className="flex items-center gap-1.5">
					<span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: series.color }} />
					<span>{trTooltip.richText(UI_Msgs.labelValue(series.label, datum.value))}</span>
				</span>
				{members.length > 0 && <span className="text-text-2">{MsgFmt.formatList(members.map((member) => member.name))}</span>}
			</div>
		)
	}

	const renderLegendTooltip = (seriesIndex: number) => {
		const originalIndex = keptIndices[seriesIndex]
		return (
			<div className="flex flex-col gap-0.5">
				<span className="font-semibold">{chartSeries[seriesIndex].label}</span>
				{breakdown.rows.map((row) => (
					<span key={row.key}>
						{row.label}: {row.values[originalIndex]}
					</span>
				))}
			</div>
		)
	}

	const unmatchedGroupsButton = unmatchedSeries.length > 0 && (
		<Popover>
			<Tooltip help>
				<TooltipTrigger asChild>
					<PopoverTrigger asChild>
						<button
							type="button"
							data-tour="breakdown-unmatched"
							aria-label={tr.text(MH_Msgs.breakdownUnmatchedGroups(unmatchedSeries.length))}
							className="fd-btn fd-btn-ghost fd-btn-ico fd-btn-sm"
						>
							<Icons.Ellipsis />
						</button>
					</PopoverTrigger>
				</TooltipTrigger>
				<TooltipContent>{tr.text(MH_Msgs.breakdownUnmatchedGroups(unmatchedSeries.length))}</TooltipContent>
			</Tooltip>
			<PopoverContent className="w-56 p-2">
				<ul className="flex flex-col gap-1">
					{unmatchedSeries.map((series) => (
						<li key={series.key} className="flex items-center gap-1.5 text-xs">
							<span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: series.color }} />
							{series.label}
						</li>
					))}
				</ul>
			</PopoverContent>
		</Popover>
	)

	return (
		<StackedBarChart
			rows={chartRows}
			series={chartSeries}
			rowColors={teams.map((team) => team.color)}
			sideBySide={props.wide}
			legendPortal={props.legendPortal}
			ariaLabel={tr.text(MH_Msgs.teamBreakdowns())}
			renderTooltip={renderTooltip}
			renderLegendTooltip={renderLegendTooltip}
			onSegmentClick={onSegmentClick}
			legendExtra={unmatchedGroupsButton}
		/>
	)
}

// ---- Scoreline ----

function ScorelineChart(props: { stores: SquadServerFrame.KeyProp; historicalEvents: CHAT.EventEnriched[] | null; inWindow?: boolean }) {
	const squadServer = props.stores.squadServer!
	const serverId = squadServer.serverId
	const currentMatch$ = MatchHistoryClient.currentMatch$(serverId)
	const recentMatches$ = MatchHistoryClient.recentMatches$(serverId)
	const scoreline = Zus.useStore_Susp(
		squadServer,
		currentMatch$,
		recentMatches$,
		ClientOnlySettings.Store,
		StatsModels.Sel.scoreline(props.historicalEvents),
	)
	const teams = Zus.useStore_Susp(squadServer, currentMatch$, recentMatches$, ClientOnlySettings.Store, StatsModels.Sel.teams)
	const metric = Zus.useStore(ClientOnlySettings.Store, ClientOnlySettings.Sel.scorelineMetric)

	const controls = (
		<span role="group" aria-label={tr.text(MH_Msgs.scoreline())} className="flex flex-wrap gap-0.5">
			{ClientOnlySettings.SCORELINE_METRICS.map((value) => (
				<button
					type="button"
					key={value}
					onClick={() => ClientOnlySettings.Actions.setScorelineMetric(value)}
					className="fd-pill"
					data-state={metric === value ? 'on' : 'off'}
				>
					{tr.text(MH_Msgs.scorelineMetric(value))}
				</button>
			))}
		</span>
	)

	return (
		<div className={cn('flex flex-col min-w-0', props.inWindow && 'flex-1 min-h-0')}>
			<ChartToolbar
				stores={props.stores}
				tab="scoreline"
				inWindow={props.inWindow}
				controls={controls}
				help={
					<HelpButton>
						<p>{tr.text(MH_Msgs.scorelineDescription())}</p>
					</HelpButton>
				}
			/>
			<ScorelineTable scoreline={scoreline} teams={teams} />
			<div
				className={cn('px-1.5 pb-1.5', props.inWindow ? 'flex-1 min-h-[120px]' : 'shrink-0')}
				style={props.inWindow ? undefined : { height: SCORELINE_CHART_HEIGHT }}
			>
				{scoreline && MH.hasCombat(scoreline.stats) ? (
					<LineChart
						series={scoreline.chart.series}
						xMax={scoreline.chart.xMax}
						xTicks={minuteTicks}
						formatX={formatElapsed}
						signed={scoreline.chart.signed ? { above: teams[0].color, below: teams[1].color } : undefined}
						ariaLabel={tr.text(MH_Msgs.scorelineMetric(metric))}
						renderTooltip={(x, values) => (
							<ScorelineTooltip
								x={x}
								values={values}
								series={scoreline.chart.series}
								teams={teams}
								signed={scoreline.chart.signed}
							/>
						)}
					/>
				) : (
					<div className="h-full flex items-center justify-center text-text-3 text-sm">
						{scoreline ? tr.text(MH_Msgs.noCombatYet()) : <span className="fd-spin size-5!" />}
					</div>
				)}
			</div>
		</div>
	)
}

// Each team's totals: one row per team, one column per figure, so the table keeps its height at any width.
function ScorelineTable(props: { scoreline: StatsModels.Scoreline | null; teams: [StatsModels.TeamDisplay, StatsModels.TeamDisplay] }) {
	const { scoreline } = props
	const rows = props.teams.map((team, i) => {
		const stats = scoreline ? (i === 0 ? scoreline.stats.team1 : scoreline.stats.team2) : null
		return { key: `team${i + 1}`, team, stats, tickets: scoreline?.tickets?.[i] ?? null, won: scoreline?.winner === i + 1 }
	})
	const cell = 'px-1.5 py-0.5 text-end tabular-nums font-mono whitespace-nowrap'
	const head = 'px-1.5 py-0.5 text-end font-medium text-text-3 whitespace-nowrap'
	return (
		// contained, or the table's own width would still widen whatever sizes to its content around the panel
		<div className="px-2.5 pt-1 overflow-x-auto [contain:inline-size]">
			<table className="w-full max-w-xl text-xs">
				<thead>
					<tr>
						<th />
						<th scope="col" className={head}>
							{tr.text(MH_Msgs.tickets())}
						</th>
						<th scope="col" className={head}>
							{tr.text(MH_Msgs.killsDealt())}
						</th>
						<th scope="col" className={head}>
							{tr.text(MH_Msgs.deathsSuffered())}
						</th>
						<th scope="col" className={head}>
							{tr.text(MH_Msgs.kdRatio())}
						</th>
						<th scope="col" className={head}>
							{tr.text(MH_Msgs.woundsDealt())}
						</th>
					</tr>
				</thead>
				<tbody>
					{rows.map((row) => (
						<tr key={row.key}>
							<th scope="row" className="text-start font-semibold py-0.5 pe-1.5">
								<span className="flex items-center gap-1.5 min-w-0 max-w-40">
									<span className="w-2 h-2 rounded-sm shrink-0" style={{ backgroundColor: row.team.color }} />
									<span className="truncate" title={row.team.label}>
										{row.team.label}
									</span>
								</span>
							</th>
							<td className={cell}>
								{row.tickets !== null ? (
									<span className="inline-flex items-center gap-1 justify-end">
										{row.won && <b className="text-ok">{tr.text(MH_Msgs.resultMark(true))}</b>}
										{row.tickets}
									</span>
								) : (
									<Tooltip>
										<TooltipTrigger asChild>
											<span className="text-text-3 cursor-default">-</span>
										</TooltipTrigger>
										<TooltipContent>{tr.text(MH_Msgs.ticketsPending())}</TooltipContent>
									</Tooltip>
								)}
							</td>
							<td className={cell}>{row.stats?.kills ?? '-'}</td>
							<td className={cell}>{row.stats?.deaths ?? '-'}</td>
							<td className={cell}>{row.stats ? DH.formatRatio(row.stats.kills, row.stats.deaths) : '-'}</td>
							<td className={cell}>{row.stats?.wounds ?? '-'}</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	)
}

function ScorelineTooltip(props: {
	x: number
	values: (number | undefined)[]
	series: Chart.LineSeries[]
	teams: [StatsModels.TeamDisplay, StatsModels.TeamDisplay]
	signed: boolean
}) {
	const time = <span className="font-semibold">{tr.text(MH_Msgs.matchTime(formatElapsed(props.x)))}</span>
	if (props.signed) {
		const lead = props.values[0] ?? 0
		const ahead = lead >= 0 ? props.teams[0] : props.teams[1]
		return (
			<div className="flex flex-col gap-1">
				{time}
				<span className="flex items-center gap-1.5">
					<span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: ahead.color }} />
					<span>{trTooltip.richText(UI_Msgs.labelValue(ahead.label, `+${Math.abs(lead)}`))}</span>
				</span>
			</div>
		)
	}
	return (
		<div className="flex flex-col gap-1">
			{time}
			{props.series.map((series, i) => (
				<span key={series.key} className="flex items-center gap-1.5">
					<span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: series.color }} />
					<span>{trTooltip.richText(UI_Msgs.labelValue(series.label, props.values[i] ?? 0))}</span>
				</span>
			))}
		</div>
	)
}

// ---- Population ----

// taller than the line charts, for the match names above the plot
const POPULATION_CHART_HEIGHT = 190

function PopulationChart(props: { stores: SquadServerFrame.KeyProp; historicalEvents: CHAT.EventEnriched[] | null; inWindow?: boolean }) {
	const squadServer = props.stores.squadServer!
	const serverId = squadServer.serverId
	const range = Zus.useStore(ClientOnlySettings.Store, ClientOnlySettings.Sel.populationRange)
	const split = Zus.useStore(ClientOnlySettings.Store, ClientOnlySettings.Sel.populationSplit)
	const scale = Zus.useStore(ClientOnlySettings.Store, ClientOnlySettings.Sel.populationScale)
	const currentMatch$ = MatchHistoryClient.currentMatch$(serverId)
	const currentMatch = MatchHistoryClient.useCurrentMatch(serverId)
	const rangeQuery = useQuery(MatchHistoryClient.populationQueryOptions(serverId, range === 'match' ? null : range, currentMatch?.ordinal))
	const view = Zus.useStore_Susp(
		squadServer,
		currentMatch$,
		MatchHistoryClient.recentMatches$(serverId),
		ClientOnlySettings.Store,
		SettingsClient.PublicSettingsStore,
		SquadServerClient.serverInfo$(serverId),
		StatsModels.Sel.population(props.historicalEvents, rangeQuery.data ?? null),
	)
	const hasPoints = !!view && view.runs.length > 0

	const controls = (
		<span className="flex flex-wrap gap-x-3 gap-y-0.5">
			<span role="group" aria-label={tr.text(MH_Msgs.populationRangeLabel())} className="flex flex-wrap gap-0.5">
				{ClientOnlySettings.POPULATION_RANGES.map((value) => (
					<button
						type="button"
						key={value}
						onClick={() => ClientOnlySettings.Actions.setPopulationRange(value)}
						className="fd-pill"
						data-state={range === value ? 'on' : 'off'}
					>
						{tr.text(MH_Msgs.populationRange(value))}
					</button>
				))}
			</span>
			<span role="group" aria-label={tr.text(MH_Msgs.populationSplitLabel())} className="flex flex-wrap gap-0.5">
				{ClientOnlySettings.POPULATION_SPLITS.map((value) => (
					<button
						type="button"
						key={value}
						onClick={() => ClientOnlySettings.Actions.setPopulationSplit(value)}
						className="fd-pill"
						data-state={split === value ? 'on' : 'off'}
					>
						{tr.text(MH_Msgs.populationSplit(value))}
					</button>
				))}
			</span>
			{split !== 'stats' && (
				<span role="group" aria-label={tr.text(MH_Msgs.populationScaleLabel())} className="flex flex-wrap gap-0.5">
					{ClientOnlySettings.POPULATION_SCALES.map((value) => (
						<button
							type="button"
							key={value}
							onClick={() => ClientOnlySettings.Actions.setPopulationScale(value)}
							className="fd-pill"
							data-state={scale === value ? 'on' : 'off'}
						>
							{tr.text(MH_Msgs.populationScale(value))}
						</button>
					))}
				</span>
			)}
		</span>
	)

	const swatch = (color: string) => <span className="w-3 h-2.5 rounded-sm shrink-0" style={{ backgroundColor: color }} />
	let legendItems: { key: string; mark: React.ReactNode; label: string }[]
	switch (split) {
		case 'activity':
			legendItems = [
				{ key: 'active', mark: swatch(Pop.COLORS.active), label: tr.text(MH_Msgs.populationActive()) },
				{ key: 'idle', mark: <IdleSwatch />, label: tr.text(MH_Msgs.populationIdle()) },
			]
			break
		case 'teams':
			legendItems = (view?.sideDisplays ?? []).map((side, i) => ({ key: `side${i}`, mark: swatch(side.color), label: side.label }))
			break
		case 'stats':
			legendItems = []
			break
		default:
			assertNever(split)
	}
	if (range !== 'match' && split !== 'stats') {
		legendItems.push(
			{
				key: 'start',
				mark: (
					<svg width={10} height={10} aria-hidden="true" className="shrink-0 text-text-2">
						<line x1={2} y1={0} x2={2} y2={10} stroke="currentColor" strokeWidth={1.5} />
						<path d="M2 0 l5 2.5 l-5 2.5 Z" fill="currentColor" />
					</svg>
				),
				label: tr.text(MH_Msgs.populationMatchStart()),
			},
			{
				key: 'end',
				mark: (
					<svg width={6} height={10} aria-hidden="true" className="shrink-0 text-text-2">
						<line x1={3} y1={0} x2={3} y2={10} stroke="currentColor" strokeWidth={1.5} strokeDasharray="2 2" />
					</svg>
				),
				label: tr.text(MH_Msgs.populationRoundEnd()),
			},
		)
	}
	const legend = (
		<ul className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-text-2 min-w-0">
			{legendItems.map((item) => (
				<li key={item.key} className="flex items-center gap-1.5 min-w-0">
					{item.mark}
					<span className="truncate">{item.label}</span>
				</li>
			))}
		</ul>
	)

	const selectBand = (band: StatsModels.PopulationBand) =>
		void ChatPrt.Actions.setSelectedMatchOrdinal({ chat: squadServer }, band.ordinal === currentMatch?.ordinal ? null : band.ordinal)

	return (
		<div className={cn('flex flex-col min-w-0', props.inWindow && 'flex-1 min-h-0')}>
			<ChartToolbar
				stores={props.stores}
				tab="population"
				inWindow={props.inWindow}
				controls={controls}
				legend={legend}
				help={
					<HelpButton>
						<p>{tr.text(MH_Msgs.populationDescription())}</p>
						<p className="text-text-2">{tr.text(MH_Msgs.populationIdleRule(view?.idleMinutes ?? 10))}</p>
						{range !== 'match' && <p className="text-text-2">{tr.text(MH_Msgs.populationRangeHint())}</p>}
						{split === 'stats' && <p className="text-text-2">{tr.text(MH_Msgs.populationStatsHint())}</p>}
					</HelpButton>
				}
			/>
			<div
				data-tour="population-chart"
				className={cn('px-1.5 pt-1 pb-1.5', props.inWindow ? 'flex-1 min-h-[140px]' : 'shrink-0')}
				style={props.inWindow ? undefined : { height: POPULATION_CHART_HEIGHT }}
			>
				{view && hasPoints && split === 'stats' ? (
					<PopulationStats view={view} />
				) : view && hasPoints ? (
					<PopulationLines
						view={view}
						split={split === 'teams' ? 'teams' : 'activity'}
						yMax={scale === 'max' ? view.cap : undefined}
						showBandStarts={range !== 'match'}
						onSelectBand={range === 'match' ? undefined : selectBand}
					/>
				) : (
					<div className="h-full flex items-center justify-center text-text-3 text-sm">
						{view ? (
							tr.text(MH_Msgs.noPlayersYet())
						) : rangeQuery.isError ? (
							tr.text(APP_Msgs.somethingWentWrong())
						) : (
							<span className="fd-spin size-5!" />
						)}
					</div>
				)}
			</div>
			{view && view.pending > 0 && (
				<p className="px-2.5 pb-1.5 text-xs text-text-3">{tr.text(MH_Msgs.populationPending(view.pending))}</p>
			)}
		</div>
	)
}

// when in the view a time falls, as the view's axis reads it: into the match, or on the clock
function formatPopulationTime(view: StatsModels.PopulationView, time: number) {
	if (view.range === 'match') return tr.text(MH_Msgs.matchTime(formatElapsed(time - view.start)))
	return MsgFmt.formatDate(time, view.range === '6h' ? 'clock' : 'dateTime24')
}

// a figure to one decimal place, which is as fine as an average of whole players is worth reading
function formatFigure(value: number) {
	return MsgFmt.formatNumber(Math.round(value * 10) / 10)
}

function PopulationStats(props: { view: StatsModels.PopulationView }) {
	const { stats, range } = props.view
	const percent = (share: number) => tr.text(MH_Msgs.populationStatPercent(formatFigure(share * 100)))
	const perHour = (value: number) => tr.text(MH_Msgs.populationStatPerHour(formatFigure(value)))
	const at = (time: number) => tr.text(MH_Msgs.populationStatAt(formatPopulationTime(props.view, time)))
	const entries: { key: StatKey; value: string | null; detail?: string }[] = [
		{ key: 'peak', value: stats.peak && String(stats.peak.value), detail: stats.peak ? at(stats.peak.at) : undefined },
		{ key: 'low', value: stats.low && String(stats.low.value), detail: stats.low ? at(stats.low.at) : undefined },
		{ key: 'average', value: stats.average === null ? null : formatFigure(stats.average) },
		{ key: 'median', value: stats.median === null ? null : formatFigure(stats.median) },
		{
			key: 'full',
			value: stats.fullShare === null ? null : percent(stats.fullShare),
			detail: tr.text(MH_Msgs.populationStatFullAt(props.view.cap)),
		},
		{
			key: 'idle',
			value: stats.idleShare === null ? null : percent(stats.idleShare),
			detail: tr.text(MH_Msgs.populationStatIdleDetail()),
		},
		{
			key: 'gap',
			value: stats.gapAverage === null ? null : formatFigure(stats.gapAverage),
			detail: stats.gapMax === null ? undefined : tr.text(MH_Msgs.populationStatGapDetail(stats.gapMax)),
		},
		{ key: 'joins', value: stats.joinsPerHour === null ? null : perHour(stats.joinsPerHour) },
		{ key: 'leaves', value: stats.leavesPerHour === null ? null : perHour(stats.leavesPerHour) },
		{
			key: 'churn',
			value: stats.churnPerHour === null ? null : percent(stats.churnPerHour),
			detail: tr.text(MH_Msgs.populationStatChurnDetail()),
		},
	]
	if (range !== 'match' && stats.matches !== null) entries.push({ key: 'matches', value: String(stats.matches) })
	return (
		<dl className="h-full overflow-y-auto grid grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] content-start gap-x-3 gap-y-2 px-1">
			{entries.map((entry) => (
				<div key={entry.key} className="flex flex-col min-w-0">
					<dt className="text-xs text-text-3 truncate">{tr.text(MH_Msgs.populationStat(entry.key))}</dt>
					<dd className="font-mono text-lg leading-tight">{entry.value ?? '-'}</dd>
					{entry.detail && <dd className="text-xs text-text-3 break-words">{entry.detail}</dd>}
				</div>
			))}
		</dl>
	)
}

type StatKey = Parameters<typeof MH_Msgs.populationStat>[0]

function PopulationLines(props: {
	view: StatsModels.PopulationView
	split: 'activity' | 'teams'
	yMax?: number
	showBandStarts: boolean
	onSelectBand?: (band: StatsModels.PopulationBand) => void
}) {
	const { view } = props
	const elapsed = view.range === 'match'
	const formatX = elapsed
		? (time: number) => formatElapsed(time - view.start)
		: (time: number) => MsgFmt.formatDate(time, view.range === '7d' ? 'weekdayDay' : 'clock')
	const xTicks = elapsed
		? (start: number, end: number, target: number) => minuteTicks(end - start, target).map((offset) => start + offset)
		: clockTicks

	const renderTooltip = (i: number, band: StatsModels.PopulationBand | undefined) => {
		const when = formatPopulationTime(view, view.start + (i + 0.5) * view.bucketMs)
		const row = (label: string, value: number, color?: string, hatched?: boolean) => (
			<span key={label} className="flex items-center justify-between gap-4 text-text-2">
				<span className="flex items-center gap-1.5">
					{hatched ? <IdleSwatch /> : color && <span className="w-2 h-2 rounded-sm shrink-0" style={{ backgroundColor: color }} />}
					{label}
				</span>
				<span className="text-foreground font-mono">{Math.round(value)}</span>
			</span>
		)
		return (
			<div className="flex flex-col gap-0.5 min-w-40">
				<span className="font-semibold">{band ? `${when} · ${band.label}` : when}</span>
				{row(tr.text(MH_Msgs.populationPlayers()), view.total[i])}
				{row(tr.text(MH_Msgs.populationActive()), view.active[i], Pop.COLORS.active)}
				{row(tr.text(MH_Msgs.populationIdle()), view.idle[i], undefined, true)}
				<span className="h-px bg-line-soft my-0.5" />
				{view.sideDisplays.map((side, s) => row(side.label, view.sides[s][i], side.color))}
			</div>
		)
	}

	return (
		<PopulationChartSvg
			view={view}
			split={props.split}
			yMax={props.yMax}
			formatX={formatX}
			xTicks={xTicks}
			showBandStarts={props.showBandStarts}
			onSelectBand={props.onSelectBand}
			renderTooltip={renderTooltip}
			ariaLabel={tr.text(MH_Msgs.chartsTab('population'))}
		/>
	)
}

// clock steps the range axes pick from, the finest that keeps the ticks under the target
const CLOCK_STEPS = [15, 30, 60, 120, 180, 360, 720, 1440, 2880].map((minutes) => minutes * 60_000)

// ticks at round clock times, counted from the local midnight before `start`
function clockTicks(start: number, end: number, targetTicks: number) {
	const step = CLOCK_STEPS.find((candidate) => (end - start) / candidate <= targetTicks) ?? CLOCK_STEPS[CLOCK_STEPS.length - 1]
	const midnight = new Date(start)
	midnight.setHours(0, 0, 0, 0)
	const ticks: number[] = []
	for (let time = midnight.getTime(); time <= end; time += step) if (time >= start) ticks.push(time)
	return ticks
}

const MINUTE = 60_000

// whole-minute ticks that stay inside the match
function minuteTicks(xMax: number, targetTicks: number) {
	return Chart.axis(xMax / MINUTE, targetTicks, { integer: true })
		.ticks.filter((minutes) => minutes * MINUTE <= xMax)
		.map((minutes) => minutes * MINUTE)
}

function formatElapsed(ms: number) {
	const totalSeconds = Math.floor(ms / 1000)
	return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, '0')}`
}
