import * as MapUtils from '@/lib/map'
import * as StrUtils from '@/lib/string'
import { cn } from '@/lib/utils.ts'
import * as ZusUtils from '@/lib/zustand'
import * as BM from '@/models/battlemetrics.models'
import { WINDOW_ID } from '@/models/draggable-windows.models'
import * as MH from '@/models/match-history.models'
import * as SquadServer from '@/models/squad-server.models'
import * as SM from '@/models/squad.models'
import * as TeamsPanelModels from '@/models/teams-panel.models'
import * as TSW from '@/models/teamswitches.models'
import * as BattlemetricsClient from '@/systems/battlemetrics.client'
import * as ConfigClient from '@/systems/config.client'
import * as MatchHistoryClient from '@/systems/match-history.client'
import * as SquadServerClient from '@/systems/squad-server.client'
import * as TSWClient from '@/systems/teamswitches.client'
import * as ThemeClient from '@/systems/theme.client'
import * as UsersClient from '@/systems/users.client'
import { createColumnHelper, flexRender, getCoreRowModel, getSortedRowModel, useReactTable } from '@tanstack/react-table'
import type { RowSelectionState, SortingState } from '@tanstack/react-table'
import type { EChartsOption } from 'echarts'
import ReactECharts from 'echarts-for-react'
import * as Icons from 'lucide-react'
import React from 'react'
import * as Zus from 'zustand'
import PlayerBulkContextMenuOptions from './player-bulk-context-menu-options'
import PlayerContextMenuOptions from './player-context-menu-options'
import SquadContextMenuOptions from './squad-context-menu-options'
import { PlayerDisplay } from './player-display'
import type { SquadDetailsWindowProps } from './squad-details-window.helpers'
import { MatchTeamDisplay } from './teams-display'
import type { TeamswitchesHelpWindowProps } from './teamswitches-help-window.helpers'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from './ui/alert-dialog'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { Checkbox } from './ui/checkbox'
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from './ui/context-menu'
import { OpenWindowInteraction } from './ui/draggable-window'
import { Input } from './ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table'

void import('@/components/squad-details-window')
void import('@/components/teamswitches-help-window')

