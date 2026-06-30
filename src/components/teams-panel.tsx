import { PermissionDeniedTooltip } from '@/components/permission-denied-tooltip'
import { useIsDesktopSize } from '@/lib/browser'
import * as MapUtils from '@/lib/map'
import * as StrUtils from '@/lib/string'
import { cn } from '@/lib/utils.ts'
import * as ZusUtils from '@/lib/zustand'
import * as BM from '@/models/battlemetrics.models'
import { WINDOW_ID } from '@/models/draggable-windows.models'
import * as L from '@/models/layer'
import * as MH from '@/models/match-history.models'
import * as SquadServer from '@/models/squad-server.models'
import * as SM from '@/models/squad.models'
import * as TeamsPanelModels from '@/models/teams-panel.models'
import * as TSW from '@/models/teamswitches.models'
import * as RBAC from '@/rbac.models.ts'
import * as BattlemetricsClient from '@/systems/battlemetrics.client'
import * as ConfigClient from '@/systems/config.client'
import * as MatchHistoryClient from '@/systems/match-history.client'
import * as RbacClient from '@/systems/rbac.client'
import * as SquadServerClient from '@/systems/squad-server.client'
import * as TSWClient from '@/systems/teamswitches.client'
import * as ThemeClient from '@/systems/theme.client'
import * as UPClient from '@/systems/user-presence.client'
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
import { PlayerDisplay } from './player-display'
import SquadContextMenuOptions from './squad-context-menu-options'
import type { SquadDetailsWindowProps } from './squad-details-window.helpers'
import { MatchTeamDisplay } from './teams-display'
import type { TeamswitchesHelpWindowProps } from './teamswitches-help-window.helpers'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from './ui/alert-dialog'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { ButtonGroup } from './ui/button-group'
import { Checkbox } from './ui/checkbox'
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from './ui/context-menu'
import { OpenWindowInteraction } from './ui/draggable-window'
import { Input } from './ui/input'
import { Label } from './ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select'
import { Switch } from './ui/switch'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip.tsx'

void import('@/components/squad-details-window')
void import('@/components/teamswitches-help-window')

