import { useQuery } from '@tanstack/react-query'
import * as Icons from 'lucide-react'
import React from 'react'

import { StackedBarChart } from '@/components/charts/stacked-bar-chart'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { TrackingTooltip } from '@/components/ui/tracking-tooltip'
import * as ChatPrt from '@/frame-partials/chat.partial'
import * as TeamsPanelPrt from '@/frame-partials/teams-panel.partial'
import * as SquadServerFrame from '@/frames/squad-server.frame'
import type * as Chart from '@/lib/chart'
import { cn } from '@/lib/utils'
import * as Zus from '@/lib/zustand'
import * as MH_Msgs from '@/messages/match-history.messages'
import * as SM_Msgs from '@/messages/squad.messages'
import * as CHAT from '@/models/chat.models'
import * as StatsModels from '@/models/stats-panel.models'
import * as RPC from '@/orpc.client'
import * as BattlemetricsClient from '@/systems/battlemetrics.client'
import * as ClientOnlySettings from '@/systems/client-only-settings.client'
import * as MatchHistoryClient from '@/systems/match-history.client'
import { tr } from '@/systems/messages.client'
import * as SettingsClient from '@/systems/settings.client'
import * as SquadServerClient from '@/systems/squad-server.client'

export default function StatsPanel(props: { stores: SquadServerFrame.KeyProp }) {
	const squadServer = props.stores.squadServer!
	const serverId = squadServer.serverId
	const selectedMatchOrdinal = Zus.useStore(squadServer, ChatPrt.Sel.selectedMatchOrdinal)

	const historicalEventsQuery = useQuery({
		queryKey: [...RPC.orpc.matchHistory.getMatchEvents.key(), selectedMatchOrdinal],
		queryFn: async () => {
			if (selectedMatchOrdinal === null) return null
			const res = RPC.selectLoaded(await RPC.orpc.matchHistory.getMatchEvents.call({ serverId, ordinal: selectedMatchOrdinal }))
			// decoded here rather than at the read, so the query cache holds events the renderer can use directly
			return res ? { ...res, events: CHAT.Wire.decode(res.events) } : null
		},
		enabled: selectedMatchOrdinal !== null && selectedMatchOrdinal !== undefined,
		staleTime: Infinity,
	})
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

	return (
		<Card className="w-full">
			<CardHeader className="flex flex-row items-center justify-between pb-3">
				<CardTitle className="flex items-center gap-2">
					<Icons.BarChart2 className="h-5 w-5" />
					{tr.text(MH_Msgs.statsTitle())}
				</CardTitle>
				{hasData && groupings.ids.length > 1 && (
					<div className="flex gap-0.5">
						{groupings.ids.map((groupingId) => (
							<button
								type="button"
								key={groupingId}
								onClick={() => BattlemetricsClient.Actions.setSelectedGroupingId(groupingId || null)}
								className={cn(
									'text-xs px-2 py-0.5 rounded',
									groupings.active === groupingId
										? 'bg-primary text-primary-foreground'
										: 'text-muted-foreground hover:text-foreground',
								)}
							>
								{groupingId}
							</button>
						))}
					</div>
				)}
			</CardHeader>
			<CardContent>
				{!hasData ? (
					<div className="text-muted-foreground text-sm text-center py-4">{tr.text(MH_Msgs.noChartData())}</div>
				) : (
					<div className="w-full flex flex-col gap-2">
						<TeamBreakdown stores={props.stores} historicalEvents={historicalEvents} />
						<CombatStats stores={props.stores} historicalEvents={historicalEvents} />
					</div>
				)}
			</CardContent>
		</Card>
	)
}

