import { useQuery } from '@tanstack/react-query'
import * as Icons from 'lucide-react'
import React from 'react'

import { StackedBarChart } from '@/components/charts/stacked-bar-chart'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import * as ChatPrt from '@/frame-partials/chat.partial'
import * as TeamsPanelPrt from '@/frame-partials/teams-panel.partial'
import * as SquadServerFrame from '@/frames/squad-server.frame'
import type * as Chart from '@/lib/chart'
import { cn } from '@/lib/utils'
import * as Zus from '@/lib/zustand'
import * as MH_Msgs from '@/messages/match-history.messages'
import * as SM_Msgs from '@/messages/squad.messages'
import type * as CHAT from '@/models/chat.models'
import * as StatsModels from '@/models/stats-panel.models'
import * as BattlemetricsClient from '@/systems/battlemetrics.client'
import * as ClientOnlySettings from '@/systems/client-only-settings.client'
import * as MatchHistoryClient from '@/systems/match-history.client'
import { tr } from '@/systems/messages.client'
import * as SettingsClient from '@/systems/settings.client'
import * as SquadServerClient from '@/systems/squad-server.client'

// The Teams Breakdown panel. `wide` is the two-column dashboard's form: the legend rides in the title bar and the two
// teams face each other as mirrored bars. Narrow stacks them, for a side column or a phone.
export default function StatsPanel(props: { stores: SquadServerFrame.KeyProp; wide?: boolean; className?: string }) {
	const squadServer = props.stores.squadServer!
	const serverId = squadServer.serverId
	const selectedMatchOrdinal = Zus.useStore(squadServer, ChatPrt.Sel.selectedMatchOrdinal)

	const historicalEventsQuery = useQuery(MatchHistoryClient.matchEventsQueryOptions(serverId, selectedMatchOrdinal))
	const historicalEvents = historicalEventsQuery.data?.events ?? null

	const hasData = Zus.useStore_Susp(
		squadServer,
		MatchHistoryClient.currentMatch$(serverId),
		MatchHistoryClient.recentMatches$(serverId),
		ClientOnlySettings.Store,
		BattlemetricsClient.playerBmData$,
		BattlemetricsClient.Store,
		SettingsClient.PublicSettingsStore,
		StatsModels.Sel.hasData(historicalEvents),
	)
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
	const [legendSlot, setLegendSlot] = React.useState<HTMLElement | null>(null)

	return (
		<Card className={cn('w-full', props.className)}>
			<CardHeader className="whitespace-nowrap">
				<CardTitle className="flex items-center gap-1.5 shrink-0">
					<Icons.BarChart2 className="h-3.5 w-3.5" />
					{tr.text(MH_Msgs.teamBreakdowns())}
				</CardTitle>
				{props.wide && <span ref={setLegendSlot} className="flex items-center min-w-0 overflow-hidden" />}
				<span className="flex-1" />
				{hasData && groupings.ids.length > 1 && (
					<span className="flex gap-0.5">
						{groupings.ids.map((groupingId) => (
							<button
								type="button"
								key={groupingId}
								onClick={() => BattlemetricsClient.Actions.setSelectedGroupingId(groupingId || null)}
								className="fd-pill"
								data-state={groupings.active === groupingId ? 'on' : 'off'}
							>
								{groupingId}
							</button>
						))}
					</span>
				)}
				<BreakdownHelp interactive={selectedMatchOrdinal === null} />
			</CardHeader>
			<CardContent className="px-2.5 py-1.5">
				{!hasData ? (
					<div className="text-text-3 text-sm text-center py-3">{tr.text(MH_Msgs.noChartData())}</div>
				) : (
					<>
						{!props.wide && <div ref={setLegendSlot} className="flex items-center mb-1" />}
						<TeamBreakdown stores={props.stores} historicalEvents={historicalEvents} wide={!!props.wide} legendPortal={legendSlot} />
					</>
				)}
			</CardContent>
		</Card>
	)
}