export default function TeamsPanel(props: { className?: string }) {
	const showSwapsPanel = Zus.useStore(
		TSWClient.Store,
		s => TSWClient.Select.hasSwitches(s),
	)
	const [searchQuery, setSearchQuery] = React.useState('')
	const [roleFilter, setRoleFilter] = React.useState<string | null>(null)
	const [groupingFilter, setGroupingFilter] = React.useState<string | null>(null)
	const [squadFilterA, setSquadFilterA] = React.useState<string | null>(null)
	const [squadFilterB, setSquadFilterB] = React.useState<string | null>(null)
	const filtersA: PlayerFilters = {
		role: roleFilter, setRole: setRoleFilter,
		grouping: groupingFilter, setGrouping: setGroupingFilter,
		squad: squadFilterA, setSquad: setSquadFilterA,
	}
	const filtersB: PlayerFilters = {
		role: roleFilter, setRole: setRoleFilter,
		grouping: groupingFilter, setGrouping: setGroupingFilter,
		squad: squadFilterB, setSquad: setSquadFilterB,
	}
	return (
		<div className={cn('flex w-full p-1 flex-col', props.className)}>
			<div className="grid w-full grid-cols-[1fr_auto_1fr] gap-1">
				<div>
					<TeamTitle teamId={'A'} />
				</div>
				<div></div>
				<div className="flex justify-end">
					<TeamTitle teamId={'B'} />
				</div>
				<div>
				</div>
			</div>
			{showSwapsPanel && <SwapsPanel className="my-1 rounded-md border bg-muted/40 px-2 py-1.5" />}
			<div className="grid w-full grid-cols-[1fr_auto_1fr] gap-1">
				<Input
					placeholder="Search Players..."
					value={searchQuery}
					onChange={e => setSearchQuery(e.target.value)}
					onKeyDown={e => {
						if (e.key !== 'Enter' || !searchQuery.trim()) return
						const { players } = SquadServerClient.ChatStore.getState().chatState.interpolatedState
						const names = players.map(p => p.ids.usernameNoTag ?? p.ids.username ?? '')
						const matched = new Set(StrUtils.simpleStringMatch(names, searchQuery))
						const matchedIds = players
							.filter((_, i) => matched.has(i))
							.map(p => SM.PlayerIds.getPlayerId(p.ids))
						SquadServerClient.PlayerSelectionStore.getState().setSelection(
							Object.fromEntries(matchedIds.map(id => [id, true])),
						)
					}}
				/>
				<span></span>
				<ControlPanel />
			</div>
			<div className="grid w-full grid-cols-[1fr_1fr] divide-x divide-border">
				<TeamPlayerTable teamId="A" searchQuery={searchQuery} filters={filtersA} />
				<TeamPlayerTable teamId="B" searchQuery={searchQuery} filters={filtersB} className="pl-1" />
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
		TSWClient.Store,
		TSWClient.Select.diffAfterSwitchesForTeam(props.teamId),
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
	const config = ConfigClient.useConfig()
	const playerFlagGroupings = config?.playerFlagGroupings
	const groupingModeIds = React.useMemo(
		() => playerFlagGroupings ? BM.getGroupingModeIds(playerFlagGroupings) : [],
		[playerFlagGroupings],
	)
	const selectedModeId = Zus.useStore(BattlemetricsClient.Store, s => s.selectedModeId)
	const setSelectedModeId = Zus.useStore(BattlemetricsClient.Store, s => s.setSelectedModeId)
	const activeModeId = selectedModeId !== null && groupingModeIds.includes(selectedModeId)
		? selectedModeId
		: groupingModeIds[0] ?? null

	if (groupingModeIds.length === 0) return null

	return (
		<div className="flex justify-end items-center gap-1">
			<span className="text-sm text-muted-foreground">Group by</span>
			<Select value={activeModeId ?? ''} onValueChange={(value) => setSelectedModeId(value || null)}>
				<SelectTrigger className="h-7 w-auto text-sm">
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					{groupingModeIds.map(id => <SelectItem key={id} value={id}>{id}</SelectItem>)}
				</SelectContent>
			</Select>
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
				formatter: (p: { value?: unknown }) => typeof p.value === 'number' && p.value > 0 ? String(p.value) : '',
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

function SelectOrSpinner({ playerId, checked, onCheckedChange }: {
	playerId: SM.PlayerId
	checked: boolean
	onCheckedChange: (checked: boolean) => void
}) {
	const isPending = ZusUtils.useStore(TSWClient.Store, TSWClient.Select.isSwitchPending(playerId))
	return (
		<div className="h-4 w-4 flex items-center justify-center shrink-0">
			{isPending
				? <Icons.LoaderCircle className="h-3 w-3 animate-spin text-muted-foreground" />
				: <Checkbox checked={checked} onCheckedChange={onCheckedChange} aria-label="Select row" />}
		</div>
	)
}

type PlayerFilters = {
	role: string | null
	setRole: (v: string | null) => void
	grouping: string | null
	setGrouping: (v: string | null) => void
	squad: string | null
	setSquad: (v: string | null) => void
}

type TeamPlayerTableMeta = {
	matchId: number
	squads: SM.UniqueSquad[]
	groupingColorByLabel: Map<string, string>
	filters: PlayerFilters
	availableRoles: string[]
	availableGroupings: string[]
}

function ColumnFilterSelect({ value, onChange, options }: {
	value: string | null
	onChange: (v: string | null) => void
	options: { value: string; label: string }[]
}) {
	if (options.length === 0) return null
	return (
		<select
			value={value ?? ''}
			onChange={e => onChange(e.target.value || null)}
			onClick={e => e.stopPropagation()}
			className={cn('ml-1 text-xs bg-transparent border-none cursor-pointer outline-none', value ? 'text-primary font-medium' : 'text-muted-foreground')}
		>
			<option value="">All</option>
			{options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
		</select>
	)
}

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
		cell: ({ row }) => {
			const playerId = row.id
			return (
				<SelectOrSpinner
					playerId={playerId}
					checked={row.getIsSelected()}
					onCheckedChange={checked => row.toggleSelected(!!checked)}
				/>
			)
		},
	}),
	playerColumnHelper.accessor(row => row.ids.usernameNoTag ?? row.ids.username ?? '', {
		id: 'name',
		header: 'Name',
		cell: ({ row, table }) => <PlayerDisplay player={row.original} matchId={(table.options.meta as TeamPlayerTableMeta).matchId} />,
	}),
	playerColumnHelper.accessor('role', {
		header: ({ table }) => {
			const { filters, availableRoles } = table.options.meta as TeamPlayerTableMeta
			return (
				<span className="inline-flex items-center">
					Role
					<ColumnFilterSelect value={filters.role} onChange={filters.setRole} options={availableRoles.map(r => ({ value: r, label: r }))} />
				</span>
			)
		},
		enableSorting: false,
	}),
	playerColumnHelper.accessor(row => row.grouping ?? '', {
		id: 'grouping',
		header: ({ table }) => {
			const { filters, availableGroupings } = table.options.meta as TeamPlayerTableMeta
			return (
				<span className="inline-flex items-center">
					Grouping
					<ColumnFilterSelect value={filters.grouping} onChange={filters.setGrouping} options={availableGroupings.map(g => ({ value: g, label: g }))} />
				</span>
			)
		},
		cell: ({ row, table }) => {
			const label = row.original.grouping
			if (!label) return null
			const { groupingColorByLabel } = table.options.meta as TeamPlayerTableMeta
			const color = groupingColorByLabel.get(label)
			return (
				<span className="flex items-center gap-1">
					{color && <span className="w-2 h-2 rounded-sm shrink-0" style={{ backgroundColor: color }} />}
					{label}
				</span>
			)
		},
	}),
	playerColumnHelper.accessor(row => row.squadId ?? -1, {
		id: 'squad',
		header: ({ table }) => {
			const { filters, squads } = table.options.meta as TeamPlayerTableMeta
			const squadOptions = squads.map(s => ({
				value: String(s.squadId),
				label: s.squadName === 'Command Squad' ? `CMD(${s.squadId})` : String(s.squadId),
			}))
			return (
				<span className="inline-flex items-center">
					Squad
					<ColumnFilterSelect value={filters.squad} onChange={filters.setSquad} options={squadOptions} />
				</span>
			)
		},
		cell: ({ row, table }) => {
			const { squads, matchId } = table.options.meta as TeamPlayerTableMeta
			const player = row.original
			const squadId = player.squadId
			if (squadId === null) return ''
			const squad = squads.find(s => s.squadId === squadId)
			if (!squad) return String(squadId)
			const isCmd = squad.squadName === 'Command Squad'
			const squadLabel = isCmd
				? <span>CMD({squadId})</span>
				: (
					<OpenWindowInteraction
						windowId={WINDOW_ID.enum['squad-details']}
						windowProps={{ uniqueSquadId: squad.uniqueId } satisfies SquadDetailsWindowProps}
						preload="intent"
						render={(
							{ label, ref, ...props }:
								& { label: string; ref?: React.Ref<HTMLButtonElement> }
								& React.ButtonHTMLAttributes<HTMLButtonElement>,
						) => <button ref={ref} type="button" className="hover:underline cursor-pointer" {...props}>{label}</button>}
						label={String(squadId)}
					/>
				)
			return (
				<span className="inline-flex items-center gap-1">
					<ContextMenu>
						<ContextMenuTrigger>{squadLabel}</ContextMenuTrigger>
						<ContextMenuContent>
							<SquadContextMenuOptions squad={squad} />
						</ContextMenuContent>
					</ContextMenu>
					{player.isLeader && <span className="text-xs text-muted-foreground">(SL)</span>}
				</span>
			)
		},
	}),
]

function TeamPlayerTable(props: { teamId: MH.NormedTeamId; searchQuery: string; filters: PlayerFilters; className?: string }) {
	const rowSelection = Zus.useStore(SquadServerClient.PlayerSelectionStore, s => s.selection)
	const setRowSelection = SquadServerClient.PlayerSelectionStore.getState().setSelection
	const [sorting, setSorting] = React.useState<SortingState>([])
	const match = MatchHistoryClient.useCurrentMatch()
	const matchId = match?.historyEntryId ?? 0

	const config = ConfigClient.useConfig()
	const orgFlags = BattlemetricsClient.useOrgFlags()
	const selectedModeId = Zus.useStore(BattlemetricsClient.Store, s => s.selectedModeId)
	const groupingColorByLabel = React.useMemo(() => {
		const playerFlagGroupings = config?.playerFlagGroupings ?? []
		const modeIds = BM.getGroupingModeIds(playerFlagGroupings)
		const activeModeId = selectedModeId !== null && modeIds.includes(selectedModeId)
			? selectedModeId
			: modeIds[0] ?? null
		if (!activeModeId) return new Map<string, string>()
		const modeGroupings = playerFlagGroupings.filter(g => g.modeIds.includes(activeModeId))
		const flagColorById = new Map<string, string>()
		for (const flag of orgFlags ?? []) {
			if (flag.color) flagColorById.set(flag.id, flag.color)
		}
		const result = new Map<string, string>()
		for (const group of modeGroupings) {
			result.set(group.label, flagColorById.get(group.color) ?? group.color)
		}
		return result
	}, [config, orgFlags, selectedModeId])

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

	const availableRoles = React.useMemo(
		() => [...new Set(players.map(p => p.role).filter((r): r is string => r != null))].sort(),
		[players],
	)
	const availableGroupings = React.useMemo(
		() => [...new Set(players.map(p => p.grouping).filter((g): g is string => g != null))].sort(),
		[players],
	)

	const filteredPlayers = React.useMemo(() => {
		let result = players
		if (props.searchQuery.trim()) {
			const names = players.map(p => p.ids.usernameNoTag ?? p.ids.username ?? '')
			const matched = new Set(StrUtils.simpleStringMatch(names, props.searchQuery))
			result = players.filter((_, i) => matched.has(i))
		}
		const { role, grouping, squad } = props.filters
		if (role !== null) result = result.filter(p => p.role === role)
		if (grouping !== null) result = result.filter(p => (p.grouping ?? null) === grouping)
		if (squad !== null) result = result.filter(p => p.squadId === Number(squad))
		return result
	}, [players, props.searchQuery, props.filters])

	const table = useReactTable({
		data: filteredPlayers,
		columns: playerColumns,
		getCoreRowModel: getCoreRowModel(),
		getSortedRowModel: getSortedRowModel(),
		getRowId: row => SM.PlayerIds.getPlayerId(row.ids),
		state: { rowSelection, sorting },
		onRowSelectionChange: setRowSelection,
		onSortingChange: setSorting,
		meta: { matchId, squads, groupingColorByLabel, filters: props.filters, availableRoles, availableGroupings } satisfies TeamPlayerTableMeta,
	})

	return (
		<Table className={props.className}>
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
				{table.getRowModel().rows.map(row => {
					const selectedIds = Object.keys(rowSelection)
					const isBulk = selectedIds.length >= 2 && rowSelection[row.id]
					return (
						<ContextMenu key={row.id}>
							<ContextMenuTrigger asChild>
								<TableRow data-state={row.getIsSelected() ? 'selected' : undefined}>
									{row.getVisibleCells().map(cell => (
										<TableCell key={cell.id}>
											{flexRender(cell.column.columnDef.cell, cell.getContext())}
										</TableCell>
									))}
								</TableRow>
							</ContextMenuTrigger>
							<ContextMenuContent>
								{isBulk
									? <PlayerBulkContextMenuOptions playerIds={selectedIds} />
									: <PlayerContextMenuOptions playerId={row.id} />}
							</ContextMenuContent>
						</ContextMenu>
					)
				})}
			</TableBody>
		</Table>
	)
}

function TeamsAfterSwap() {
	const countA = ZusUtils.useStore(
		SquadServerClient.ChatStore,
		MatchHistoryClient.currentMatch$(),
		SquadServer.Select.teamPlayerCount('A'),
	)
	const countB = ZusUtils.useStore(
		SquadServerClient.ChatStore,
		MatchHistoryClient.currentMatch$(),
		SquadServer.Select.teamPlayerCount('B'),
	)
	const diffA = Zus.useStore(TSWClient.Store, TSWClient.Select.diffAfterSwitchesForTeam('A'))
	const diffB = Zus.useStore(TSWClient.Store, TSWClient.Select.diffAfterSwitchesForTeam('B'))
	return (
		<div className="flex flex-col items-center">
			<span className="text-xs text-muted-foreground">Teams After Swap</span>
			<span className="text-sm font-mono">{(countA ?? 0) + diffA}v{(countB ?? 0) + diffB}</span>
		</div>
	)
}

function SwapsPanel({ className }: { className?: string }) {
	const canExecute = Zus.useStore(TSWClient.Store, TSWClient.Select.canExecuteSavedTeamswitches)
	const hasPendingEdits = Zus.useStore(TSWClient.Store, TSWClient.Select.hasPendingEdits)
	return (
		<div className={cn('grid grid-cols-[1fr_auto_1fr] items-start divide-x divide-border', className)}>
			<TeamSwapsDisplay teamId="A" className="pr-2" />
			<div className="flex flex-col items-center gap-1 px-2">
				<div className="flex items-center gap-1">
					<Button
						variant="ghost"
						size="icon"
						className="h-7 w-7"
						disabled={!hasPendingEdits}
						onClick={() => TSWClient.Actions.revertToSaved()}
						title="Revert to saved"
					>
						<Icons.Undo2 className="h-3.5 w-3.5" />
					</Button>
					<Button size="sm" disabled={!hasPendingEdits} onClick={() => TSWClient.Actions.save()}>
						Save
					</Button>
					<AlertDialog>
						<AlertDialogTrigger asChild>
							<Button size="sm" disabled={!canExecute}>
								Switch Now
							</Button>
						</AlertDialogTrigger>
						<AlertDialogContent>
							<AlertDialogHeader>
								<AlertDialogTitle>Execute team switches?</AlertDialogTitle>
								<AlertDialogDescription>
									This will immediately move all queued players to their assigned teams.
								</AlertDialogDescription>
							</AlertDialogHeader>
							<AlertDialogFooter>
								<AlertDialogCancel>Cancel</AlertDialogCancel>
								<AlertDialogAction onClick={() => TSWClient.Actions.executeTeamswitches()}>
									Switch Now
								</AlertDialogAction>
							</AlertDialogFooter>
						</AlertDialogContent>
					</AlertDialog>
					<OpenWindowInteraction
						windowId={WINDOW_ID.enum['teamswitches-help']}
						windowProps={{} satisfies TeamswitchesHelpWindowProps}
						preload="intent"
						render={({ ref, ...props }: { ref?: React.Ref<HTMLButtonElement> } & React.ButtonHTMLAttributes<HTMLButtonElement>) => (
							<Button ref={ref} variant="ghost" size="icon" className="h-7 w-7" title="Help" {...props}>
								<Icons.CircleHelp className="h-3.5 w-3.5" />
							</Button>
						)}
					/>
				</div>
				<TeamsAfterSwap />
			</div>
			<TeamSwapsDisplay teamId="B" align="right" className="pl-2" />
		</div>
	)
}

function TeamSwapsDisplay(props: { teamId: MH.NormedTeamId; align?: 'left' | 'right'; className?: string }) {
	const switches = ZusUtils.useStore(
		TSWClient.Store,
		SquadServerClient.ChatStore,
		React.useCallback(
			(teamsSwitchesStore: TSWClient.Store, chatStore: SquadServer.ChatStore) =>
				TSWClient.Select.switchesToTeamEnrichedWithMutations(teamsSwitchesStore, chatStore, props.teamId),
			[props.teamId],
		),
	)

	const hasLocal = [...switches.values()].some(s => !s.mutation.removed)
	const isRight = props.align === 'right'

	return (
		<div className={cn('flex flex-col gap-0.5', isRight && 'items-end', props.className)}>
			<h3 className="text-sm">
				Swaps to current <MatchTeamDisplay teamId={props.teamId} showAltTeamIndicator={true} />
			</h3>
			<div className={cn('flex flex-wrap items-center gap-1', isRight && 'justify-end')}>
				{switches.size > 0 && <span className="text-xs text-muted-foreground shrink-0">({switches.size})</span>}
				{switches.size === 0 && <span className="text-muted-foreground text-sm">No swaps yet</span>}
				{MapUtils.mapToArray(switches, (playerId, s) => <SwitchBadge switch={s} key={playerId} />)}
				{hasLocal && (
					<Button
						variant="ghost"
						size="icon"
						className="h-6 w-6 shrink-0"
						onClick={() => TSWClient.Actions.clearTeamSwitches(props.teamId)}
						title="Clear all"
					>
						<Icons.Trash2 className="h-3 w-3" />
					</Button>
				)}
			</div>
		</div>
	)
}

function SwitchBadge(props: { switch: TSWClient.Select.EnrichedTeamswitchWithMutation }) {
	const { mutation } = props.switch
	const playerId = SM.PlayerIds.getPlayerId(props.switch.player.ids)

	function remove() {
		const userId = UsersClient.loggedInUserId
		TSWClient.Store.getState().dispatch({
			code: 'remove-player-teamswitches',
			playerId,
			source: { discordId: userId },
			saved: false,
		})
	}

	const variant = mutation.added ? 'added' : mutation.removed ? 'removed' : 'secondary'

	return (
		<Badge variant={variant} className="flex items-center gap-1">
			<span className={mutation.removed ? 'line-through opacity-60' : undefined}>
				{props.switch.player.ids.username}
			</span>
			{!mutation.removed && (
				<button type="button" onClick={remove} className="ml-1 hover:text-destructive">
					<Icons.X className="h-3 w-3" />
				</button>
			)}
		</Badge>
	)
}
