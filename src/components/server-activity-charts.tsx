import { ButtonGroup } from '@/components/ui/button-group'
import * as DH from '@/lib/display-helpers'
import type * as CHAT from '@/models/chat.models'

import * as ZusUtils from '@/lib/zustand'
import * as SM from '@/models/squad.models'
import { GlobalSettingsStore } from '@/systems/global-settings.client'

import * as SquadServerClient from '@/systems/squad-server.client'
import type { EChartsOption } from 'echarts'
import ReactECharts from 'echarts-for-react'
import React from 'react'
import * as Zus from 'zustand'

type ChartDataPoint = {
	time: number
	value: number
}

type TeamRatioDataPoint = {
	time: number
	team1Ratio: number
	team2Ratio: number
}

type ChartData = {
	playerPopulation: ChartDataPoint[]
	kdRatio: TeamRatioDataPoint[]
	wdRatio: TeamRatioDataPoint[]
}

function calculateOverallKD(events: CHAT.EventEnriched[]): { team1Ratio: number; team2Ratio: number } {
	let team1Kills = 0
	let team1Deaths = 0
	let team2Kills = 0
	let team2Deaths = 0

	for (const event of events) {
		if (event.type === 'PLAYER_DIED') {
			const victimTeam = event.victim.teamId
			const attackerTeam = event.attacker.teamId

			// Deaths count for the victim's team
			if (victimTeam === 1) {
				team1Deaths++
			} else if (victimTeam === 2) {
				team2Deaths++
			}

			// Kills count only for normal kills (not teamkills/suicides)
			if (event.variant === 'normal') {
				if (attackerTeam === 1) {
					team1Kills++
				} else if (attackerTeam === 2) {
					team2Kills++
				}
			}
		}
	}

	const team1Ratio = team1Deaths === 0
		? (team1Kills > 0 ? 999 : 0)
		: team1Kills / team1Deaths
	const team2Ratio = team2Deaths === 0
		? (team2Kills > 0 ? 999 : 0)
		: team2Kills / team2Deaths

	return { team1Ratio, team2Ratio }
}

function calculateOverallWD(events: CHAT.EventEnriched[]): { team1Ratio: number; team2Ratio: number } {
	let team1Wounds = 0
	let team1Wounded = 0
	let team2Wounds = 0
	let team2Wounded = 0

	for (const event of events) {
		if (event.type === 'PLAYER_WOUNDED') {
			const victimTeam = event.victim.teamId
			const attackerTeam = event.attacker.teamId

			// Wounded count for the victim's team
			if (victimTeam === 1) {
				team1Wounded++
			} else if (victimTeam === 2) {
				team2Wounded++
			}

			// Wounds count only for normal wounds (not teamkills/suicides)
			if (event.variant === 'normal') {
				if (attackerTeam === 1) {
					team1Wounds++
				} else if (attackerTeam === 2) {
					team2Wounds++
				}
			}
		}
	}

	const team1Ratio = team1Wounded === 0
		? (team1Wounds > 0 ? 999 : 0)
		: team1Wounds / team1Wounded
	const team2Ratio = team2Wounded === 0
		? (team2Wounds > 0 ? 999 : 0)
		: team2Wounds / team2Wounded

	return { team1Ratio, team2Ratio }
}

