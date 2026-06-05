import * as ZusUtils from '@/lib/zustand'
import * as BM from '@/models/battlemetrics.models'
import * as MH from '@/models/match-history.models'
import * as SquadServer from '@/models/squad-server.models'
import * as SM from '@/models/squad.models'
import * as TeamsPanelModels from '@/models/teams-panel.models'
import * as BattlemetricsClient from '@/systems/battlemetrics.client'
import * as ConfigClient from '@/systems/config.client'
import * as MatchHistoryClient from '@/systems/match-history.client'
import * as SquadServerClient from '@/systems/squad-server.client'
import * as TeamsSwitchesClient from '@/systems/teamswitches.client'
import * as ThemeClient from '@/systems/theme.client'
import type { EChartsOption } from 'echarts'
import ReactECharts from 'echarts-for-react'
import { createColumnHelper, flexRender, getCoreRowModel, getSortedRowModel, useReactTable } from '@tanstack/react-table'
import type { RowSelectionState, SortingState } from '@tanstack/react-table'
import React from 'react'
import * as Zus from 'zustand'
import ComboBox from './combo-box/combo-box'
import { PlayerDisplay } from './player-display'
import { MatchTeamDisplay } from './teams-display'
import { Button } from './ui/button'
import { Checkbox } from './ui/checkbox'
import { Input } from './ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table'

export default function TeamsPanel() {
	const breakdown = useTeamBreakdownData()
	return (
		<div className="flex w-full p-1 flex-col">
			<div className="grid w-full grid-cols-[1fr_auto_1fr] gap-1">
				<div>
					<TeamTitle teamId={'A'} />
				</div>
				<div>stats</div>
				<div className="flex justify-end">
					<TeamTitle teamId={'B'} />
				</div>
				<div>
				</div>
			</div>
			<div className="grid w-full grid-cols-[1fr_auto_1fr] gap-1">
				<Input placeholder="Search Players..." />
				<div className="flex justify-center w-75">
					<TeamBreakdownLegend data={breakdown} />
				</div>
				<ControlPanel />
			</div>
			<div className="grid w-full grid-cols-[1fr_auto_1fr] gap-1">
				<TeamPlayerTable teamId="A" />
				<TeamBreakdownChart data={breakdown} />
				<TeamPlayerTable teamId="B" />
			</div>
		</div>
	)
}

function TeamTitle(props: { teamId: MH.NormedTeamId }) {
	const match = MatchHistoryClient.useCurrentMatch()
	const playerCount = ZusUtils.useStore(
		SquadServerClient.ChatStore,
		MatchHistoryClient.currentMatch$(),
		SquadServer.Select.teamPlayerCount(props.teamId),
	)
	const diffAfterSwitches = ZusUtils.useStore(
		TeamsSwitchesClient.Store,
		TeamsSwitchesClient.Select.diffAfterSwitchesForTeam(props.teamId),
	)
	return (
		<div>
			<MatchTeamDisplay teamId={props.teamId} matchId={match?.historyEntryId} showAltTeamIndicator={true} />,{' '}
			{playerCount}({diffAfterSwitches >= 0 ? '+' : ''}
			{diffAfterSwitches}) players
		</div>
	)
}

function ControlPanel() {
	return (
		<div className="flex justify-end">
			<ComboBox
				title="Grouping"
				options={['Balance', 'Admin']}
				value={'Balance'}
				onSelect={function(value: undefined): void {
					throw new Error('Function not implemented.')
				}}
			/>
			<Button>Show Swaps(6/9)</Button>
		</div>
	)
}

type TeamBreakdownData = {
	groupLabels: string[]
	groupColors: string[]
	teamACounts: number[]
	teamBCounts: number[]
	teamAPlayers: string[][]
	teamBPlayers: string[][]
	groupingModeIds: string[]
	activeModeId: string
	setSelectedModeId: (id: string | null) => void
} | null