export default function TeamsPanel(props: { className?: string }) {
	const isDesktop = useIsDesktopSize()
	const showSwapsPanel = ZusUtils.useStore(
		TSWClient.Store,
		UPClient.Store,
		(tswStore, upStore) => TSWClient.Select.hasSwitches(tswStore) || upStore.teamswitchEditors.size > 0,
	)
	const [searchQuery, setSearchQuery] = React.useState('')
	const [showSelected, setShowSelected] = React.useState(false)
	const selectedCount = Zus.useStore(SquadServerClient.PlayerSelectionStore, s => Object.values(s.selection).filter(Boolean).length)
	const showSelectedId = React.useId()
	React.useEffect(() => {
		if (selectedCount === 0 && showSelected) setShowSelected(false)
	}, [selectedCount, showSelected])
	const [roleFilter, setRoleFilter] = React.useState<string | null>(null)
	const [groupingFilter, setGroupingFilter] = React.useState<string | null>(null)
	const [squadFilterA, setSquadFilterA] = React.useState<string | null>(null)
	const [squadFilterB, setSquadFilterB] = React.useState<string | null>(null)
	const [squadFilterCombined, setSquadFilterCombined] = React.useState<string | null>(null)
	const filtersA: PlayerFilters = {
		role: roleFilter,
		setRole: setRoleFilter,
		grouping: groupingFilter,
		setGrouping: setGroupingFilter,
		squad: squadFilterA,
		setSquad: setSquadFilterA,
	}
	const filtersB: PlayerFilters = {
		role: roleFilter,
		setRole: setRoleFilter,
		grouping: groupingFilter,
		setGrouping: setGroupingFilter,
		squad: squadFilterB,
		setSquad: setSquadFilterB,
	}
	const filtersC: PlayerFilters = {
		role: roleFilter,
		setRole: setRoleFilter,
		grouping: groupingFilter,
		setGrouping: setGroupingFilter,
		squad: squadFilterCombined,
		setSquad: setSquadFilterCombined,
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
				<div className="flex items-center gap-2 justify-center">
					<Switch
						id={showSelectedId}
						checked={showSelected}
						disabled={selectedCount === 0}
						onCheckedChange={() => setShowSelected(v => !v)}
					/>
					<Label htmlFor={showSelectedId} className="text-sm whitespace-nowrap">Show Selected</Label>
					{selectedCount > 0 && <span className="text-xs text-muted-foreground">({selectedCount})</span>}
					<Button
						variant="ghost"
						size="icon"
						className="h-7 w-7"
						disabled={selectedCount === 0}
						title="Clear selected players"
						onClick={() => SquadServerClient.PlayerSelectionStore.getState().setSelection({})}
					>
						<Icons.Trash className="h-4 w-4" />
					</Button>
				</div>
				<ControlPanel />
			</div>
			{isDesktop
				? (
					<div className="grid w-full grid-cols-[1fr_1fr] divide-x divide-border">
						<TeamPlayerTable teamId="A" searchQuery={searchQuery} filters={filtersA} showSelected={showSelected} />
						<TeamPlayerTable teamId="B" searchQuery={searchQuery} filters={filtersB} showSelected={showSelected} className="pl-1" />
					</div>
				)
				: <CombinedPlayerTable searchQuery={searchQuery} filters={filtersC} showSelected={showSelected} />}
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
			className={cn(
				'ml-1 text-xs bg-transparent border-none cursor-pointer outline-none',
				value ? 'text-primary font-medium' : 'text-muted-foreground',
			)}
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
				<div onClick={e => e.stopPropagation()}>
					<SelectOrSpinner
						playerId={playerId}
						checked={row.getIsSelected()}
						onCheckedChange={checked => row.toggleSelected(!!checked)}
					/>
				</div>
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
					<ColumnFilterSelect
						value={filters.grouping}
						onChange={filters.setGrouping}
						options={availableGroupings.map(g => ({ value: g, label: g }))}
					/>
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
							{ label, ref, onClick, ...rest }:
								& { label: string; ref?: React.Ref<HTMLButtonElement>; onClick?: React.MouseEventHandler<HTMLButtonElement> }
								& React.ButtonHTMLAttributes<HTMLButtonElement>,
						) => (
							<button
								ref={ref}
								type="button"
								className="hover:underline cursor-pointer"
								onClick={e => {
									e.stopPropagation()
									onClick?.(e)
								}}
								{...rest}
							>
								{label}
							</button>
						)}
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