function aggregateByTimeWindow(
	events: CHAT.EventEnriched[],
	windowMs: number,
): ChartData {
	if (events.length === 0) {
		return { playerPopulation: [], kdRatio: [], wdRatio: [] }
	}

	const firstEventTime = events[0].time
	const lastEventTime = events[events.length - 1].time
	const duration = lastEventTime - firstEventTime

	// Create time buckets
	const bucketCount = Math.max(1, Math.ceil(duration / windowMs))
	const playerCountBuckets: number[] = new Array(bucketCount).fill(0)
	const killsBuckets: { team1: number; team2: number }[] = new Array(bucketCount)
		.fill(null)
		.map(() => ({ team1: 0, team2: 0 }))
	const deathsBuckets: { team1: number; team2: number }[] = new Array(bucketCount)
		.fill(null)
		.map(() => ({ team1: 0, team2: 0 }))
	const woundsBuckets: { team1: number; team2: number }[] = new Array(bucketCount)
		.fill(null)
		.map(() => ({ team1: 0, team2: 0 }))
	const woundedBuckets: { team1: number; team2: number }[] = new Array(bucketCount)
		.fill(null)
		.map(() => ({ team1: 0, team2: 0 }))

	// Track player count at each bucket
	const connectedPlayers = new Set<string>()
	let lastBucketIndex = -1

	for (const event of events) {
		const bucketIndex = Math.floor((event.time - firstEventTime) / windowMs)

		// Update player count when we enter a new bucket
		if (bucketIndex !== lastBucketIndex) {
			playerCountBuckets[bucketIndex] = connectedPlayers.size
			lastBucketIndex = bucketIndex
		}

		// Track connections/disconnections
		if (event.type === 'PLAYER_CONNECTED') {
			connectedPlayers.add(SM.PlayerIds.getPlayerId(event.player.ids))
		} else if (event.type === 'PLAYER_DISCONNECTED') {
			connectedPlayers.delete(SM.PlayerIds.getPlayerId(event.player.ids))
		} else if (event.type === 'NEW_GAME' || event.type === 'RESET') {
			// Reset player list to the current state from the event
			connectedPlayers.clear()
			for (const player of event.state.players) {
				connectedPlayers.add(SM.PlayerIds.getPlayerId(player.ids))
			}
		}

		// Track kills and deaths
		if (event.type === 'PLAYER_DIED') {
			const victimTeam = event.victim.teamId
			const attackerTeam = event.attacker.teamId

			// Skip if teams are null or bucket is out of bounds
			if (bucketIndex < 0 || bucketIndex >= bucketCount) continue

			// Deaths count for the victim's team (all variants)
			if (victimTeam === 1) {
				deathsBuckets[bucketIndex].team1++
			} else if (victimTeam === 2) {
				deathsBuckets[bucketIndex].team2++
			}

			// Kills count only for normal kills (not teamkills/suicides)
			if (event.variant === 'normal') {
				if (attackerTeam === 1) {
					killsBuckets[bucketIndex].team1++
				} else if (attackerTeam === 2) {
					killsBuckets[bucketIndex].team2++
				}
			}
		}

		// Track wounds (who dealt wounds) and wounded (who got wounded)
		if (event.type === 'PLAYER_WOUNDED') {
			const victimTeam = event.victim.teamId
			const attackerTeam = event.attacker.teamId

			// Skip if teams are null or bucket is out of bounds
			if (bucketIndex < 0 || bucketIndex >= bucketCount) continue

			// Wounded count for the victim's team (all variants)
			if (victimTeam === 1) {
				woundedBuckets[bucketIndex].team1++
			} else if (victimTeam === 2) {
				woundedBuckets[bucketIndex].team2++
			}

			// Wounds count only for normal wounds (not teamkills/suicides)
			if (event.variant === 'normal') {
				if (attackerTeam === 1) {
					woundsBuckets[bucketIndex].team1++
				} else if (attackerTeam === 2) {
					woundsBuckets[bucketIndex].team2++
				}
			}
		}

		// Update player count at current bucket
		playerCountBuckets[bucketIndex] = connectedPlayers.size
	}

	// Convert buckets to data points with ratios
	const playerPopulation: ChartDataPoint[] = []
	const kdRatio: TeamRatioDataPoint[] = []
	const wdRatio: TeamRatioDataPoint[] = []

	for (let i = 0; i < bucketCount; i++) {
		const time = firstEventTime + i * windowMs

		playerPopulation.push({
			time,
			value: playerCountBuckets[i],
		})

		// Calculate K/D ratio (kills / deaths), handle division by zero
		// If no deaths, use a high value if there are kills, otherwise 0
		const team1KD = deathsBuckets[i].team1 === 0
			? (killsBuckets[i].team1 > 0 ? 999 : 0)
			: killsBuckets[i].team1 / deathsBuckets[i].team1
		const team2KD = deathsBuckets[i].team2 === 0
			? (killsBuckets[i].team2 > 0 ? 999 : 0)
			: killsBuckets[i].team2 / deathsBuckets[i].team2

		kdRatio.push({
			time,
			team1Ratio: team1KD,
			team2Ratio: team2KD,
		})

		// Calculate W/D ratio (wounds dealt / wounded received), handle division by zero
		// If no wounded, use a high value if there are wounds, otherwise 0
		const team1WD = woundedBuckets[i].team1 === 0
			? (woundsBuckets[i].team1 > 0 ? 999 : 0)
			: woundsBuckets[i].team1 / woundedBuckets[i].team1
		const team2WD = woundedBuckets[i].team2 === 0
			? (woundsBuckets[i].team2 > 0 ? 999 : 0)
			: woundsBuckets[i].team2 / woundedBuckets[i].team2

		wdRatio.push({
			time,
			team1Ratio: team1WD,
			team2Ratio: team2WD,
		})
	}

	return { playerPopulation, kdRatio, wdRatio }
}