function useTeamBreakdownData(): TeamBreakdownData {
	const match = MatchHistoryClient.useCurrentMatch()
	const teamAIsTeam1 = (match?.ordinal ?? 0) % 2 === 0

	const livePlayers = Zus.useStore(
		SquadServerClient.ChatStore,
		ZusUtils.useDeep(s => {
			if (!s.chatState.synced) return null
			return s.chatState.interpolatedState.players
		}),
	)

	const bmData = BattlemetricsClient.usePlayerBmData()
	const orgFlags = BattlemetricsClient.useOrgFlags()
	const config = ConfigClient.useConfig()
	const playerFlagGroupings = config?.playerFlagGroupings

	const groupingModeIds = React.useMemo(
		() => (playerFlagGroupings ? BM.getGroupingModeIds(playerFlagGroupings) : []),
		[playerFlagGroupings],
	)

	const selectedModeId = Zus.useStore(BattlemetricsClient.Store, s => s.selectedModeId)
	const setSelectedModeId = Zus.useStore(BattlemetricsClient.Store, s => s.setSelectedModeId)
	const slsOnly = Zus.useStore(BattlemetricsClient.Store, s => s.slsOnly)

	const activeModeId = selectedModeId !== null && groupingModeIds.includes(selectedModeId)
		? selectedModeId
		: groupingModeIds[0] ?? null

	return React.useMemo((): TeamBreakdownData => {
		if (!playerFlagGroupings || !livePlayers || activeModeId === null) return null

		const modeGroupings = playerFlagGroupings.filter(g => g.modeIds.includes(activeModeId))
		const chartPlayers = slsOnly ? livePlayers.filter(p => p.isLeader) : livePlayers

		const playerFlagPairs: [SM.PlayerId, BM.PlayerFlag[]][] = chartPlayers
			.filter(p => p.ids.eos != null)
			.map(p => {
				const eosId = p.ids.eos!
				const flagIds = bmData[eosId]?.flagIds ?? []
				const flags = orgFlags ? BM.resolveFlags(flagIds, orgFlags) : []
				return [eosId, flags]
			})

		const playerGroups = BM.resolvePlayerFlagGroups(playerFlagPairs, playerFlagGroupings, activeModeId)

		const groupLabels = [...modeGroupings.map(g => g.label), 'Other']
		const labelToIdx = new Map(groupLabels.map((label, i) => [label, i]))
		const teamACounts = new Array<number>(groupLabels.length).fill(0)
		const teamBCounts = new Array<number>(groupLabels.length).fill(0)
		const teamAPlayers: string[][] = groupLabels.map(() => [])
		const teamBPlayers: string[][] = groupLabels.map(() => [])
		const otherIdx = groupLabels.length - 1

		for (const player of chartPlayers) {
			if (player.teamId === null) continue
			const group = player.ids.eos != null ? playerGroups.get(player.ids.eos) : undefined
			const idx = group != null ? (labelToIdx.get(group) ?? -1) : otherIdx
			if (idx === -1) continue
			const name = player.ids.usernameNoTag ?? player.ids.username ?? '?'
			const isTeamA = teamAIsTeam1 ? player.teamId === 1 : player.teamId === 2
			if (isTeamA) {
				teamACounts[idx]++
				teamAPlayers[idx].push(name)
			} else {
				teamBCounts[idx]++
				teamBPlayers[idx].push(name)
			}
		}

		const flagColorById = new Map<string, string>()
		for (const flag of orgFlags ?? []) {
			if (flag.color) flagColorById.set(flag.id, flag.color)
		}

		const groupColorByLabel = new Map(modeGroupings.map(g => [g.label, g.color]))
		const groupColors = groupLabels.map(label => {
			const raw = groupColorByLabel.get(label)
			if (!raw) return '#888'
			return flagColorById.get(raw) ?? raw
		})

		return {
			groupLabels,
			groupColors,
			teamACounts,
			teamBCounts,
			teamAPlayers,
			teamBPlayers,
			groupingModeIds,
			activeModeId,
			setSelectedModeId,
		}
	}, [playerFlagGroupings, activeModeId, livePlayers, slsOnly, bmData, orgFlags, teamAIsTeam1, groupingModeIds, setSelectedModeId])
}