function CombatStats(props: { stores: SquadServerFrame.KeyProp; historicalEvents: CHAT.EventEnriched[] | null }) {
	const squadServer = props.stores.squadServer!
	const serverId = squadServer.serverId
	const teams = Zus.useStore_Susp(
		squadServer,
		MatchHistoryClient.currentMatch$(serverId),
		MatchHistoryClient.recentMatches$(serverId),
		ClientOnlySettings.Store,
		StatsModels.Sel.teams,
	)
	const stats = Zus.useStore_Susp(
		squadServer,
		MatchHistoryClient.currentMatch$(serverId),
		MatchHistoryClient.recentMatches$(serverId),
		ClientOnlySettings.Store,
		StatsModels.Sel.combatStats(props.historicalEvents),
	)
	if (!stats) return null

	return (
		<div className="flex flex-wrap gap-x-6 gap-y-1 text-xs px-1">
			<RatioGroup
				label={tr.text(MH_Msgs.kdRatio())}
				teams={teams}
				ratios={[stats.team1.kd, stats.team2.kd]}
				describe={(ratio) => tr.text(MH_Msgs.kdBreakdown(ratio.numerator, ratio.denominator))}
			/>
			<RatioGroup
				label={tr.text(MH_Msgs.woundRatio())}
				teams={teams}
				ratios={[stats.team1.wounds, stats.team2.wounds]}
				describe={(ratio) => tr.text(MH_Msgs.woundBreakdown(ratio.numerator, ratio.denominator))}
			/>
		</div>
	)
}

function RatioGroup(props: {
	label: string
	teams: readonly [StatsModels.TeamDisplay, StatsModels.TeamDisplay]
	ratios: readonly [StatsModels.Ratio, StatsModels.Ratio]
	describe: (ratio: StatsModels.Ratio) => string
}) {
	const [hovered, setHovered] = React.useState<number | null>(null)
	return (
		<div className="flex items-center gap-2 shrink-0" onPointerLeave={() => setHovered(null)}>
			<span className="text-muted-foreground">{props.label}</span>
			{props.teams.map((team, i) => (
				<span key={team.label} className="flex items-center gap-1 cursor-default" onPointerEnter={() => setHovered(i)}>
					<span className="w-2 h-2 rounded-full" style={{ backgroundColor: team.color }}></span>
					{team.label}: <span className="font-mono font-semibold">{formatRatio(props.ratios[i])}</span>
				</span>
			))}
			<TrackingTooltip content={hovered === null ? null : props.describe(props.ratios[hovered])} />
		</div>
	)
}

function formatRatio(ratio: StatsModels.Ratio) {
	return ratio.value === null ? '∞' : ratio.value.toFixed(2)
}

// what the chart is and what clicking it does, out of the way of the segment tooltips that would otherwise repeat
// it on every hover. The click hints only apply while the chart is interactive, i.e. showing the live roster.
function BreakdownHelp(props: { interactive: boolean }) {
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<button type="button" className="ml-auto text-muted-foreground hover:text-foreground" aria-label={tr.text(SM_Msgs.help())}>
					<Icons.CircleHelp className="h-3.5 w-3.5" />
				</button>
			</TooltipTrigger>
			<TooltipContent className="max-w-xs space-y-1.5">
				<p>{tr.text(props.interactive ? MH_Msgs.breakdownDescription() : MH_Msgs.breakdownDescriptionHistorical())}</p>
				{props.interactive && (
					<ul className="text-muted-foreground">
						<li>{tr.text(MH_Msgs.breakdownFilterHint())}</li>
						<li>{tr.text(MH_Msgs.breakdownSelectTeamHint())}</li>
						<li>{tr.text(MH_Msgs.breakdownSelectBothHint())}</li>
					</ul>
				)}
			</TooltipContent>
		</Tooltip>
	)
}

function TeamBreakdown(props: { stores: SquadServerFrame.KeyProp; historicalEvents: CHAT.EventEnriched[] | null }) {
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
				{members.length > 0 && <span className="text-muted-foreground">{members.map((member) => member.name).join(', ')}</span>}
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
							className="text-muted-foreground hover:text-foreground"
						>
							<Icons.Ellipsis className="h-3.5 w-3.5" />
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
			ariaLabel={tr.text(MH_Msgs.teamBreakdowns())}
			renderTooltip={renderTooltip}
			renderLegendTooltip={renderLegendTooltip}
			onSegmentClick={onSegmentClick}
			legendLeading={<span className="text-xs text-muted-foreground shrink-0">{tr.text(MH_Msgs.teamBreakdowns())}</span>}
			legendExtra={unmatchedGroupsButton}
			legendTrailing={<BreakdownHelp interactive={selectedMatchOrdinal === null} />}
		/>
	)
}