function TeamPlayerTable(
	props: { teamId: MH.NormedTeamId; searchQuery: string; filters: PlayerFilters; showSelected: boolean; className?: string },
) {
	const rowSelection = Zus.useStore(SquadServerClient.PlayerSelectionStore, s => s.selection)
	const savedSwitches = Zus.useStore(TSWClient.Store, s => TSWClient.Select.localState(s).savedSwitches)
	const setRowSelection = SquadServerClient.PlayerSelectionStore.getState().setSelection
	const mouseDownRef = React.useRef<{ index: number; originalSelected: boolean } | null>(null)
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

	const displayedPlayers = React.useMemo(() => {
		if (!props.showSelected) return filteredPlayers
		return filteredPlayers.filter(p => !!rowSelection[SM.PlayerIds.getPlayerId(p.ids)])
	}, [filteredPlayers, props.showSelected, rowSelection])

	const table = useReactTable({
		data: displayedPlayers,
		columns: playerColumns,
		getCoreRowModel: getCoreRowModel(),
		getSortedRowModel: getSortedRowModel(),
		getRowId: row => SM.PlayerIds.getPlayerId(row.ids),
		state: { rowSelection, sorting },
		onRowSelectionChange: setRowSelection,
		onSortingChange: setSorting,
		meta: {
			matchId,
			squads,
			groupingColorByLabel,
			filters: props.filters,
			availableRoles,
			availableGroupings,
		} satisfies TeamPlayerTableMeta,
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
								<TableRow
									className={cn('cursor-pointer select-none', savedSwitches.has(row.id) && 'bg-amber-500/20')}
									data-state={row.getIsSelected() ? 'selected' : undefined}
									onClick={() => row.toggleSelected()}
									onMouseDown={e => {
										if (e.button !== 0) return
										mouseDownRef.current = { index: row.index, originalSelected: !rowSelection[row.id] }
									}}
									onMouseUp={() => {
										mouseDownRef.current = null
									}}
									onMouseEnter={() => {
										const md = mouseDownRef.current
										if (!md) return
										const [lo, hi] = [Math.min(md.index, row.index), Math.max(md.index, row.index)]
										const current = { ...SquadServerClient.PlayerSelectionStore.getState().selection }
										for (let i = lo; i <= hi; i++) {
											const p = displayedPlayers[i]
											if (!p) continue
											const pid = SM.PlayerIds.getPlayerId(p.ids)
											if (md.originalSelected) {
												current[pid] = true
											} else {
												delete current[pid]
											}
										}
										setRowSelection(current)
										mouseDownRef.current = { index: row.index, originalSelected: md.originalSelected }
									}}
								>
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

type CombinedPlayer = TeamsPanelModels.EnrichedPlayer & { normedTeam: MH.NormedTeamId }

type SquadWithTeam = { squad: SM.UniqueSquad; normedTeam: MH.NormedTeamId }

type CombinedTableMeta = {
	matchId: number
	squadsWithTeam: SquadWithTeam[]
	groupingColorByLabel: Map<string, string>
	filters: PlayerFilters
	availableRoles: string[]
	availableGroupings: string[]
	getFaction: (normedTeam: MH.NormedTeamId) => string
}

const combinedColumnHelper = createColumnHelper<CombinedPlayer>()

const combinedPlayerColumns = [
	combinedColumnHelper.display({
		id: 'select',
		header: ({ table }) => (
			<Checkbox
				checked={table.getIsAllRowsSelected()}
				onCheckedChange={checked => table.toggleAllRowsSelected(!!checked)}
				aria-label="Select all"
			/>
		),
		cell: ({ row }) => (
			<div onClick={e => e.stopPropagation()}>
				<SelectOrSpinner
					playerId={row.id}
					checked={row.getIsSelected()}
					onCheckedChange={checked => row.toggleSelected(!!checked)}
				/>
			</div>
		),
	}),
	combinedColumnHelper.accessor(row => row.normedTeam, {
		id: 'faction',
		header: 'Faction',
		cell: ({ row, table }) => (table.options.meta as CombinedTableMeta).getFaction(row.original.normedTeam),
	}),
	combinedColumnHelper.accessor(row => row.ids.usernameNoTag ?? row.ids.username ?? '', {
		id: 'name',
		header: 'Name',
		cell: ({ row, table }) => <PlayerDisplay player={row.original} matchId={(table.options.meta as CombinedTableMeta).matchId} />,
	}),
	combinedColumnHelper.accessor('role', {
		header: ({ table }) => {
			const { filters, availableRoles } = table.options.meta as CombinedTableMeta
			return (
				<span className="inline-flex items-center">
					Role
					<ColumnFilterSelect value={filters.role} onChange={filters.setRole} options={availableRoles.map(r => ({ value: r, label: r }))} />
				</span>
			)
		},
		enableSorting: false,
	}),
	combinedColumnHelper.accessor(row => row.grouping ?? '', {
		id: 'grouping',
		header: ({ table }) => {
			const { filters, availableGroupings } = table.options.meta as CombinedTableMeta
			return (
				<span className="inline-flex items-center">
					Grouping
					<ColumnFilterSelect
						value={filters.grouping}
						onChange={filters.setGrouping}
						options={availableGroupings.map(g => ({ value: g, label: g }))}
					/>
				</span>
			)
		},
		cell: ({ row, table }) => {
			const label = row.original.grouping
			if (!label) return null
			const { groupingColorByLabel } = table.options.meta as CombinedTableMeta
			const color = groupingColorByLabel.get(label)
			return (
				<span className="flex items-center gap-1">
					{color && <span className="w-2 h-2 rounded-sm shrink-0" style={{ backgroundColor: color }} />}
					{label}
				</span>
			)
		},
	}),
	combinedColumnHelper.accessor(row => row.squadId ?? -1, {
		id: 'squad',
		header: ({ table }) => {
			const { filters, squadsWithTeam, getFaction } = table.options.meta as CombinedTableMeta
			const squadOptions = squadsWithTeam.map(({ squad: s, normedTeam }) => {
				const faction = getFaction(normedTeam)
				const isCmd = s.squadName === 'Command Squad'
				return {
					value: `${normedTeam}:${s.squadId}`,
					label: isCmd ? `${faction}:CMD` : `${faction}:${s.squadId}`,
				}
			})
			return (
				<span className="inline-flex items-center">
					Squad
					<ColumnFilterSelect value={filters.squad} onChange={filters.setSquad} options={squadOptions} />
				</span>
			)
		},
		cell: ({ row, table }) => {
			const { squadsWithTeam, matchId, getFaction } = table.options.meta as CombinedTableMeta
			const player = row.original
			const squadId = player.squadId
			if (squadId === null) return ''
			const entry = squadsWithTeam.find(({ squad: s, normedTeam }) => s.squadId === squadId && normedTeam === player.normedTeam)
			if (!entry) return `${getFaction(player.normedTeam)}:${squadId}`
			const { squad, normedTeam } = entry
			const faction = getFaction(normedTeam)
			const isCmd = squad.squadName === 'Command Squad'
			const displayLabel = isCmd ? `${faction}:CMD` : `${faction}:${squadId}`
			const squadLabel = isCmd
				? <span>{displayLabel}</span>
				: (
					<OpenWindowInteraction
						windowId={WINDOW_ID.enum['squad-details']}
						windowProps={{ uniqueSquadId: squad.uniqueId } satisfies SquadDetailsWindowProps}
						preload="intent"
						render={(
							{ label, ref, onClick, ...rest }:
								& { label: string; ref?: React.Ref<HTMLButtonElement>; onClick?: React.MouseEventHandler<HTMLButtonElement> }
								& React.ButtonHTMLAttributes<HTMLButtonElement>,
						) => (
							<button
								ref={ref}
								type="button"
								className="hover:underline cursor-pointer"
								onClick={e => {
									e.stopPropagation()
									onClick?.(e)
								}}
								{...rest}
							>
								{label}
							</button>
						)}
						label={displayLabel}
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

function CombinedPlayerTable(props: { searchQuery: string; filters: PlayerFilters; showSelected: boolean; className?: string }) {
	const rowSelection = Zus.useStore(SquadServerClient.PlayerSelectionStore, s => s.selection)
	const savedSwitches = Zus.useStore(TSWClient.Store, s => TSWClient.Select.localState(s).savedSwitches)
	const setRowSelection = SquadServerClient.PlayerSelectionStore.getState().setSelection
	const mouseDownRef = React.useRef<{ index: number; originalSelected: boolean } | null>(null)
	const [sorting, setSorting] = React.useState<SortingState>([{ id: 'faction', desc: false }])
	const match = MatchHistoryClient.useCurrentMatch()
	const matchId = match?.historyEntryId ?? 0

	const config = ConfigClient.useConfig()
	const orgFlags = BattlemetricsClient.useOrgFlags()
	const selectedModeId = Zus.useStore(BattlemetricsClient.Store, s => s.selectedModeId)
	const groupingColorByLabel = React.useMemo(() => {
		const playerFlagGroupings = config?.playerFlagGroupings ?? []
		const modeIds = BM.getGroupingModeIds(playerFlagGroupings)
		const activeModeId = selectedModeId !== null && modeIds.includes(selectedModeId) ? selectedModeId : modeIds[0] ?? null
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

	// eslint-disable-next-line react-hooks/exhaustive-deps
	const selectorA = React.useCallback(TeamsPanelModels.Select.playersForTeam('A'), [])
	// eslint-disable-next-line react-hooks/exhaustive-deps
	const selectorB = React.useCallback(TeamsPanelModels.Select.playersForTeam('B'), [])
	const playersA = ZusUtils.useStore(
		SquadServerClient.ChatStore,
		MatchHistoryClient.currentMatch$(),
		BattlemetricsClient.playerBmData$,
		BattlemetricsClient.Store,
		ConfigClient.Store,
		selectorA,
	)
	const playersB = ZusUtils.useStore(
		SquadServerClient.ChatStore,
		MatchHistoryClient.currentMatch$(),
		BattlemetricsClient.playerBmData$,
		BattlemetricsClient.Store,
		ConfigClient.Store,
		selectorB,
	)

	// eslint-disable-next-line react-hooks/exhaustive-deps
	const squadsASelector = React.useCallback(SquadServer.Select.squadsForTeam('A'), [])
	// eslint-disable-next-line react-hooks/exhaustive-deps
	const squadsBSelector = React.useCallback(SquadServer.Select.squadsForTeam('B'), [])
	const squadsA = ZusUtils.useStore(SquadServerClient.ChatStore, MatchHistoryClient.currentMatch$(), squadsASelector)
	const squadsB = ZusUtils.useStore(SquadServerClient.ChatStore, MatchHistoryClient.currentMatch$(), squadsBSelector)
	const squadsWithTeam = React.useMemo<SquadWithTeam[]>(() => [
		...squadsA.map(squad => ({ squad, normedTeam: 'A' as const })),
		...squadsB.map(squad => ({ squad, normedTeam: 'B' as const })),
	], [squadsA, squadsB])

	const layer = React.useMemo(() => {
		if (!match?.layerId) return null
		const l = L.toLayer(match.layerId)
		return L.isKnownLayer(l) ? l : null
	}, [match?.layerId])
	const teamAIsTeam1 = (match?.ordinal ?? 0) % 2 === 0

	const getFaction = React.useCallback((normedTeam: MH.NormedTeamId): string => {
		if (!layer) return normedTeam
		const isTeam1 = normedTeam === 'A' ? teamAIsTeam1 : !teamAIsTeam1
		return isTeam1 ? layer.Faction_1 : layer.Faction_2
	}, [layer, teamAIsTeam1])

	const players = React.useMemo<CombinedPlayer[]>(() => [
		...playersA.map(p => ({ ...p, normedTeam: 'A' as const })),
		...playersB.map(p => ({ ...p, normedTeam: 'B' as const })),
	], [playersA, playersB])

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
		if (squad !== null) result = result.filter(p => squad === `${p.normedTeam}:${p.squadId}`)
		return result
	}, [players, props.searchQuery, props.filters])

	const displayedPlayers = React.useMemo(() => {
		if (!props.showSelected) return filteredPlayers
		return filteredPlayers.filter(p => !!rowSelection[SM.PlayerIds.getPlayerId(p.ids)])
	}, [filteredPlayers, props.showSelected, rowSelection])

	const table = useReactTable({
		data: displayedPlayers,
		columns: combinedPlayerColumns,
		getCoreRowModel: getCoreRowModel(),
		getSortedRowModel: getSortedRowModel(),
		getRowId: row => SM.PlayerIds.getPlayerId(row.ids),
		state: { rowSelection, sorting },
		onRowSelectionChange: setRowSelection,
		onSortingChange: setSorting,
		meta: {
			matchId,
			squadsWithTeam,
			groupingColorByLabel,
			filters: props.filters,
			availableRoles,
			availableGroupings,
			getFaction,
		} satisfies CombinedTableMeta,
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
								<TableRow
									className={cn('cursor-pointer select-none', savedSwitches.has(row.id) && 'bg-amber-500/20')}
									data-state={row.getIsSelected() ? 'selected' : undefined}
									onClick={() => row.toggleSelected()}
									onMouseDown={e => {
										if (e.button !== 0) return
										mouseDownRef.current = { index: row.index, originalSelected: !rowSelection[row.id] }
									}}
									onMouseUp={() => {
										mouseDownRef.current = null
									}}
									onMouseEnter={() => {
										const md = mouseDownRef.current
										if (!md) return
										const [lo, hi] = [Math.min(md.index, row.index), Math.max(md.index, row.index)]
										const current = { ...SquadServerClient.PlayerSelectionStore.getState().selection }
										for (let i = lo; i <= hi; i++) {
											const p = displayedPlayers[i]
											if (!p) continue
											const pid = SM.PlayerIds.getPlayerId(p.ids)
											if (md.originalSelected) {
												current[pid] = true
											} else {
												delete current[pid]
											}
										}
										setRowSelection(current)
										mouseDownRef.current = { index: row.index, originalSelected: md.originalSelected }
									}}
								>
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
	const { countA, countB } = ZusUtils.useStore(
		TSWClient.Store,
		SquadServerClient.ChatStore,
		MatchHistoryClient.currentMatch$(),
		(tswStore, chatStore, currentMatch) => {
			const editedSwitches = TSWClient.Select.localState(tswStore).editedSwitches
			const players = SquadServer.Select.chatState(chatStore).players
			if (!currentMatch) return { countA: 0, countB: 0 }
			let countA = 0
			let countB = 0
			for (const player of players) {
				if (player.teamId === null) continue
				const playerId = SM.PlayerIds.getPlayerId(player.ids)
				const sw = editedSwitches.get(playerId)
				const destTeam = sw?.toTeam ?? MH.getNormedTeamId(player.teamId, currentMatch.ordinal)
				if (destTeam === 'A') countA++
				else countB++
			}
			return { countA, countB }
		},
	)
	return (
		<div className="flex flex-col items-center">
			<span className="text-xs text-muted-foreground">Teams After Swap</span>
			<span className="text-sm font-mono">{countA}v{countB}</span>
		</div>
	)
}

function SwapsPanel({ className }: { className?: string }) {
	const canExecute = Zus.useStore(TSWClient.Store, TSWClient.Select.canExecuteSavedTeamswitches)
	const switchesModified = Zus.useStore(TSWClient.Store, TSWClient.Select.switchesModified)
	const [isEditing, setIsEditing] = UPClient.useEditingTeamswitchesState()
	const numEditors = Zus.useStore(UPClient.Store, s => s.teamswitchEditors.size)
	const [forceSave, setForceSave] = React.useState(false)
	const startEditingDenied = RbacClient.usePermsCheck(RBAC.perm('squad-server:manage-players'))

	const handleFinishOrSave = () => {
		const shouldSave = switchesModified && (numEditors <= 1 || forceSave)
		setIsEditing(false)
		if (shouldSave) {
			TSWClient.Actions.save()
		}
		setForceSave(false)
	}

	const saveButtonLabel = forceSave
		? 'Force Save'
		: (numEditors <= 1 && switchesModified)
		? 'Save'
		: 'Finish Editing'

	return (
		<div className={cn('grid grid-cols-[1fr_auto_1fr] items-start divide-x divide-border', className)}>
			<TeamSwapsDisplay teamId="A" className="pr-2" />
			<div className="flex flex-col items-center gap-1 px-2">
				<div className="flex items-center gap-1">
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								variant="ghost"
								size="icon"
								className="h-7 w-7"
								disabled={!isEditing || !switchesModified}
								onClick={() => TSWClient.Actions.revertToSaved()}
							>
								<Icons.Undo2 className="h-3.5 w-3.5" />
							</Button>
						</TooltipTrigger>
						<TooltipContent>Revert to saved</TooltipContent>
					</Tooltip>
					{isEditing
						? (
							<ButtonGroup>
								<Tooltip>
									<TooltipTrigger asChild>
										<Button
											size="icon"
											className="h-8 w-8"
											variant={forceSave ? 'destructive' : 'secondary'}
											onClick={() => setForceSave(!forceSave)}
										>
											<Icons.Sword className="h-3.5 w-3.5" />
										</Button>
									</TooltipTrigger>
									<TooltipContent>Toggle force save (save even if others are still editing)</TooltipContent>
								</Tooltip>
								<Button
									size="sm"
									variant={forceSave ? 'destructive' : 'default'}
									onClick={handleFinishOrSave}
								>
									{saveButtonLabel}
								</Button>
							</ButtonGroup>
						)
						: (
							<PermissionDeniedTooltip denied={startEditingDenied}>
								<Button
									size="sm"
									variant="outline"
									disabled={!!startEditingDenied}
									onClick={() => setIsEditing(true)}
								>
									<Icons.Edit className="h-3.5 w-3.5" />
									Start Editing
								</Button>
							</PermissionDeniedTooltip>
						)}
					<AlertDialog>
						<AlertDialogTrigger asChild>
							<Button size="sm" disabled={!canExecute || numEditors > 0}>
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
	const variant = mutation.added ? 'added' : mutation.removed ? 'removed' : 'secondary'

	return (
		<Badge variant={variant} className="flex items-center gap-1">
			<span className={mutation.removed ? 'line-through opacity-60' : undefined}>
				{props.switch.player.ids.username}
			</span>
			{!mutation.removed && (
				<button
					type="button"
					onClick={() => TSWClient.Actions.removeSwitch([playerId])}
					className="ml-1 hover:text-destructive"
				>
					<Icons.X className="h-3 w-3" />
				</button>
			)}
		</Badge>
	)
}