function createVerticalBreakdownChartOption(data: NonNullable<TeamBreakdownData>, isDark: boolean): EChartsOption {
	const textColor = isDark ? '#e5e7eb' : '#111827'
	const { groupLabels, groupColors, teamACounts, teamBCounts, teamAPlayers, teamBPlayers } = data
	return {
		animation: false,
		grid: { left: 4, right: 4, top: 4, bottom: 4, containLabel: true },
		xAxis: {
			type: 'category',
			data: ['A', 'B'],
			axisLabel: { show: false },
			axisTick: { show: false },
			axisLine: { show: false },
		},
		yAxis: {
			type: 'value',
			minInterval: 1,
			axisLabel: { color: textColor, fontSize: 10 },
			splitLine: { lineStyle: { opacity: 0.3 } },
		},
		series: groupLabels.map((label, i) => ({
			name: label,
			type: 'bar' as const,
			stack: 'total',
			barMaxWidth: 20,
			data: [teamACounts[i], teamBCounts[i]],
			itemStyle: { color: groupColors[i] },
			label: {
				show: true,
				color: '#fff',
				fontWeight: 'bold',
				textShadowBlur: isDark ? 0 : 3,
				textShadowColor: '#0006',
				formatter: (p: { value?: unknown }) =>
					typeof p.value === 'number' && p.value > 0 ? String(p.value) : '',
			},
		})),
		tooltip: {
			trigger: 'item',
			confine: true,
			formatter: (params: unknown) => {
				const item = params as { seriesIndex: number; seriesName: string; value: number | null; color: string; dataIndex: number }
				if (!item.value) return ''
				const teamLabel = item.dataIndex === 0 ? 'Team A' : 'Team B'
				const playersByGroup = item.dataIndex === 0 ? teamAPlayers : teamBPlayers
				const players = playersByGroup[item.seriesIndex]
				let html = `<div style="font-weight:bold;margin-bottom:4px">${teamLabel}</div>`
				html += `<div style="display:flex;align-items:center;gap:6px">`
				html += `<span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${item.color}"></span>`
				html += `<span><b>${item.seriesName}</b>: ${item.value}</span>`
				html += '</div>'
				if (players && players.length > 0) {
					html += `<div style="margin-top:4px">${players.join(', ')}</div>`
				}
				return html
			},
		},
	}
}

function TeamBreakdownLegend({ data }: { data: TeamBreakdownData }) {
	if (!data) return null
	const { groupLabels, groupColors, groupingModeIds, activeModeId, setSelectedModeId } = data
	return (
		<div className="flex flex-col gap-1 justify-center">
			{groupingModeIds.length > 1 && (
				<div className="flex gap-0.5">
					{groupingModeIds.map(modeId => (
						<button
							type="button"
							key={modeId}
							onClick={() => setSelectedModeId(modeId)}
							className={`text-xs px-2 py-0.5 rounded ${
								activeModeId === modeId
									? 'bg-primary text-primary-foreground'
									: 'text-muted-foreground hover:text-foreground'
							}`}
						>
							{modeId}
						</button>
					))}
				</div>
			)}
			<div className="flex flex-wrap gap-x-2 gap-y-0.5">
				{groupLabels.map((label, i) => (
					<span key={label} className="flex items-center gap-1 text-xs">
						<span className="w-2 h-2 rounded-sm shrink-0" style={{ backgroundColor: groupColors[i] }} />
						{label}
					</span>
				))}
			</div>
		</div>
	)
}

function TeamBreakdownChart({ data }: { data: TeamBreakdownData }) {
	const { resolvedTheme } = ThemeClient.useTheme()
	const isDark = resolvedTheme === 'dark'

	const chartOption = React.useMemo(() => {
		if (!data) return null
		return createVerticalBreakdownChartOption(data, isDark)
	}, [data, isDark])

	if (!chartOption) return null

	return <ReactECharts option={chartOption} notMerge={true} style={{ height: '200px', width: '100px' }} />
}

type TeamPlayerTableMeta = { matchId: number; squads: SM.UniqueSquad[] }

const playerColumnHelper = createColumnHelper<TeamsPanelModels.EnrichedPlayer>()

