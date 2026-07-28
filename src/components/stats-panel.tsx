import { useQuery } from '@tanstack/react-query'
import * as Icons from 'lucide-react'
import React from 'react'

import { StackedBarChart } from '@/components/charts/stacked-bar-chart'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { TrackingTooltip } from '@/components/ui/tracking-tooltip'
import * as ChatPrt from '@/frame-partials/chat.partial'
import type * as SquadServerFrame from '@/frames/squad-server.frame'
import type * as Chart from '@/lib/chart'
import { cn } from '@/lib/utils'
import * as Zus from '@/lib/zustand'
import * as MH_Msgs from '@/messages/match-history.messages'
import type * as CHAT from '@/models/chat.models'
import * as StatsModels from '@/models/stats-panel.models'
import * as RPC from '@/orpc.client'
import * as BattlemetricsClient from '@/systems/battlemetrics.client'
import * as ClientOnlySettings from '@/systems/client-only-settings.client'
import * as MatchHistoryClient from '@/systems/match-history.client'
import * as SettingsClient from '@/systems/settings.client'

export default function StatsPanel(props: { stores: SquadServerFrame.KeyProp }) {
	const squadServer = props.stores.squadServer!
	const serverId = squadServer.serverId
	const selectedMatchOrdinal = Zus.useStore(squadServer, ChatPrt.Sel.selectedMatchOrdinal)

	const historicalEventsQuery = useQuery({
		queryKey: [...RPC.orpc.matchHistory.getMatchEvents.key(), selectedMatchOrdinal],
		queryFn: async () => {
			if (selectedMatchOrdinal === null) return null
			return RPC.selectLoaded(await RPC.orpc.matchHistory.getMatchEvents.call({ serverId, ordinal: selectedMatchOrdinal })) ?? null
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

	return (
		<Card className="w-full">
			<CardHeader className="flex flex-row items-center pb-3">
				<CardTitle className="flex items-center gap-2">
					<Icons.BarChart2 className="h-5 w-5" />
					{MH_Msgs.statsTitle().text()}
				</CardTitle>
			</CardHeader>
			<CardContent>
				{!hasData ? (
					<div className="text-muted-foreground text-sm text-center py-4">{MH_Msgs.noChartData().text()}</div>
				) : (
					<div className="w-full flex flex-col gap-2">
						<CombatStats stores={props.stores} historicalEvents={historicalEvents} />
						<TeamBreakdown stores={props.stores} />
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
				label={MH_Msgs.kdRatio().text()}
				teams={teams}
				ratios={[stats.team1.kd, stats.team2.kd]}
				describe={(ratio) => MH_Msgs.kdBreakdown(ratio.numerator, ratio.denominator).text()}
			/>
			<RatioGroup
				label={MH_Msgs.woundRatio().text()}
				teams={teams}
				ratios={[stats.team1.wounds, stats.team2.wounds]}
				describe={(ratio) => MH_Msgs.woundBreakdown(ratio.numerator, ratio.denominator).text()}
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

function TeamBreakdown(props: { stores: SquadServerFrame.KeyProp }) {
	const squadServer = props.stores.squadServer!
	const serverId = squadServer.serverId
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
		StatsModels.Sel.breakdown,
	)
	const groupings = Zus.useStore_Susp(
		squadServer,
		currentMatch$,
		recentMatches$,
		ClientOnlySettings.Store,
		BattlemetricsClient.playerBmData$,
		BattlemetricsClient.Store,
		SettingsClient.PublicSettingsStore,
		StatsModels.Sel.groupings,
	)
	if (!breakdown) return null

	const renderTooltip = (datum: Chart.Datum) => {
		const series = breakdown.series[datum.seriesIndex]
		const players = breakdown.players[datum.rowIndex][datum.seriesIndex]
		return (
			<div className="flex flex-col gap-1">
				<span className="font-semibold">{breakdown.rows[datum.rowIndex].label}</span>
				<span className="flex items-center gap-1.5">
					<span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: series.color }} />
					<span>
						<span className="font-semibold">{series.label}</span>: {datum.value}
					</span>
				</span>
				{players.length > 0 && <span className="text-muted-foreground">{players.join(', ')}</span>}
			</div>
		)
	}

	const renderLegendTooltip = (seriesIndex: number) => (
		<div className="flex flex-col gap-0.5">
			<span className="font-semibold">{breakdown.series[seriesIndex].label}</span>
			{breakdown.rows.map((row) => (
				<span key={row.key}>
					{row.label}: {row.values[seriesIndex]}
				</span>
			))}
		</div>
	)

	return (
		<div>
			<div className="flex items-center gap-1 px-1 mb-0.5">
				<span className="text-xs text-muted-foreground">{MH_Msgs.teamBreakdowns().text()}</span>
				{groupings.ids.length > 1 && (
					<div className="flex gap-0.5 ml-2">
						{groupings.ids.map((groupingId) => (
							<button
								type="button"
								key={groupingId}
								onClick={() => BattlemetricsClient.Actions.setSelectedGroupingId(groupingId)}
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
			</div>
			<StackedBarChart
				rows={breakdown.rows}
				series={breakdown.series}
				ariaLabel={MH_Msgs.teamBreakdowns().text()}
				renderTooltip={renderTooltip}
				renderLegendTooltip={renderLegendTooltip}
			/>
		</div>
	)
}