function createPopulationChartOption(data: ChartDataPoint[], maxPlayerCount?: number): EChartsOption {
	return {
		animation: false,
		grid: {
			left: 50,
			right: 20,
			top: 10,
			bottom: 30,
		},
		xAxis: {
			type: 'time',
		},
		yAxis: {
			type: 'value',
			minInterval: 1,
			max: maxPlayerCount,
		},

		series: [
			{
				name: 'Player Count',
				type: 'line',
				data: data.map(d => [d.time, d.value]),
				smooth: false,
				lineStyle: {
					color: '#3b82f6',
					width: 2,
				},
				areaStyle: {
					color: 'rgba(59, 130, 246, 0.1)',
				},
			},
		],
		tooltip: {
			trigger: 'axis',
			formatter: (params: any) => {
				const date = new Date(params[0].value[0])
				const time = date.toLocaleTimeString()
				return `${time}<br/>Players: ${params[0].value[1]}`
			},
		},
	}
}

function createRatioChartOption(
	data: TeamRatioDataPoint[],
	title: string,
	team1Color: string,
	team2Color: string,
	team1Label: string,
	team2Label: string,
): EChartsOption {
	return {
		animation: false,
		grid: {
			left: 50,
			right: 20,
			top: 30,
			bottom: 30,
		},
		xAxis: {
			type: 'time',
		},
		yAxis: {
			type: 'value',
			scale: true,
			min: (value: any) => {
				// Center the chart at 1.0 (equal kills/deaths - neutral ratio)
				const max = value.max
				const distanceFromOne = Math.max(Math.abs(max - 1), Math.abs(value.min - 1))
				return 1 - distanceFromOne
			},
			max: (value: any) => {
				// Center the chart at 1.0 (equal kills/deaths - neutral ratio)
				const min = value.min
				const distanceFromOne = Math.max(Math.abs(value.max - 1), Math.abs(min - 1))
				return 1 + distanceFromOne
			},
		},
		legend: {
			data: [team1Label, team2Label],
			top: 5,
		},
		series: [
			{
				name: team1Label,
				type: 'line',
				data: data.map(d => [d.time, d.team1Ratio]),
				smooth: false,
				lineStyle: {
					color: team1Color,
					width: 2,
				},
				areaStyle: {
					color: team1Color,
					opacity: 0.2,
				},
				symbol: 'none',
			},
			{
				name: team2Label,
				type: 'line',
				data: data.map(d => [d.time, d.team2Ratio]),
				smooth: false,
				lineStyle: {
					color: team2Color,
					width: 2,
				},
				areaStyle: {
					color: team2Color,
					opacity: 0.2,
				},
				symbol: 'none',
			},
		],
		tooltip: {
			trigger: 'axis',
			formatter: (params: any) => {
				const date = new Date(params[0].value[0])
				const time = date.toLocaleTimeString()
				const ratio1 = params[0].value[1].toFixed(2)
				const ratio2 = params[1].value[1].toFixed(2)
				return `${time}<br/>${team1Label}: ${ratio1}<br/>${team2Label}: ${ratio2}`
			},
		},
	}
}