// what the chart is and what clicking it does, out of the way of the segment tooltips that would otherwise repeat
// it on every hover. The click hints only apply while the chart is interactive, i.e. showing the live roster.
function BreakdownHelp(props: { interactive: boolean }) {
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<button type="button" className="fd-btn fd-btn-ghost fd-btn-ico fd-btn-sm" aria-label={tr.text(SM_Msgs.help())}>
					<Icons.CircleHelp />
				</button>
			</TooltipTrigger>
			<TooltipContent className="max-w-xs space-y-1.5">
				<p>{tr.text(props.interactive ? MH_Msgs.breakdownDescription() : MH_Msgs.breakdownDescriptionHistorical())}</p>
				{props.interactive && (
					<ul className="text-text-2">
						<li>{tr.text(MH_Msgs.breakdownFilterHint())}</li>
						<li>{tr.text(MH_Msgs.breakdownSelectTeamHint())}</li>
						<li>{tr.text(MH_Msgs.breakdownSelectBothHint())}</li>
					</ul>
				)}
			</TooltipContent>
		</Tooltip>
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
					if (group === 'Other') group = TeamsPanelPrt.FILTER_NONE
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
					ClientOnlySettings.Actions.setPrimaryPanelTab('VIEWING_TEAMS')
					// on a single-column layout the teams panel is behind a tab of its own
					SquadServerClient.DashboardTabActions.setActiveTab('layers')
				}

	const renderTooltip = (datum: Chart.Datum) => {
		const series = chartSeries[datum.seriesIndex]
		const members = breakdown.members[datum.rowIndex][keptIndices[datum.seriesIndex]]
		return (
			<div className="flex flex-col gap-1">
				<span className="font-semibold">{breakdown.rows[datum.rowIndex].label}</span>
				<span className="flex items-center gap-1.5">
					<span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: series.color }} />
					<span>
						<span className="font-semibold">{series.label}</span>: {datum.value}
					</span>
				</span>
				{members.length > 0 && <span className="text-text-2">{members.map((member) => member.name).join(', ')}</span>}
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
			<Tooltip>
				<TooltipTrigger asChild>
					<PopoverTrigger asChild>
						<button
							type="button"
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

// Kills of the favoured team over the other's, for the match the panels are showing: one number, pointing at the
// team it favours. Historical matches count from their stored events, the live one from the buffer.
export function DisplayedMatchKd(props: { stores: SquadServerFrame.KeyProp; leftIsTeam1: boolean; className?: string }) {
	const squadServer = props.stores.squadServer!
	const serverId = squadServer.serverId
	const selectedMatchOrdinal = Zus.useStore(squadServer, ChatPrt.Sel.selectedMatchOrdinal)
	const historicalEventsQuery = useQuery(MatchHistoryClient.matchEventsQueryOptions(serverId, selectedMatchOrdinal))
	const historicalEvents = historicalEventsQuery.data?.events ?? null
	const stats = Zus.useStore_Susp(
		squadServer,
		MatchHistoryClient.currentMatch$(serverId),
		MatchHistoryClient.recentMatches$(serverId),
		ClientOnlySettings.Store,
		StatsModels.Sel.combatStats(historicalEvents),
	)
	if (!stats) return null
	const kills1 = stats.team1.kd.numerator
	const kills2 = stats.team2.kd.numerator
	if (kills1 === 0 && kills2 === 0) return null
	const [left, right] = props.leftIsTeam1 ? [kills1, kills2] : [kills2, kills1]
	const favoursLeft = left >= right
	const [hi, lo] = favoursLeft ? [left, right] : [right, left]
	const value = lo === 0 ? '∞' : (hi / lo).toFixed(2)
	const title = tr.text(MH_Msgs.kdBreakdown(hi, lo))
	return (
		<span
			title={title}
			className={cn(
				'inline-flex items-center gap-px h-4 px-1 rounded-sm bg-white/6 font-mono text-[11px] text-text-2 [&_svg]:size-2.5 [&_svg]:text-text-3',
				props.className,
			)}
		>
			{favoursLeft && <Icons.ChevronLeft />}
			{value}
			{!favoursLeft && <Icons.ChevronRight />}
		</span>
	)
}
