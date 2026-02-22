import * as DH from '@/lib/display-helpers'
import type * as CHAT from '@/models/chat.models'

import * as ZusUtils from '@/lib/zustand'
import * as BM from '@/models/battlemetrics.models'
import type * as SM from '@/models/squad.models'
import * as BattlemetricsClient from '@/systems/battlemetrics.client'
import * as ConfigClient from '@/systems/config.client'
import { GlobalSettingsStore } from '@/systems/global-settings.client'

import * as SquadServerClient from '@/systems/squad-server.client'
import type { EChartsOption } from 'echarts'
import ReactECharts from 'echarts-for-react'
import React from 'react'
import * as Zus from 'zustand'

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

function createFlagGroupChartOption(
	groupLabels: string[],
	groupColors: string[],
	team1Counts: number[],
	team2Counts: number[],
	team1Label: string,
	team2Label: string,
): EChartsOption {
	return {
		animation: false,
		grid: {
			left: 10,
			right: 20,
			top: 30,
			bottom: 10,
			containLabel: true,
		},
		legend: {
			data: groupLabels.map((label, i) => ({ name: label, itemStyle: { color: groupColors[i] } })),
			top: 5,
			type: 'scroll',
		},
		xAxis: {
			type: 'value',
			minInterval: 1,
		},
		yAxis: {
			type: 'category',
			data: [team1Label, team2Label],
		},
		series: groupLabels.map((label, i) => ({
			name: label,
			type: 'bar' as const,
			stack: 'total',
			data: [team1Counts[i], team2Counts[i]],
			itemStyle: { color: groupColors[i] },
			label: { show: false },
		})),
		tooltip: {
			trigger: 'axis',
			axisPointer: { type: 'shadow' },
			confine: true,
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
	const selectedMatchOrdinal = Zus.useStore(SquadServerClient.ChatStore, s => s.selectedMatchOrdinal)

	// Get unfiltered live events for K/D calculation
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

	// Current live players for flag group chart
	const livePlayers = Zus.useStore(
		SquadServerClient.ChatStore,
		ZusUtils.useDeep(s => {
			if (selectedMatchOrdinal !== null || !s.chatState.synced) return null
			return s.chatState.interpolatedState.players
		}),
	)

	const bmData = BattlemetricsClient.usePlayerBmData()
	const config = ConfigClient.useConfig()
	const playerFlagGroupings = config?.playerFlagGroupings

	const events = selectedMatchOrdinal !== null ? props.historicalEvents : liveUnfilteredEvents
	const isEmpty = !events || events.length === 0

	const overallKD = React.useMemo(() => {
		if (!events || events.length === 0) return { team1Ratio: 0, team2Ratio: 0 }
		return calculateOverallKD(events)
	}, [events])

	const overallWD = React.useMemo(() => {
		if (!events || events.length === 0) return { team1Ratio: 0, team2Ratio: 0 }
		return calculateOverallWD(events)
	}, [events])

	const [team1Label, team2Label, team1Color, team2Color] = React.useMemo(() => {
		if (!displayTeamsNormalized) {
			return ['Team 1', 'Team 2', DH.TEAM_COLORS.team1, DH.TEAM_COLORS.team2]
		}
		const ordinal = props.currentMatchOrdinal ?? 0
		const parity = ordinal % 2
		if (parity === 0) {
			return ['Team A', 'Team B', DH.TEAM_COLORS.teamA, DH.TEAM_COLORS.teamB]
		} else {
			return ['Team B', 'Team A', DH.TEAM_COLORS.teamB, DH.TEAM_COLORS.teamA]
		}
	}, [displayTeamsNormalized, props.currentMatchOrdinal])

	// Build flag group counts per team from live players
	const flagGroupChart = React.useMemo(() => {
		if (!playerFlagGroupings || !livePlayers) return null

		// Build [playerId, flags[]] pairs for all live players
		const playerFlagPairs: [SM.PlayerId, BM.PlayerFlag[]][] = livePlayers
			.filter(p => p.ids.steam != null)
			.map(p => {
				const steamId = p.ids.steam!
				const flags = bmData[steamId]?.flags ?? []
				return [steamId, flags]
			})

		const playerGroups = BM.resolvePlayerFlagGroups(playerFlagPairs, playerFlagGroupings)

		// Count per group per team, with "Other" for unmatched players
		const groupLabels = [...Object.keys(playerFlagGroupings), 'Other']
		const team1Counts = new Array(groupLabels.length).fill(0)
		const team2Counts = new Array(groupLabels.length).fill(0)
		const otherIdx = groupLabels.length - 1

		for (const player of livePlayers) {
			const group = player.ids.steam != null ? playerGroups.get(player.ids.steam) : undefined
			const idx = group != null ? groupLabels.indexOf(group) : otherIdx
			if (idx === -1) continue
			if (player.teamId === 1) team1Counts[idx]++
			else if (player.teamId === 2) team2Counts[idx]++
		}

		// Build a flagId -> color lookup from all known player flags
		const flagColorById = new Map<string, string>()
		for (const { flags } of Object.values(bmData)) {
			for (const flag of flags) {
				if (flag.color && !flagColorById.has(flag.id)) {
					flagColorById.set(flag.id, flag.color)
				}
			}
		}

		const resolveGroupColor = (label: string): string => {
			const raw = playerFlagGroupings[label]?.color
			if (!raw) return '#888'
			// If raw looks like a UUID, treat it as a flag ID and look up its color
			return flagColorById.get(raw) ?? raw
		}

		const groupColors = groupLabels.map(resolveGroupColor)

		return {
			option: createFlagGroupChartOption(groupLabels, groupColors, team1Counts, team2Counts, team1Label, team2Label),
			groupCount: groupLabels.length,
		}
	}, [playerFlagGroupings, livePlayers, bmData, team1Label, team2Label])

	if (isEmpty) {
		return (
			<div className="text-muted-foreground text-sm text-center py-4">
				No data available for charts
			</div>
		)
	}

	return (
		<div className="w-full flex flex-col gap-2">
			<div className="flex gap-4 text-xs px-1">
				<span className="text-muted-foreground">Overall K/D Ratio:</span>
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
				<span className="text-muted-foreground ml-2">Wound Ratio:</span>
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
			{flagGroupChart && (
				<div>
					<div className="text-xs text-muted-foreground px-1 mb-0.5">Team Breakdowns</div>
					<ReactECharts option={flagGroupChart.option} style={{ height: `${Math.max(100, flagGroupChart.groupCount * 22 + 60)}px` }} />
				</div>
			)}
		</div>
	)
}