const playerColumns = [
	playerColumnHelper.display({
		id: 'select',
		header: ({ table }) => (
			<Checkbox
				checked={table.getIsAllRowsSelected()}
				onCheckedChange={checked => table.toggleAllRowsSelected(!!checked)}
				aria-label="Select all"
			/>
		),
		cell: ({ row }) => (
			<Checkbox
				checked={row.getIsSelected()}
				onCheckedChange={checked => row.toggleSelected(!!checked)}
				aria-label="Select row"
			/>
		),
	}),
	playerColumnHelper.accessor(row => row.ids.usernameNoTag ?? row.ids.username ?? '', {
		id: 'name',
		header: 'Name',
		cell: ({ row, table }) => <PlayerDisplay player={row.original} matchId={(table.options.meta as TeamPlayerTableMeta).matchId} />,
	}),
	playerColumnHelper.accessor('role', {
		header: 'Role',
		enableSorting: false,
	}),
	playerColumnHelper.accessor(row => row.grouping ?? '', {
		id: 'grouping',
		header: 'Grouping',
	}),
	playerColumnHelper.accessor(row => row.squadId ?? -1, {
		id: 'squad',
		header: 'Squad',
		cell: ({ row, table }) => {
			const { squads } = table.options.meta as TeamPlayerTableMeta
			const squadId = row.original.squadId
			if (squadId === null) return ''
			const squad = squads.find(s => s.squadId === squadId)
			return squad?.squadName === 'Command Squad' ? `CMD(${squadId})` : String(squadId)
		},
	}),
]

function TeamPlayerTable(props: { teamId: MH.NormedTeamId }) {
	const [rowSelection, setRowSelection] = React.useState<RowSelectionState>({})
	const [sorting, setSorting] = React.useState<SortingState>([])
	const match = MatchHistoryClient.useCurrentMatch()
	const matchId = match?.historyEntryId ?? 0
	const players = ZusUtils.useStore(
		SquadServerClient.ChatStore,
		MatchHistoryClient.currentMatch$(),
		BattlemetricsClient.playerBmData$,
		BattlemetricsClient.Store,
		ConfigClient.Store,
		React.useCallback(TeamsPanelModels.Select.playersForTeam(props.teamId), [props.teamId]),
	)
	const squads = ZusUtils.useStore(
		SquadServerClient.ChatStore,
		MatchHistoryClient.currentMatch$(),
		React.useCallback(SquadServer.Select.squadsForTeam(props.teamId), [props.teamId]),
	)

	const table = useReactTable({
		data: players,
		columns: playerColumns,
		getCoreRowModel: getCoreRowModel(),
		getSortedRowModel: getSortedRowModel(),
		getRowId: row => SM.PlayerIds.getPlayerId(row.ids),
		state: { rowSelection, sorting },
		onRowSelectionChange: setRowSelection,
		onSortingChange: setSorting,
		meta: { matchId, squads } satisfies TeamPlayerTableMeta,
	})

	return (
		<Table>
			<TableHeader>
				{table.getHeaderGroups().map(headerGroup => (
					<TableRow key={headerGroup.id}>
						{headerGroup.headers.map(header => (
							<TableHead
								key={header.id}
								onClick={header.column.getCanSort() ? header.column.getToggleSortingHandler() : undefined}
								className={header.column.getCanSort() ? 'cursor-pointer select-none' : undefined}
							>
								{header.isPlaceholder ? null : (
									<span className="inline-flex items-center gap-0.5">
										{flexRender(header.column.columnDef.header, header.getContext())}
										{header.column.getIsSorted() === 'asc' ? ' ↑' : header.column.getIsSorted() === 'desc' ? ' ↓' : null}
									</span>
								)}
							</TableHead>
						))}
					</TableRow>
				))}
			</TableHeader>
			<TableBody>
				{table.getRowModel().rows.map(row => (
					<TableRow key={row.id} data-state={row.getIsSelected() ? 'selected' : undefined}>
						{row.getVisibleCells().map(cell => (
							<TableCell key={cell.id}>
								{flexRender(cell.column.columnDef.cell, cell.getContext())}
							</TableCell>
						))}
					</TableRow>
				))}
			</TableBody>
		</Table>
	)
}