export function ServerActivityCharts(props: {
	historicalEvents: CHAT.EventEnriched[] | null
	maxPlayerCount?: number
	currentMatchOrdinal?: number
	currentMatchId?: number
}) {
	const displayTeamsNormalized = Zus.useStore(GlobalSettingsStore, s => s.displayTeamsNormalized)
	const [timeInterval, setTimeInterval] = React.useState<1 | 5 | 10>(5)
	const selectedMatchOrdinal = Zus.useStore(SquadServerClient.ChatStore, s => s.selectedMatchOrdinal)
	const [, forceUpdate] = React.useReducer((x) => x + 1, 0)

	// Get unfiltered events from store (before secondary filter is applied)
	const liveUnfilteredEvents = Zus.useStore(
		SquadServerClient.ChatStore,
		ZusUtils.useDeep(s => {
			if (selectedMatchOrdinal !== null || !s.chatState.synced || props.currentMatchId === undefined) return null

			const eventBuffer = s.chatState.eventBuffer
			const unfiltered: CHAT.EventEnriched[] = []
			for (const event of eventBuffer) {
				if (event.matchId !== props.currentMatchId) continue
				unfiltered.push(event)
			}
			return unfiltered
		}),
	)

	// Calculate chart data for live events
	const liveChartData = React.useMemo(() => {
		if (!liveUnfilteredEvents) return null

		const windowMs = timeInterval * 60 * 1000
		return {
			chartData: aggregateByTimeWindow(liveUnfilteredEvents, windowMs),
			overallKD: calculateOverallKD(liveUnfilteredEvents),
			overallWD: calculateOverallWD(liveUnfilteredEvents),
			isEmpty: liveUnfilteredEvents.length === 0,
		}
	}, [liveUnfilteredEvents, timeInterval])

	// Calculate chart data for historical events
	const historicalChartData = React.useMemo(() => {
		if (selectedMatchOrdinal === null || !props.historicalEvents) return null

		const events = props.historicalEvents
		const windowMs = timeInterval * 60 * 1000

		return {
			chartData: aggregateByTimeWindow(events, windowMs),
			overallKD: calculateOverallKD(events),
			overallWD: calculateOverallWD(events),
			isEmpty: events.length === 0,
		}
	}, [selectedMatchOrdinal, props.historicalEvents, timeInterval])

	// Use historical or live chart data
	const computedData = selectedMatchOrdinal !== null ? historicalChartData : liveChartData
	const chartData = computedData?.chartData ?? { playerPopulation: [], kdRatio: [], wdRatio: [] }
	const overallKD = computedData?.overallKD ?? { team1Ratio: 0, team2Ratio: 0 }
	const overallWD = computedData?.overallWD ?? { team1Ratio: 0, team2Ratio: 0 }
	const isEmpty = computedData?.isEmpty ?? true

	// Force chart updates on live view to keep time axis current
	React.useEffect(() => {
		if (selectedMatchOrdinal !== null) return // Only update on live view

		const intervalMs = timeInterval * 60 * 1000
		const timer = setInterval(() => {
			forceUpdate()
		}, intervalMs)

		return () => clearInterval(timer)
	}, [selectedMatchOrdinal, timeInterval])

	const populationOption = React.useMemo(
		() => createPopulationChartOption(chartData.playerPopulation, props.maxPlayerCount),
		[chartData.playerPopulation, props.maxPlayerCount],
	)

	const [team1Label, team2Label, team1Color, team2Color] = React.useMemo(() => {
		if (!displayTeamsNormalized) {
			return ['Team 1', 'Team 2', DH.TEAM_COLORS.team1, DH.TEAM_COLORS.team2]
		}

		// If normalized and ordinal is odd, swap the labels
		const ordinal = props.currentMatchOrdinal ?? 0
		const parity = ordinal % 2

		if (parity === 0) {
			return ['Team A', 'Team B', DH.TEAM_COLORS.teamA, DH.TEAM_COLORS.teamB]
		} else {
			return ['Team B', 'Team A', DH.TEAM_COLORS.teamB, DH.TEAM_COLORS.teamA]
		}
	}, [displayTeamsNormalized, props.currentMatchOrdinal])

	const kdRatioOption = React.useMemo(
		() => createRatioChartOption(chartData.kdRatio, 'K/D Ratio', team1Color, team2Color, team1Label, team2Label),
		[chartData.kdRatio, team1Color, team2Color, team1Label, team2Label],
	)

	const wdRatioOption = React.useMemo(
		() => createRatioChartOption(chartData.wdRatio, 'Wound Ratio', team1Color, team2Color, team1Label, team2Label),
		[chartData.wdRatio, team1Color, team2Color, team1Label, team2Label],
	)

	const [activeTab, setActiveTab] = React.useState<'population' | 'kd' | 'wd'>('population')

	if (isEmpty) {
		return (
			<div className="text-muted-foreground text-sm text-center py-4">
				No data available for charts
			</div>
		)
	}

	return (
		<div className="w-full">
			<div className="flex gap-0.5 border-b border-border mb-1 justify-between items-center">
				<div className="flex gap-2 items-center">
					<div className="flex gap-0.5">
						<button
							type="button"
							onClick={() => setActiveTab('population')}
							className={`text-xs px-2 py-0.5 transition-colors ${
								activeTab === 'population'
									? 'text-foreground border-b-2 border-primary -mb-px'
									: 'text-muted-foreground hover:text-foreground'
							}`}
						>
							Population
						</button>
						<button
							type="button"
							onClick={() => setActiveTab('kd')}
							className={`text-xs px-2 py-0.5 transition-colors ${
								activeTab === 'kd'
									? 'text-foreground border-b-2 border-primary -mb-px'
									: 'text-muted-foreground hover:text-foreground'
							}`}
						>
							K/D Ratio
						</button>
						<button
							type="button"
							onClick={() => setActiveTab('wd')}
							className={`text-xs px-2 py-0.5 transition-colors ${
								activeTab === 'wd'
									? 'text-foreground border-b-2 border-primary -mb-px'
									: 'text-muted-foreground hover:text-foreground'
							}`}
						>
							Wound Ratio
						</button>
					</div>
					<ButtonGroup className="text-xs border-l border-border pl-2">
						<button
							type="button"
							onClick={() => setTimeInterval(1)}
							className={`px-1.5 py-0.5 text-xs transition-colors ${
								timeInterval === 1
									? 'bg-primary text-primary-foreground'
									: 'bg-background hover:bg-accent'
							}`}
						>
							1m
						</button>
						<button
							type="button"
							onClick={() => setTimeInterval(5)}
							className={`px-1.5 py-0.5 text-xs transition-colors ${
								timeInterval === 5
									? 'bg-primary text-primary-foreground'
									: 'bg-background hover:bg-accent'
							}`}
						>
							5m
						</button>
						<button
							type="button"
							onClick={() => setTimeInterval(10)}
							className={`px-1.5 py-0.5 text-xs transition-colors ${
								timeInterval === 10
									? 'bg-primary text-primary-foreground'
									: 'bg-background hover:bg-accent'
							}`}
						>
							10m
						</button>
					</ButtonGroup>
				</div>
				{activeTab === 'kd' && (
					<div className="flex gap-3 text-xs mr-2 -mb-px items-center">
						<span className="text-muted-foreground">Overall:</span>
						<span className="flex items-center gap-1">
							<span className="w-2 h-2 rounded-full" style={{ backgroundColor: team1Color }}></span>
							{team1Label}:{' '}
							<span className="font-mono font-semibold">{overallKD.team1Ratio >= 999 ? '∞' : overallKD.team1Ratio.toFixed(2)}</span>
						</span>
						<span className="flex items-center gap-1">
							<span className="w-2 h-2 rounded-full" style={{ backgroundColor: team2Color }}></span>
							{team2Label}:{' '}
							<span className="font-mono font-semibold">{overallKD.team2Ratio >= 999 ? '∞' : overallKD.team2Ratio.toFixed(2)}</span>
						</span>
					</div>
				)}
				{activeTab === 'wd' && (
					<div className="flex gap-3 text-xs mr-2 -mb-px items-center">
						<span className="text-muted-foreground">Overall:</span>
						<span className="flex items-center gap-1">
							<span className="w-2 h-2 rounded-full" style={{ backgroundColor: team1Color }}></span>
							{team1Label}:{' '}
							<span className="font-mono font-semibold">{overallWD.team1Ratio >= 999 ? '∞' : overallWD.team1Ratio.toFixed(2)}</span>
						</span>
						<span className="flex items-center gap-1">
							<span className="w-2 h-2 rounded-full" style={{ backgroundColor: team2Color }}></span>
							{team2Label}:{' '}
							<span className="font-mono font-semibold">{overallWD.team2Ratio >= 999 ? '∞' : overallWD.team2Ratio.toFixed(2)}</span>
						</span>
					</div>
				)}
			</div>
			{activeTab === 'population' && <ReactECharts option={populationOption} style={{ height: '180px' }} />}
			{activeTab === 'kd' && <ReactECharts option={kdRatioOption} style={{ height: '180px' }} />}
			{activeTab === 'wd' && <ReactECharts option={wdRatioOption} style={{ height: '180px' }} />}
		</div>
	)
}
