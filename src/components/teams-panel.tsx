import { PermissionDeniedTooltip } from '@/components/permission-denied-tooltip'
import * as ChatPrt from '@/frame-partials/chat.partial'
import type * as SquadServerFrame from '@/frames/squad-server.frame'
import { useIsDesktopSize } from '@/lib/browser'
import * as DH from '@/lib/display-helpers'
import * as MapUtils from '@/lib/map'
import * as StrUtils from '@/lib/string'
import { cn } from '@/lib/utils.ts'
import * as ZusUtils from '@/lib/zustand'
import * as BM from '@/models/battlemetrics.models'
import { WINDOW_ID } from '@/models/draggable-windows.models'
import * as L from '@/models/layer'
import * as MH from '@/models/match-history.models'
import * as SM from '@/models/squad.models'
import * as TeamsPanelModels from '@/models/teams-panel.models'

import * as RBAC from '@/rbac.models.ts'
import * as BattlemetricsClient from '@/systems/battlemetrics.client'
import * as MatchHistoryClient from '@/systems/match-history.client'
import * as RbacClient from '@/systems/rbac.client'
import * as SettingsClient from '@/systems/settings.client'
import * as SquadServerClient from '@/systems/squad-server.client'
import * as TSWClient from '@/systems/teamswitches.client'
import * as UPClient from '@/systems/user-presence.client'

import { createColumnHelper, flexRender, getCoreRowModel, getSortedRowModel, useReactTable } from '@tanstack/react-table'
import type { CellContext, ColumnDef, ColumnHelper, HeaderContext, Row, SortingState } from '@tanstack/react-table'
import * as Icons from 'lucide-react'
import React from 'react'
import PlayerBulkContextMenuOptions from './player-bulk-context-menu-options'
import PlayerContextMenuOptions from './player-context-menu-options'
import { PlayerDisplay } from './player-display'
import SquadContextMenuOptions from './squad-context-menu-options'
import type { SquadDetailsWindowProps } from './squad-details-window.helpers'
import { SquadDisplay } from './squad-display'
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
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select'
import { Switch } from './ui/switch'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip.tsx'

void import('@/components/squad-details-window')
void import('@/components/teamswitches-help-window')

const DEFAULT_TEAM_SORTING: SortingState = [{ id: 'squad', desc: false }]
const DEFAULT_COMBINED_SORTING: SortingState = [{ id: 'faction', desc: false }, { id: 'squad', desc: false }]

export default function TeamsPanel(props: { className?: string; stores: SquadServerFrame.KeyProp }) {
	const isDesktop = useIsDesktopSize()
	const showSwapsPanel = ZusUtils.useStore(
		props.stores.squadServer!,
		UPClient.Store,
		(tswStore, upStore) => TSWClient.Sel.hasSwitches(tswStore) || upStore.teamswitchEditors.size > 0,
	)
	const [searchQuery, setSearchQuery] = React.useState('')
	const [showSelected, setShowSelected] = React.useState(false)
	const selectedCount = ZusUtils.useStore(SquadServerClient.PlayerSelectionStore, s => Object.values(s.selection).filter(Boolean).length)
	const showSelectedId = React.useId()
	React.useEffect(() => {
		if (selectedCount === 0 && showSelected) setShowSelected(false)
	}, [selectedCount, showSelected])
	const [adminsOnly, setAdminsOnly] = React.useState(false)
	const adminsOnlyId = React.useId()
	const [hideSpoilers, setHideSpoilers] = React.useState(true)
	const hideSpoilersId = React.useId()
	const secondaryFilterState = ZusUtils.useStore(props.stores.squadServer!, ChatPrt.Sel.secondaryFilterState)
	React.useEffect(() => {
		if (secondaryFilterState === 'ADMIN') setAdminsOnly(true)
	}, [secondaryFilterState])
	const [roleFilter, setRoleFilter] = React.useState<string | null>(null)
	const [groupingFilter, setGroupingFilter] = React.useState<string | null>(null)
	const [squadFilterA, setSquadFilterA] = React.useState<string | null>(null)
	const [squadFilterB, setSquadFilterB] = React.useState<string | null>(null)
	const [squadFilterCombined, setSquadFilterCombined] = React.useState<string | null>(null)
	const [sortingA, setSortingA] = React.useState<SortingState>(DEFAULT_TEAM_SORTING)
	const [sortingB, setSortingB] = React.useState<SortingState>(DEFAULT_TEAM_SORTING)
	const [sortingCombined, setSortingCombined] = React.useState<SortingState>(DEFAULT_COMBINED_SORTING)
	const allPlayersA = ZusUtils.useStore(
		props.stores.squadServer!,
		MatchHistoryClient.currentMatch$(props.stores.squadServer!.serverId),
		BattlemetricsClient.playerBmData$,
		BattlemetricsClient.Store,
		SettingsClient.PublicSettingsStore,
		TeamsPanelModels.Sel.playersForTeam('A'),
	)
	const allPlayersB = ZusUtils.useStore(
		props.stores.squadServer!,
		MatchHistoryClient.currentMatch$(props.stores.squadServer!.serverId),
		BattlemetricsClient.playerBmData$,
		BattlemetricsClient.Store,
		SettingsClient.PublicSettingsStore,
		TeamsPanelModels.Sel.playersForTeam('B'),
	)
	// filter options are drawn from both teams so the shared role/grouping filters offer every value
	const availableRoles = React.useMemo(
		() => [...new Set([...allPlayersA, ...allPlayersB].map(p => p.role).filter((r): r is string => r != null))].sort(),
		[allPlayersA, allPlayersB],
	)
	const availableGroupings = React.useMemo(
		() => [...new Set([...allPlayersA, ...allPlayersB].map(p => p.grouping).filter((g): g is string => g != null))].sort(),
		[allPlayersA, allPlayersB],
	)
	const resetAll = () => {
		SquadServerClient.Actions.setSelection({})
		setSearchQuery('')
		setAdminsOnly(false)
		setRoleFilter(null)
		setGroupingFilter(null)
		setSquadFilterA(null)
		setSquadFilterB(null)
		setSquadFilterCombined(null)
		setSortingA(DEFAULT_TEAM_SORTING)
		setSortingB(DEFAULT_TEAM_SORTING)
		setSortingCombined(DEFAULT_COMBINED_SORTING)
	}
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
					<TeamTitle teamId="A" stores={props.stores} />
				</div>
				<TeamPlayerCounts stores={props.stores} />
				<div className="flex justify-end">
					<TeamTitle teamId="B" stores={props.stores} />
				</div>
				<div>
				</div>
			</div>
			{showSwapsPanel && <SwapsPanel className="my-1 rounded-md border bg-muted/40 px-2 py-1.5" stores={props.stores} />}
			<div className="grid w-full grid-cols-[1fr_auto_1fr] gap-1">
				<Input
					placeholder="Search Players..."
					value={searchQuery}
					onChange={e => setSearchQuery(e.target.value)}
					onKeyDown={e => {
						if (e.key !== 'Enter' || !searchQuery.trim()) return
						const { players } = ChatPrt.Sel.chatState(ZusUtils.getState(props.stores.squadServer!))
						const names = players.map(p => p.ids.usernameNoTag ?? p.ids.username ?? '')
						const matched = new Set(StrUtils.simpleStringMatch(names, searchQuery))
						const matchedIds = players
							.filter((_, i) => matched.has(i))
							.map(p => SM.PlayerIds.getPlayerId(p.ids))
						// additive, like every other selection action -- merge matches into the current selection
						SquadServerClient.Actions.selectPlayers(matchedIds)
					}}
				/>
				<div className="flex items-center gap-2 justify-center">
					<div className="flex items-center gap-2">
						<Switch
							id={showSelectedId}
							checked={showSelected}
							disabled={selectedCount === 0}
							onCheckedChange={() => setShowSelected(v => !v)}
						/>
						<Label htmlFor={showSelectedId} className="text-sm whitespace-nowrap">Show Selected</Label>
						<span
							className="min-w-[3ch] text-xs text-muted-foreground tabular-nums data-[hide=true]:invisible"
							data-hide={selectedCount === 0}
						>
							({selectedCount})
						</span>
					</div>
					<div className="flex items-center gap-2">
						<Switch
							id={adminsOnlyId}
							checked={adminsOnly}
							onCheckedChange={(checked) => {
								setAdminsOnly(checked)
								if (checked) {
									ChatPrt.Actions.setSecondaryFilterState({ chat: props.stores.squadServer! }, 'ADMIN')
								} else if (secondaryFilterState === 'ADMIN') {
									ChatPrt.Actions.setSecondaryFilterState({ chat: props.stores.squadServer! }, 'DEFAULT')
								}
							}}
						/>
						<Label htmlFor={adminsOnlyId} className="text-sm whitespace-nowrap">Admins Only</Label>
					</div>
					<div className="flex items-center gap-2">
						<Switch
							id={hideSpoilersId}
							checked={hideSpoilers}
							onCheckedChange={setHideSpoilers}
						/>
						<Label htmlFor={hideSpoilersId} className="text-sm whitespace-nowrap" title="Hide K/W/D and role columns">Hide Spoilers</Label>
					</div>
					{hideSpoilers && roleFilter !== null && (
						<Badge variant="secondary" className="gap-1" title="Role filter is active but hidden with spoilers">
							Role: {roleFilter}
							<button
								type="button"
								className="hover:text-destructive"
								title="Clear role filter"
								onClick={() =>
									setRoleFilter(null)}
							>
								<Icons.X className="h-3 w-3" />
							</button>
						</Badge>
					)}
					<Button
						variant="ghost"
						size="icon"
						className="h-7 w-7"
						title="Reset selections, filters, sorting and search"
						onClick={resetAll}
					>
						<Icons.Trash className="h-4 w-4" />
					</Button>
				</div>
				<ControlPanel />
			</div>
			{isDesktop
				? (
					<div className="grid w-full grid-cols-[1fr_1fr] divide-x divide-border">
						<TeamPlayerTable
							teamId="A"
							searchQuery={searchQuery}
							filters={filtersA}
							showSelected={showSelected}
							adminsOnly={adminsOnly}
							sorting={sortingA}
							setSorting={setSortingA}
							availableRoles={availableRoles}
							availableGroupings={availableGroupings}
							hideSpoilers={hideSpoilers}
							stores={props.stores}
						/>
						<TeamPlayerTable
							teamId="B"
							searchQuery={searchQuery}
							filters={filtersB}
							showSelected={showSelected}
							adminsOnly={adminsOnly}
							sorting={sortingB}
							setSorting={setSortingB}
							availableRoles={availableRoles}
							availableGroupings={availableGroupings}
							hideSpoilers={hideSpoilers}
							className="pl-1"
							stores={props.stores}
						/>
					</div>
				)
				: (
					<CombinedPlayerTable
						searchQuery={searchQuery}
						filters={filtersC}
						showSelected={showSelected}
						adminsOnly={adminsOnly}
						sorting={sortingCombined}
						setSorting={setSortingCombined}
						availableRoles={availableRoles}
						availableGroupings={availableGroupings}
						hideSpoilers={hideSpoilers}
						stores={props.stores}
					/>
				)}
		</div>
	)
}

function TeamTitle(props: { teamId: MH.NormedTeamId; stores: SquadServerFrame.KeyProp }) {
	const match = MatchHistoryClient.useCurrentMatch(props.stores.squadServer!.serverId)
	return (
		<div>
			<MatchTeamDisplay teamId={props.teamId} matchId={match?.historyEntryId} showAltTeamIndicator={true} stores={props.stores} />
		</div>
	)
}

function TeamPlayerCounts(props: { stores: SquadServerFrame.KeyProp }) {
	const playerCountA = ZusUtils.useStore(
		props.stores.squadServer!,
		MatchHistoryClient.currentMatch$(props.stores.squadServer!.serverId),
		ChatPrt.Sel.teamPlayerCount('A'),
	)
	const playerCountB = ZusUtils.useStore(
		props.stores.squadServer!,
		MatchHistoryClient.currentMatch$(props.stores.squadServer!.serverId),
		ChatPrt.Sel.teamPlayerCount('B'),
	)
	return (
		<div className="flex items-center justify-center whitespace-nowrap">
			{playerCountA} vs {playerCountB}
		</div>
	)
}

function ControlPanel() {
	const config = ZusUtils.useStore(SettingsClient.PublicSettingsStore)
	const playerFlagGroupings = config?.playerFlagGroupings
	const groupingModeIds = React.useMemo(
		() => playerFlagGroupings ? BM.getGroupingModeIds(playerFlagGroupings) : [],
		[playerFlagGroupings],
	)
	const activeModeId = ZusUtils.useStore(BattlemetricsClient.Store, BattlemetricsClient.Sel.activeGroupingModeId(groupingModeIds))

	if (groupingModeIds.length === 0) return null

	return (
		<div className="flex justify-end items-center gap-1">
			<span className="text-sm text-muted-foreground">Group by</span>
			<Select value={activeModeId ?? ''} onValueChange={(value) => BattlemetricsClient.Actions.setSelectedModeId(value || null)}>
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

function SelectOrSpinner({ playerId, checked, onCheckedChange, stores }: {
	playerId: SM.PlayerId
	checked: boolean
	onCheckedChange: (checked: boolean) => void
	stores: SquadServerFrame.KeyProp
}) {
	const isPending = ZusUtils.useStore(stores.squadServer!, TSWClient.Sel.isSwitchPending(playerId))
	return (
		<div className="h-4 w-4 flex items-center justify-center shrink-0">
			{isPending
				? <Icons.LoaderCircle className="h-3 w-3 animate-spin text-muted-foreground" />
				: <Checkbox checked={checked} onCheckedChange={onCheckedChange} aria-label="Select row" />}
		</div>
	)
}

// shift+click anywhere in the squad/grouping cell selects the squad/grouping members
function shiftClickCellProps(
	columnId: string,
	player: TeamsPanelModels.EnrichedPlayer,
	stores: SquadServerFrame.KeyProp,
): Pick<React.TdHTMLAttributes<HTMLTableCellElement>, 'onClickCapture' | 'title'> {
	if (columnId === 'squad' && player.squadId !== null) {
		return {
			title: 'Shift+click: select all members of this squad',
			onClickCapture: e => {
				if (!e.shiftKey) return
				// the (SL) indicator has its own shift+click handler (select squad leaders); let it win
				if ((e.target as HTMLElement).closest('[data-select-squad-leaders]')) return
				e.preventDefault()
				e.stopPropagation()
				const players = ChatPrt.Sel.chatState(ZusUtils.getState(stores.squadServer!)).players
				SquadServerClient.Actions.selectSquad(SM.PlayerIds.getPlayerId(player.ids), players)
			},
		}
	}
	if (columnId === 'role' && player.role != null) {
		const role = player.role
		return {
			title: 'Shift+click: select teammates with this role. Shift+Ctrl+click: both teams',
			onClickCapture: e => {
				if (!e.shiftKey) return
				e.preventDefault()
				e.stopPropagation()
				SquadServerClient.Actions.selectAllWithRole(stores, role, e.ctrlKey ? undefined : player.teamId ?? undefined)
			},
		}
	}
	if (columnId === 'grouping' && player.grouping) {
		const grouping = player.grouping
		return {
			title: 'Shift+click: select teammates in this grouping. Shift+Ctrl+click: both teams',
			onClickCapture: e => {
				if (!e.shiftKey) return
				e.preventDefault()
				e.stopPropagation()
				SquadServerClient.Actions.selectGrouping(stores, grouping, e.ctrlKey ? undefined : player.teamId ?? undefined)
			},
		}
	}
	return {}
}

type PlayerFilters = {
	role: string | null
	setRole: (v: string | null) => void
	grouping: string | null
	setGrouping: (v: string | null) => void
	squad: string | null
	setSquad: (v: string | null) => void
}

// shared across both table variants; each variant extends it with its squad-lookup shape
type BasePlayerTableMeta = {
	matchId: number
	groupingColorByLabel: Map<string, string>
	filters: PlayerFilters
	availableRoles: string[]
	availableGroupings: string[]
	stores: SquadServerFrame.KeyProp
	statsSort: StatsSortState
	// SLM was restarted mid-match, so combat stats are incomplete -- surfaced as a disclaimer on the stats header
	statsMayBeInaccurate: boolean
}

type TeamPlayerTableMeta = BasePlayerTableMeta & {
	teamId: SM.TeamId
	squads: SM.UniqueSquad[]
}

type CombinedPlayer = TeamsPanelModels.EnrichedPlayer & { normedTeam: MH.NormedTeamId }

type SquadWithTeam = { squad: SM.UniqueSquad; normedTeam: MH.NormedTeamId }

type CombinedTableMeta = BasePlayerTableMeta & {
	squadsWithTeam: SquadWithTeam[]
	getFaction: (normedTeam: MH.NormedTeamId) => string
}

// Describes the squad-group a player belongs to, used to render the group-separator header rows when
// the table is sorted by squad. `key` identifies a contiguous group of same-squad rows. A null `squad`
// is the catch-all group for players not in any squad ("Unassigned"). `faction`, when set (combined
// table only), renders in its own cell aligned with the faction column.
type SquadGroupInfo = {
	key: string
	squad: SM.UniqueSquad | null
	creatorName: string | null
	faction: { label: string; color: string } | null
}

const FILTERED_COLUMN_IDS = ['role', 'grouping', 'squad']

// middle-click on a header resets that column's sort and filter
function headerResetProps(
	column: { id: string; getCanSort: () => boolean; clearSorting: () => void },
	filters: PlayerFilters,
): Pick<React.ThHTMLAttributes<HTMLTableCellElement>, 'title' | 'onMouseDown' | 'onAuxClick'> {
	const hasFilter = FILTERED_COLUMN_IDS.includes(column.id)
	if (!column.getCanSort() && !hasFilter) return {}
	return {
		title: hasFilter
			? column.getCanSort() ? 'Middle-click: reset sort and filter' : 'Middle-click: reset filter'
			: 'Middle-click: reset sort',
		// prevent middle-click autoscroll
		onMouseDown: e => {
			if (e.button === 1) e.preventDefault()
		},
		onAuxClick: e => {
			if (e.button !== 1) return
			column.clearSorting()
			if (column.id === 'role') filters.setRole(null)
			if (column.id === 'grouping') filters.setGrouping(null)
			if (column.id === 'squad') filters.setSquad(null)
		},
	}
}

const FILTER_ALL = '__all__'
// sentinel filter value matching players with no grouping ("Other") or no squad ("Unassigned")
const FILTER_NONE = '__none__'

function ColumnFilterSelect({ value, onChange, options }: {
	value: string | null
	onChange: (v: string | null) => void
	options: { value: string; label: string }[]
}) {
	if (options.length === 0) return null
	return (
		<Select value={value ?? FILTER_ALL} onValueChange={v => onChange(v === FILTER_ALL ? null : v)}>
			<SelectTrigger
				onClick={e => e.stopPropagation()}
				className={cn(
					'h-5 w-auto gap-0.5 border-none px-1 py-0 text-xs font-normal shadow-none focus:ring-0',
					value
						? 'bg-primary/20 text-primary font-semibold ring-1 ring-primary/50'
						: 'bg-transparent text-muted-foreground',
				)}
			>
				<SelectValue />
			</SelectTrigger>
			<SelectContent>
				<SelectItem value={FILTER_ALL}>All</SelectItem>
				{options.map(o => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
			</SelectContent>
		</Select>
	)
}

type StatsSortMetric = 'kills' | 'wounds' | 'deaths'

const STATS_SORT_METRICS: { metric: StatsSortMetric; short: string; label: string }[] = [
	{ metric: 'kills', short: 'K', label: 'Kills' },
	{ metric: 'wounds', short: 'W', label: 'Wounds' },
	{ metric: 'deaths', short: 'D', label: 'Deaths' },
]

type StatsSortColumn = {
	toggleSorting: (desc?: boolean) => void
	clearSorting: () => void
}

// lives in the table component and flows in through table meta: picking a metric rebuilds the column
// def, so anything captured in the column def's closures would go stale or remount the header.
// `sorted` is derived from the sorting react state rather than read via column.getIsSorted() — the
// react compiler memoizes on the (stable) column identity, so getIsSorted() calls in render go stale
type StatsSortState = {
	metric: StatsSortMetric
	setMetric: (m: StatsSortMetric) => void
	open: boolean
	setOpen: (open: boolean) => void
	sorted: false | 'asc' | 'desc'
}

// derive sort direction from the sorting react state rather than column.getIsSorted(): the react
// compiler memoizes on the stable column identity, so getIsSorted() calls in render go stale
function sortDirFor(sorting: SortingState, columnId: string): false | 'asc' | 'desc' {
	const entry = sorting.find(s => s.id === columnId)
	return entry ? (entry.desc ? 'desc' : 'asc') : false
}

function StatsColumnHeader({ column, statsSort, mayBeInaccurate }: {
	column: StatsSortColumn
	statsSort: StatsSortState
	mayBeInaccurate: boolean
}) {
	const { metric, setMetric, open, setOpen, sorted } = statsSort
	return (
		<span className="inline-flex items-center gap-1">
			{mayBeInaccurate && (
				<Tooltip>
					<TooltipTrigger asChild>
						<Icons.AlertTriangle className="h-3.5 w-3.5 text-destructive shrink-0" />
					</TooltipTrigger>
					<TooltipContent className="max-w-[220px]">
						Stats may be inaccurate: SLM was not active at some points during this match, so events during those periods were not counted.
					</TooltipContent>
				</Tooltip>
			)}
			<Popover open={open} onOpenChange={setOpen}>
				<PopoverTrigger asChild>
					<button
						type="button"
						onClick={e => e.stopPropagation()}
						className="inline-flex items-center"
						title={sorted ? `Sorted by ${metric}` : 'Sort by kills/wounds/deaths'}
					>
						<span>
							{STATS_SORT_METRICS.map(({ metric: m, short }, i) => (
								<React.Fragment key={m}>
									{i > 0 && <span className="text-muted-foreground">/</span>}
									<span className={sorted && metric === m ? 'text-primary font-semibold' : undefined}>{short}</span>
								</React.Fragment>
							))}
						</span>
						<Icons.ArrowUpDown className="ml-1 h-3 w-3 text-muted-foreground" />
					</button>
				</PopoverTrigger>
				<PopoverContent side="top" align="start" className="w-auto p-1" onClick={e => e.stopPropagation()}>
					<div className="flex flex-col gap-0.5">
						<div className="flex gap-0.5">
							{STATS_SORT_METRICS.map(({ metric: m, label }) => (
								<button
									key={m}
									type="button"
									className={cn(
										'text-xs px-2 py-0.5 rounded',
										sorted && metric === m ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground',
									)}
									onClick={() => {
										setMetric(m)
										column.toggleSorting(sorted !== 'asc')
									}}
								>
									{label}
								</button>
							))}
						</div>
						<div className="flex gap-0.5">
							{(['desc', 'asc'] as const).map(dir => (
								<button
									key={dir}
									type="button"
									className={cn(
										'text-xs px-2 py-0.5 rounded',
										sorted === dir ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground',
									)}
									onClick={() => column.toggleSorting(dir === 'desc')}
								>
									{dir === 'desc' ? 'Desc' : 'Asc'}
								</button>
							))}
							<button
								type="button"
								className="text-xs px-2 py-0.5 rounded text-muted-foreground hover:text-foreground ml-auto"
								onClick={() => {
									column.clearSorting()
									setOpen(false)
								}}
							>
								Clear
							</button>
						</div>
					</div>
				</PopoverContent>
			</Popover>
		</span>
	)
}

// module-level renderers so their identity is stable across column rebuilds — an inline closure would
// be a new component type each rebuild, remounting the header and flickering the open popover
function statsHeader<T extends TeamsPanelModels.EnrichedPlayer>({ column, table }: HeaderContext<T, number>) {
	const { statsSort, statsMayBeInaccurate } = table.options.meta as BasePlayerTableMeta
	return <StatsColumnHeader column={column} statsSort={statsSort} mayBeInaccurate={statsMayBeInaccurate} />
}

function statsCell<T extends TeamsPanelModels.EnrichedPlayer>({ row }: CellContext<T, number>) {
	const s = row.original.stats
	return (
		<span className="font-mono text-xs whitespace-nowrap">
			{s?.kills ?? 0}/{s?.wounds ?? 0}/{s?.deaths ?? 0}
		</span>
	)
}

// the sort depends on the metric picked in the header popover, so this column is built per-table via useMemo.
// sortingFn reads row.original instead of the accessor value: tanstack caches accessor values per row
// (row._valuesCache), so after a metric change accessor-based sorting would re-sort by the old metric
function statsColumn<T extends TeamsPanelModels.EnrichedPlayer>(metric: StatsSortMetric): ColumnDef<T, number> {
	return {
		id: 'stats',
		accessorFn: row => row.stats?.[metric] ?? 0,
		sortingFn: (a, b) => (a.original.stats?.[metric] ?? 0) - (b.original.stats?.[metric] ?? 0),
		sortDescFirst: true,
		header: statsHeader,
		cell: statsCell,
	}
}

const playerColumnHelper = createColumnHelper<TeamsPanelModels.EnrichedPlayer>()
const combinedColumnHelper = createColumnHelper<CombinedPlayer>()

// Shared cell/column builders used by both the per-team and combined tables. Each reads only the
// fields on BasePlayerTableMeta so it works regardless of which variant's meta is attached; the
// squad column, which differs between variants, is parameterized via squadColumn().

function selectColumnCell<T extends TeamsPanelModels.EnrichedPlayer>({ row, table }: CellContext<T, unknown>) {
	const { stores } = table.options.meta as BasePlayerTableMeta
	return (
		<div onClick={e => e.stopPropagation()}>
			<SelectOrSpinner
				playerId={row.id}
				checked={row.getIsSelected()}
				onCheckedChange={checked => row.toggleSelected(checked)}
				stores={stores}
			/>
		</div>
	)
}

function nameColumn<T extends TeamsPanelModels.EnrichedPlayer>(helper: ColumnHelper<T>) {
	return helper.accessor(row => row.ids.usernameNoTag ?? row.ids.username ?? '', {
		id: 'name',
		header: 'Name',
		cell: ({ row, table }) => {
			const meta = table.options.meta as BasePlayerTableMeta
			// let the enclosing row context menu (bulk-aware) handle right-clicks on the name
			return <PlayerDisplay stores={meta.stores} player={row.original} matchId={meta.matchId} disableContextMenu />
		},
	})
}

function groupingColumn<T extends TeamsPanelModels.EnrichedPlayer>(helper: ColumnHelper<T>) {
	return helper.accessor(row => row.grouping ?? '', {
		id: 'grouping',
		header: ({ table }) => {
			const { filters, availableGroupings } = table.options.meta as BasePlayerTableMeta
			return (
				<span className="flex flex-col items-start">
					Grouping
					<ColumnFilterSelect
						value={filters.grouping}
						onChange={filters.setGrouping}
						options={[...availableGroupings.map(g => ({ value: g, label: g })), { value: FILTER_NONE, label: 'Other' }]}
					/>
				</span>
			)
		},
		cell: ({ row, table }) => {
			const label = row.original.grouping
			if (!label) return null
			const { groupingColorByLabel } = table.options.meta as BasePlayerTableMeta
			const color = groupingColorByLabel.get(label)
			return (
				<span className="flex items-center gap-1">
					{color && <span className="w-2 h-2 rounded-sm shrink-0" style={{ backgroundColor: color }} />}
					{label}
				</span>
			)
		},
	})
}

function roleColumn<T extends TeamsPanelModels.EnrichedPlayer>(helper: ColumnHelper<T>) {
	return helper.accessor(row => row.role ?? '', {
		id: 'role',
		header: ({ table }) => {
			const { filters, availableRoles } = table.options.meta as BasePlayerTableMeta
			return (
				<span className="flex flex-col items-start">
					Role
					<ColumnFilterSelect value={filters.role} onChange={filters.setRole} options={availableRoles.map(r => ({ value: r, label: r }))} />
				</span>
			)
		},
		enableSorting: false,
	})
}

// module-level render prop so its identity is stable across renders
function squadButton(
	{ label, ref, onClick, ...rest }:
		& { label: string; ref?: React.Ref<HTMLButtonElement>; onClick?: React.MouseEventHandler<HTMLButtonElement> }
		& React.ButtonHTMLAttributes<HTMLButtonElement>,
) {
	return (
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
	)
}

// Renders a squad label (command squads are plain text, others open the squad-details window) wrapped
// in the squad context menu. `label` is precomputed by the caller so the two variants can format it
// differently (e.g. "12" vs "USA:12").
function SquadCell(
	{ squad, label, isLeader, teamId, stores }: {
		squad: SM.UniqueSquad
		label: string
		isLeader: boolean
		teamId?: SM.TeamId
		stores: SquadServerFrame.KeyProp
	},
) {
	const isCmd = squad.squadName === 'Command Squad'
	const squadLabel = isCmd
		? <span>{label}</span>
		: (
			<OpenWindowInteraction
				windowId={WINDOW_ID.enum['squad-details']}
				windowProps={{ uniqueSquadId: squad.uniqueId, stores } satisfies SquadDetailsWindowProps}
				preload="intent"
				render={squadButton}
				label={label}
			/>
		)
	return (
		<span className="inline-flex items-center gap-1">
			<ContextMenu>
				<ContextMenuTrigger>{squadLabel}</ContextMenuTrigger>
				<ContextMenuContent>
					<SquadContextMenuOptions squad={squad} stores={stores} />
				</ContextMenuContent>
			</ContextMenu>
			{isLeader && (
				<span
					data-select-squad-leaders
					className="text-xs text-muted-foreground hover:text-primary hover:underline cursor-pointer"
					title="Shift+click: select squad leaders on this team. Shift+Ctrl+click: both teams"
					onClickCapture={e => {
						if (!e.shiftKey) return
						e.preventDefault()
						e.stopPropagation()
						SquadServerClient.Actions.selectAllSquadLeaders(stores, e.ctrlKey ? undefined : teamId)
					}}
				>
					(SL)
				</span>
			)}
		</span>
	)
}

function squadColumn<T extends TeamsPanelModels.EnrichedPlayer, M extends BasePlayerTableMeta>(
	helper: ColumnHelper<T>,
	opts: {
		getSquad: (player: T, meta: M) => SM.UniqueSquad | undefined
		squadLabel: (squad: SM.UniqueSquad, player: T, meta: M) => string
		fallbackLabel: (player: T, meta: M) => string
		filterOptions: (meta: M) => { value: string; label: string }[]
	},
) {
	// unsquadded players get MAX_SAFE_INTEGER so they sort after real squads when ascending
	return helper.accessor(row => row.squadId ?? Number.MAX_SAFE_INTEGER, {
		id: 'squad',
		header: ({ table }) => {
			const meta = table.options.meta as M
			return (
				<span className="flex flex-col items-start">
					Squad
					<ColumnFilterSelect value={meta.filters.squad} onChange={meta.filters.setSquad} options={opts.filterOptions(meta)} />
				</span>
			)
		},
		cell: ({ row, table }) => {
			const meta = table.options.meta as M
			const player = row.original
			if (player.squadId === null) return ''
			const squad = opts.getSquad(player, meta)
			if (!squad) return opts.fallbackLabel(player, meta)
			return (
				<SquadCell
					squad={squad}
					label={opts.squadLabel(squad, player, meta)}
					isLeader={player.isLeader}
					teamId={player.teamId ?? undefined}
					stores={meta.stores}
				/>
			)
		},
	})
}

const teamPlayerColumns: ColumnDef<TeamsPanelModels.EnrichedPlayer, any>[] = [
	playerColumnHelper.display({
		id: 'select',
		header: ({ table }) => {
			const { stores, teamId } = table.options.meta as TeamPlayerTableMeta
			return (
				<Checkbox
					checked={table.getIsAllRowsSelected()}
					onCheckedChange={checked => table.toggleAllRowsSelected(!!checked)}
					onClick={e => {
						if (e.altKey) {
							e.preventDefault()
							SquadServerClient.Actions.invertSelection(stores, e.ctrlKey ? undefined : teamId)
							return
						}
						if (!e.shiftKey) return
						e.preventDefault()
						SquadServerClient.Actions.selectAllTeamPlayers(stores, e.ctrlKey ? undefined : teamId)
					}}
					title="Select all shown. Shift+click: select all on this team. Shift+Ctrl+click: both teams. Alt+click: invert selection on this team. Alt+Ctrl+click: invert on both teams"
					aria-label="Select all"
				/>
			)
		},
		cell: selectColumnCell,
	}),
	nameColumn(playerColumnHelper),
	groupingColumn(playerColumnHelper),
	squadColumn<TeamsPanelModels.EnrichedPlayer, TeamPlayerTableMeta>(playerColumnHelper, {
		getSquad: (player, meta) => meta.squads.find(s => s.squadId === player.squadId),
		squadLabel: squad => squad.squadName === 'Command Squad' ? `CMD(${squad.squadId})` : String(squad.squadId),
		fallbackLabel: player => String(player.squadId),
		filterOptions: meta => [
			...meta.squads.map(s => ({
				value: String(s.squadId),
				label: s.squadName === 'Command Squad' ? `CMD(${s.squadId})` : `${s.squadId} ${s.squadName}`,
			})),
			{ value: FILTER_NONE, label: 'Unassigned' },
		],
	}),
	roleColumn(playerColumnHelper),
]

const combinedPlayerColumns: ColumnDef<CombinedPlayer, any>[] = [
	combinedColumnHelper.display({
		id: 'select',
		header: ({ table }) => {
			const { stores } = table.options.meta as CombinedTableMeta
			return (
				<Checkbox
					checked={table.getIsAllRowsSelected()}
					onCheckedChange={checked => table.toggleAllRowsSelected(!!checked)}
					onClick={e => {
						if (e.altKey) {
							e.preventDefault()
							SquadServerClient.Actions.invertSelection(stores)
							return
						}
						if (!e.shiftKey) return
						e.preventDefault()
						SquadServerClient.Actions.selectAllTeamPlayers(stores)
					}}
					title="Select all shown. Shift+click: select all players on both teams. Alt+click: invert selection"
					aria-label="Select all"
				/>
			)
		},
		cell: selectColumnCell,
	}),
	combinedColumnHelper.accessor(row => row.normedTeam, {
		id: 'faction',
		header: 'Faction',
		cell: ({ row, table }) => {
			const normedTeam = row.original.normedTeam
			return (
				<span className="font-semibold" style={{ color: DH.TEAM_COLORS[`team${normedTeam}`] }}>
					{(table.options.meta as CombinedTableMeta).getFaction(normedTeam)}
				</span>
			)
		},
	}),
	nameColumn(combinedColumnHelper),
	groupingColumn(combinedColumnHelper),
	squadColumn<CombinedPlayer, CombinedTableMeta>(combinedColumnHelper, {
		getSquad: (player, meta) =>
			meta.squadsWithTeam.find(({ squad: s, normedTeam }) => s.squadId === player.squadId && normedTeam === player.normedTeam)?.squad,
		squadLabel: (squad, player, meta) => {
			const faction = meta.getFaction(player.normedTeam)
			return squad.squadName === 'Command Squad' ? `${faction}:CMD` : `${faction}:${squad.squadId}`
		},
		fallbackLabel: (player, meta) => `${meta.getFaction(player.normedTeam)}:${player.squadId}`,
		filterOptions: meta => [
			...meta.squadsWithTeam.map(({ squad: s, normedTeam }) => {
				const faction = meta.getFaction(normedTeam)
				const isCmd = s.squadName === 'Command Squad'
				return {
					value: `${normedTeam}:${s.squadId}`,
					label: isCmd ? `${faction}:CMD` : `${faction}:${s.squadId} ${s.squadName}`,
				}
			}),
			{ value: FILTER_NONE, label: 'Unassigned' },
		],
	}),
	roleColumn(combinedColumnHelper),
]

const matchesTeamSquadFilter = (player: TeamsPanelModels.EnrichedPlayer, squadFilter: string) =>
	squadFilter === FILTER_NONE ? player.squadId === null : player.squadId === Number(squadFilter)

const matchesCombinedSquadFilter = (player: CombinedPlayer, squadFilter: string) =>
	squadFilter === FILTER_NONE ? player.squadId === null : squadFilter === `${player.normedTeam}:${player.squadId}`

function useGroupingColorByLabel(): Map<string, string> {
	const config = ZusUtils.useStore(SettingsClient.PublicSettingsStore)
	const orgFlags = BattlemetricsClient.useOrgFlags()
	const modeIds = React.useMemo(() => BM.getGroupingModeIds(config?.playerFlagGroupings ?? []), [config])
	const activeModeId = ZusUtils.useStore(BattlemetricsClient.Store, BattlemetricsClient.Sel.activeGroupingModeId(modeIds))
	return React.useMemo(() => {
		const playerFlagGroupings = config?.playerFlagGroupings ?? []
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
	}, [config, orgFlags, activeModeId])
}

// Applies search + role/grouping/squad/admin filters, then the "show selected" toggle. squad matching
// differs between variants, so the predicate is passed in (must be a stable module-level reference).
function useDisplayedPlayers<T extends TeamsPanelModels.EnrichedPlayer>(
	players: T[],
	filters: PlayerFilters,
	searchQuery: string,
	adminsOnly: boolean,
	showSelected: boolean,
	rowSelection: Record<string, boolean>,
	matchesSquadFilter: (player: T, squadFilter: string) => boolean,
): T[] {
	const filteredPlayers = React.useMemo(() => {
		let result = players
		if (searchQuery.trim()) {
			const names = players.map(p => p.ids.usernameNoTag ?? p.ids.username ?? '')
			const matched = new Set(StrUtils.simpleStringMatch(names, searchQuery))
			result = players.filter((_, i) => matched.has(i))
		}
		if (filters.role !== null) result = result.filter(p => p.role === filters.role)
		if (filters.grouping !== null) {
			result = result.filter(p => filters.grouping === FILTER_NONE ? p.grouping == null : p.grouping === filters.grouping)
		}
		if (filters.squad !== null) result = result.filter(p => matchesSquadFilter(p, filters.squad!))
		if (adminsOnly) result = result.filter(p => p.isAdmin)
		return result
	}, [players, searchQuery, filters, adminsOnly, matchesSquadFilter])

	return React.useMemo(() => {
		if (!showSelected) return filteredPlayers
		return filteredPlayers.filter(p => rowSelection[SM.PlayerIds.getPlayerId(p.ids)])
	}, [filteredPlayers, showSelected, rowSelection])
}

// Separator row rendered above each squad's players when the table is sorted by squad. Shows the squad
// id/name, member count and creator, wraps the squad context menu, and its checkbox selects/deselects
// every (visible) member of the squad. The "Unassigned" group (null squad) has no context menu.
function SquadGroupHeaderRow(props: {
	info: SquadGroupInfo
	playerIds: string[]
	colSpan: number
	stores: SquadServerFrame.KeyProp
}) {
	const selectedCount = ZusUtils.useStore(
		SquadServerClient.PlayerSelectionStore,
		s => props.playerIds.filter(id => s.selection[id]).length,
	)
	const allSelected = props.playerIds.length > 0 && selectedCount === props.playerIds.length
	const someSelected = selectedCount > 0 && !allSelected
	const toggle = (checked: boolean) => {
		const current = { ...SquadServerClient.PlayerSelectionStore.getState().selection }
		for (const id of props.playerIds) {
			if (checked) current[id] = true
			else delete current[id]
		}
		SquadServerClient.Actions.setSelection(current)
	}
	const { squad, creatorName, faction } = props.info
	const checkbox = (
		<div onClick={e => e.stopPropagation()}>
			<Checkbox
				checked={allSelected ? true : someSelected ? 'indeterminate' : false}
				onCheckedChange={toggle}
				aria-label={squad ? `Select squad ${squad.squadId}` : 'Select unassigned players'}
			/>
		</div>
	)
	const labelContent = (
		<>
			{squad
				? <SquadDisplay stores={props.stores} squad={squad} matchId={0} showMenu={false} />
				: <span className="font-semibold">Unassigned</span>}
			<span className="text-muted-foreground">
				{props.playerIds.length} {props.playerIds.length === 1 ? 'player' : 'players'}
			</span>
			{creatorName && <span className="text-muted-foreground">· created by {creatorName}</span>}
		</>
	)
	// combined table: keep the faction in its own cell so it lines up under the faction column
	const row = faction
		? (
			<TableRow className="bg-muted/60 hover:bg-muted">
				<TableCell className="py-1">{checkbox}</TableCell>
				<TableCell className="py-1">
					<span className="text-xs font-semibold" style={{ color: faction.color }}>{faction.label}</span>
				</TableCell>
				<TableCell colSpan={props.colSpan - 2} className="py-1">
					<div className="flex items-center gap-2 text-xs">{labelContent}</div>
				</TableCell>
			</TableRow>
		)
		: (
			<TableRow className="bg-muted/60 hover:bg-muted">
				<TableCell colSpan={props.colSpan} className="py-1">
					<div className="flex items-center gap-2 text-xs">
						{checkbox}
						{labelContent}
					</div>
				</TableCell>
			</TableRow>
		)
	if (!squad) return row
	return (
		<ContextMenu>
			<ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
			<ContextMenuContent>
				<SquadContextMenuOptions squad={squad} stores={props.stores} />
			</ContextMenuContent>
		</ContextMenu>
	)
}

// Generic table shell shared by both variants: owns row selection, drag-to-select, the stats-sort
// popover state, header/body rendering and per-row context menus. Callers supply the data, the
// variant's column list and the variant-specific meta (everything except statsSort, which lives here).
function PlayerTable<T extends TeamsPanelModels.EnrichedPlayer>(props: {
	data: T[]
	baseColumns: ColumnDef<T, any>[]
	meta: Omit<BasePlayerTableMeta, 'statsSort'>
	sorting: SortingState
	setSorting: React.Dispatch<React.SetStateAction<SortingState>>
	hideSpoilers: boolean
	stores: SquadServerFrame.KeyProp
	// when provided and enableSquadGroups is set, players are grouped under squad-separator headers.
	// enableSquadGroups is variant-specific: it must only be true when the sort keeps same-squad rows
	// contiguous (squad-primary for per-team, faction-then-squad for the combined table).
	getSquadGroup?: (player: T) => SquadGroupInfo | null
	enableSquadGroups?: boolean
	className?: string
}) {
	const rowSelection = ZusUtils.useStore(SquadServerClient.PlayerSelectionStore, s => s.selection)
	const savedSwitches = ZusUtils.useStore(props.stores.squadServer!, s => TSWClient.Sel.localState(s).savedSwitches)
	const setRowSelection = SquadServerClient.Actions.setSelection
	const mouseDownRef = React.useRef<{ index: number; originalSelected: boolean } | null>(null)
	const { sorting, setSorting } = props
	const [statsMetric, setStatsMetric] = React.useState<StatsSortMetric>('kills')
	const [statsSortOpen, setStatsSortOpen] = React.useState(false)
	const columns = React.useMemo(() => [...props.baseColumns, statsColumn<T>(statsMetric)], [props.baseColumns, statsMetric])
	const columnVisibility = React.useMemo(() => ({ role: !props.hideSpoilers, stats: !props.hideSpoilers }), [props.hideSpoilers])

	const table = useReactTable<T>({
		data: props.data,
		columns,
		getCoreRowModel: getCoreRowModel(),
		getSortedRowModel: getSortedRowModel(),
		getRowId: row => SM.PlayerIds.getPlayerId(row.ids),
		state: { rowSelection, sorting, columnVisibility },
		onRowSelectionChange: setRowSelection,
		onSortingChange: setSorting,
		meta: {
			...props.meta,
			statsSort: {
				metric: statsMetric,
				setMetric: setStatsMetric,
				open: statsSortOpen,
				setOpen: setStatsSortOpen,
				sorted: sortDirFor(sorting, 'stats'),
			},
		} satisfies BasePlayerTableMeta,
	})

	// rows come from the sorted row model; drag-select ranges must index into these (not the source
	// data) so dragging selects the visually adjacent rows even when a sort is active
	const rows = table.getRowModel().rows
	const selectedIds = Object.keys(rowSelection).filter(id => rowSelection[id])

	// publish this table's currently-visible (post-filter) rows so selection-adding actions only draw
	// on what's on screen. Keyed by a stable per-instance id so team A/B/combined tables coexist.
	const visibleKey = React.useId()
	const displayedIds = React.useMemo(() => props.data.map(p => SM.PlayerIds.getPlayerId(p.ids)), [props.data])
	React.useEffect(() => {
		SquadServerClient.VisiblePlayersActions.setVisible(visibleKey, displayedIds)
	}, [visibleKey, displayedIds])
	React.useEffect(() => () => SquadServerClient.VisiblePlayersActions.clearVisible(visibleKey), [visibleKey])

	const renderPlayerRow = (row: Row<T>, visibleIndex: number) => {
		const isBulk = selectedIds.length >= 2 && rowSelection[row.id]
		return (
			<ContextMenu key={row.id}>
				<ContextMenuTrigger asChild>
					<TableRow
						className={cn(
							'cursor-pointer select-none',
							savedSwitches.has(row.id)
								? 'bg-amber-500/20 hover:bg-amber-500/40 data-[state=selected]:bg-amber-500/50'
								: undefined,
						)}
						data-state={row.getIsSelected() ? 'selected' : undefined}
						onClick={() => row.toggleSelected()}
						onMouseDown={e => {
							if (e.button !== 0) return
							mouseDownRef.current = { index: visibleIndex, originalSelected: !rowSelection[row.id] }
						}}
						onMouseUp={() => {
							mouseDownRef.current = null
						}}
						onMouseEnter={() => {
							const md = mouseDownRef.current
							if (!md) return
							const [lo, hi] = [Math.min(md.index, visibleIndex), Math.max(md.index, visibleIndex)]
							const current = { ...SquadServerClient.PlayerSelectionStore.getState().selection }
							for (let i = lo; i <= hi; i++) {
								const p = rows[i]?.original
								if (!p) continue
								const pid = SM.PlayerIds.getPlayerId(p.ids)
								if (md.originalSelected) {
									current[pid] = true
								} else {
									delete current[pid]
								}
							}
							setRowSelection(current)
							mouseDownRef.current = { index: visibleIndex, originalSelected: md.originalSelected }
						}}
					>
						{row.getVisibleCells().map(cell => (
							<TableCell key={cell.id} {...shiftClickCellProps(cell.column.id, row.original, props.stores)}>
								{flexRender(cell.column.columnDef.cell, cell.getContext())}
							</TableCell>
						))}
					</TableRow>
				</ContextMenuTrigger>
				<ContextMenuContent>
					{isBulk
						? <PlayerBulkContextMenuOptions playerIds={selectedIds} stores={props.stores} />
						: <PlayerContextMenuOptions playerId={row.id} stores={props.stores} />}
				</ContextMenuContent>
			</ContextMenu>
		)
	}

	// When sorting by squad, players of the same squad are contiguous; walk the sorted rows and emit a
	// SquadGroupHeaderRow before each such run. `visibleIndex` passed to renderPlayerRow stays the row's
	// index within `rows` so drag-select ranges remain correct across the injected header rows.
	const bodyRows: React.ReactNode[] = []
	const groupHeadersEnabled = !!props.getSquadGroup && !!props.enableSquadGroups
	if (groupHeadersEnabled) {
		const colSpan = table.getVisibleLeafColumns().length
		let i = 0
		while (i < rows.length) {
			const info = props.getSquadGroup!(rows[i].original)
			if (!info) {
				bodyRows.push(renderPlayerRow(rows[i], i))
				i++
				continue
			}
			let j = i
			while (j < rows.length && props.getSquadGroup!(rows[j].original)?.key === info.key) j++
			bodyRows.push(
				<SquadGroupHeaderRow
					key={`squad-header-${info.key}`}
					info={info}
					playerIds={rows.slice(i, j).map(r => r.id)}
					colSpan={colSpan}
					stores={props.stores}
				/>,
			)
			for (let k = i; k < j; k++) bodyRows.push(renderPlayerRow(rows[k], k))
			i = j
		}
	} else {
		rows.forEach((row, visibleIndex) => bodyRows.push(renderPlayerRow(row, visibleIndex)))
	}

	return (
		<Table className={props.className}>
			<TableHeader>
				{table.getHeaderGroups().map(headerGroup => (
					<TableRow key={headerGroup.id}>
						{headerGroup.headers.map(header => {
							const sortDir = sortDirFor(sorting, header.column.id)
							return (
								<TableHead
									key={header.id}
									onClick={header.column.getCanSort() && header.column.id !== 'stats' ? header.column.getToggleSortingHandler() : undefined}
									className={cn('align-top pt-1.5', header.column.getCanSort() && 'cursor-pointer select-none')}
									{...headerResetProps(header.column, props.meta.filters)}
								>
									{header.isPlaceholder ? null : (
										<span className="inline-flex items-start gap-0.5">
											{flexRender(header.column.columnDef.header, header.getContext())}
											{sortDir === 'asc' ? ' ↑' : sortDir === 'desc' ? ' ↓' : null}
										</span>
									)}
								</TableHead>
							)
						})}
					</TableRow>
				))}
			</TableHeader>
			<TableBody>
				{bodyRows}
			</TableBody>
		</Table>
	)
}

function TeamPlayerTable(
	props: {
		teamId: MH.NormedTeamId
		searchQuery: string
		filters: PlayerFilters
		showSelected: boolean
		adminsOnly: boolean
		sorting: SortingState
		setSorting: React.Dispatch<React.SetStateAction<SortingState>>
		availableRoles: string[]
		availableGroupings: string[]
		hideSpoilers: boolean
		className?: string
		stores: SquadServerFrame.KeyProp
	},
) {
	const rowSelection = ZusUtils.useStore(SquadServerClient.PlayerSelectionStore, s => s.selection)
	const match = MatchHistoryClient.useCurrentMatch(props.stores.squadServer!.serverId)
	const matchId = match?.historyEntryId ?? 0
	const groupingColorByLabel = useGroupingColorByLabel()

	const players = ZusUtils.useStore(
		props.stores.squadServer!,
		MatchHistoryClient.currentMatch$(props.stores.squadServer!.serverId),
		BattlemetricsClient.playerBmData$,
		BattlemetricsClient.Store,
		SettingsClient.PublicSettingsStore,
		TeamsPanelModels.Sel.playersForTeam(props.teamId),
	)
	const squads = ZusUtils.useStore(
		props.stores.squadServer!,
		MatchHistoryClient.currentMatch$(props.stores.squadServer!.serverId),
		ChatPrt.Sel.squadsForTeam(props.teamId),
	)
	const statsMayBeInaccurate = ZusUtils.useStore(
		props.stores.squadServer!,
		MatchHistoryClient.currentMatch$(props.stores.squadServer!.serverId),
		ChatPrt.Sel.statsMayBeInaccurate,
	)

	const displayedPlayers = useDisplayedPlayers(
		players,
		props.filters,
		props.searchQuery,
		props.adminsOnly,
		props.showSelected,
		rowSelection,
		matchesTeamSquadFilter,
	)

	// resolve squad creator eos ids to display names for the group-header rows
	const creatorNameByEosId = React.useMemo(() => {
		const m = new Map<string, string>()
		for (const p of players) m.set(SM.PlayerIds.getPlayerId(p.ids), p.ids.usernameNoTag ?? p.ids.username ?? '')
		return m
	}, [players])
	const getSquadGroup = React.useCallback((player: TeamsPanelModels.EnrichedPlayer): SquadGroupInfo | null => {
		if (player.squadId === null) return { key: 'unassigned', squad: null, creatorName: null, faction: null }
		const squad = squads.find(s => s.squadId === player.squadId)
		if (!squad) return null
		return { key: String(squad.squadId), squad, creatorName: creatorNameByEosId.get(squad.creator) || null, faction: null }
	}, [squads, creatorNameByEosId])

	const meta = {
		matchId,
		teamId: MH.getDenormedTeamId(props.teamId, match?.ordinal ?? 0),
		squads,
		groupingColorByLabel,
		filters: props.filters,
		availableRoles: props.availableRoles,
		availableGroupings: props.availableGroupings,
		stores: props.stores,
		statsMayBeInaccurate,
	} satisfies Omit<TeamPlayerTableMeta, 'statsSort'>

	return (
		<PlayerTable
			data={displayedPlayers}
			baseColumns={teamPlayerColumns}
			meta={meta}
			sorting={props.sorting}
			setSorting={props.setSorting}
			hideSpoilers={props.hideSpoilers}
			stores={props.stores}
			getSquadGroup={getSquadGroup}
			enableSquadGroups={props.sorting[0]?.id === 'squad'}
			className={props.className}
		/>
	)
}

function CombinedPlayerTable(
	props: {
		searchQuery: string
		filters: PlayerFilters
		showSelected: boolean
		adminsOnly: boolean
		sorting: SortingState
		setSorting: React.Dispatch<React.SetStateAction<SortingState>>
		availableRoles: string[]
		availableGroupings: string[]
		hideSpoilers: boolean
		className?: string
		stores: SquadServerFrame.KeyProp
	},
) {
	const rowSelection = ZusUtils.useStore(SquadServerClient.PlayerSelectionStore, s => s.selection)
	const match = MatchHistoryClient.useCurrentMatch(props.stores.squadServer!.serverId)
	const matchId = match?.historyEntryId ?? 0
	const groupingColorByLabel = useGroupingColorByLabel()

	const playersA = ZusUtils.useStore(
		props.stores.squadServer!,
		MatchHistoryClient.currentMatch$(props.stores.squadServer!.serverId),
		BattlemetricsClient.playerBmData$,
		BattlemetricsClient.Store,
		SettingsClient.PublicSettingsStore,
		TeamsPanelModels.Sel.playersForTeam('A'),
	)
	const playersB = ZusUtils.useStore(
		props.stores.squadServer!,
		MatchHistoryClient.currentMatch$(props.stores.squadServer!.serverId),
		BattlemetricsClient.playerBmData$,
		BattlemetricsClient.Store,
		SettingsClient.PublicSettingsStore,
		TeamsPanelModels.Sel.playersForTeam('B'),
	)
	const squadsA = ZusUtils.useStore(
		props.stores.squadServer!,
		MatchHistoryClient.currentMatch$(props.stores.squadServer!.serverId),
		ChatPrt.Sel.squadsForTeam('A'),
	)
	const squadsB = ZusUtils.useStore(
		props.stores.squadServer!,
		MatchHistoryClient.currentMatch$(props.stores.squadServer!.serverId),
		ChatPrt.Sel.squadsForTeam('B'),
	)
	const squadsWithTeam = React.useMemo<SquadWithTeam[]>(() => [
		...squadsA.map(squad => ({ squad, normedTeam: 'A' as const })),
		...squadsB.map(squad => ({ squad, normedTeam: 'B' as const })),
	], [squadsA, squadsB])
	const statsMayBeInaccurate = ZusUtils.useStore(
		props.stores.squadServer!,
		MatchHistoryClient.currentMatch$(props.stores.squadServer!.serverId),
		ChatPrt.Sel.statsMayBeInaccurate,
	)

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

	const displayedPlayers = useDisplayedPlayers(
		players,
		props.filters,
		props.searchQuery,
		props.adminsOnly,
		props.showSelected,
		rowSelection,
		matchesCombinedSquadFilter,
	)

	// resolve squad creator eos ids to display names for the group-header rows
	const creatorNameByEosId = React.useMemo(() => {
		const m = new Map<string, string>()
		for (const p of players) m.set(SM.PlayerIds.getPlayerId(p.ids), p.ids.usernameNoTag ?? p.ids.username ?? '')
		return m
	}, [players])

	const getSquadGroup = React.useCallback((player: CombinedPlayer): SquadGroupInfo | null => {
		const faction = { label: getFaction(player.normedTeam), color: DH.TEAM_COLORS[`team${player.normedTeam}`] }
		if (player.squadId === null) return { key: `${player.normedTeam}:unassigned`, squad: null, creatorName: null, faction }
		const squad = squadsWithTeam
			.find(({ squad: s, normedTeam }) => s.squadId === player.squadId && normedTeam === player.normedTeam)?.squad
		if (!squad) return null
		return {
			key: `${player.normedTeam}:${squad.squadId}`,
			squad,
			creatorName: creatorNameByEosId.get(squad.creator) || null,
			faction,
		}
	}, [squadsWithTeam, getFaction, creatorNameByEosId])

	const meta = {
		matchId,
		squadsWithTeam,
		groupingColorByLabel,
		filters: props.filters,
		availableRoles: props.availableRoles,
		availableGroupings: props.availableGroupings,
		getFaction,
		stores: props.stores,
		statsMayBeInaccurate,
	} satisfies Omit<CombinedTableMeta, 'statsSort'>

	return (
		<PlayerTable
			data={displayedPlayers}
			baseColumns={combinedPlayerColumns}
			meta={meta}
			sorting={props.sorting}
			setSorting={props.setSorting}
			hideSpoilers={props.hideSpoilers}
			stores={props.stores}
			getSquadGroup={getSquadGroup}
			enableSquadGroups={props.sorting[0]?.id === 'faction' && props.sorting[1]?.id === 'squad'}
			className={props.className}
		/>
	)
}

function TeamsAfterSwap(props: { stores: SquadServerFrame.KeyProp }) {
	const { countA, countB } = ZusUtils.useStore(
		props.stores.squadServer!,
		MatchHistoryClient.currentMatch$(props.stores.squadServer!.serverId),
		(frameState, currentMatch) => {
			const editedSwitches = TSWClient.Sel.localState(frameState).editedSwitches
			const players = ChatPrt.Sel.chatState(frameState).players
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

function SwapsPanel({ className, stores }: { className?: string; stores: SquadServerFrame.KeyProp }) {
	const canExecute = ZusUtils.useStore(stores.squadServer!, TSWClient.Sel.canExecuteSavedTeamswitches)
	const switchesModified = ZusUtils.useStore(stores.squadServer!, TSWClient.Sel.switchesModified)
	const [isEditing, setIsEditing] = UPClient.useEditingTeamswitchesState(stores.squadServer!.serverId)
	const numEditors = ZusUtils.useStore(UPClient.Store, s => s.teamswitchEditors.size)
	const [forceSave, setForceSave] = React.useState(false)
	const startEditingDenied = RbacClient.usePermsCheck(RBAC.perm('squad-server:manage-players'))

	const handleFinishOrSave = () => {
		const shouldSave = switchesModified && (numEditors <= 1 || forceSave)
		// clears teamswitch editing across all of this user's clients via the presence reducer fan-out
		setIsEditing(false)
		if (shouldSave) {
			TSWClient.Actions.save(stores)
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
			<TeamSwapsDisplay teamId="A" className="pr-2" stores={stores} />
			<div className="flex flex-col items-center gap-1 px-2">
				<div className="flex items-center gap-1">
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								variant="ghost"
								size="icon"
								className="h-7 w-7"
								disabled={!isEditing || !switchesModified}
								onClick={() => TSWClient.Actions.revertToSaved(stores)}
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
							<Button variant="destructive" size="sm" disabled={!canExecute || numEditors > 0}>
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
								<AlertDialogAction onClick={() => TSWClient.Actions.executeTeamswitches(stores)}>
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
				<TeamsAfterSwap stores={stores} />
			</div>
			<TeamSwapsDisplay teamId="B" align="right" className="pl-2" stores={stores} />
		</div>
	)
}

function TeamSwapsDisplay(
	props: { teamId: MH.NormedTeamId; align?: 'left' | 'right'; className?: string; stores: SquadServerFrame.KeyProp },
) {
	const switches = ZusUtils.useStore(
		props.stores.squadServer!,
		React.useCallback(
			(frameState: TSWClient.Store & ChatPrt.Store) => TSWClient.Sel.switchesToTeamEnrichedWithMutations(frameState, props.teamId),
			[props.teamId],
		),
	)

	const hasLocal = [...switches.values()].some(s => !s.mutation.removed)
	const isRight = props.align === 'right'

	return (
		<div className={cn('flex flex-col gap-0.5', isRight && 'items-end', props.className)}>
			<h3 className="text-sm">
				Swaps to current <MatchTeamDisplay teamId={props.teamId} showAltTeamIndicator={true} stores={props.stores} />
			</h3>
			<div className={cn('flex flex-wrap items-center gap-1', isRight && 'justify-end')}>
				{switches.size > 0 && <span className="text-xs text-muted-foreground shrink-0">({switches.size})</span>}
				{switches.size === 0 && <span className="text-muted-foreground text-sm">No swaps yet</span>}
				{MapUtils.mapToArray(switches, (playerId, s) => <SwitchBadge switch={s} key={playerId} stores={props.stores} />)}
				{hasLocal && (
					<Button
						variant="ghost"
						size="icon"
						className="h-6 w-6 shrink-0"
						onClick={() => TSWClient.Actions.clearTeamSwitches(props.stores, props.teamId)}
						title="Clear all"
					>
						<Icons.Trash2 className="h-3 w-3" />
					</Button>
				)}
			</div>
		</div>
	)
}

function SwitchBadge(props: { switch: TSWClient.Sel.EnrichedTeamswitchWithMutation; stores: SquadServerFrame.KeyProp }) {
	const { mutation } = props.switch
	const playerId = SM.PlayerIds.getPlayerId(props.switch.player.ids)
	const variant = mutation.added ? 'added' : mutation.removed ? 'removed' : 'secondary'

	return (
		<Badge
			variant={variant}
			className="flex items-center gap-1"
			title={mutation.removed ? undefined : 'Middle-click: delete switch'}
			onMouseDown={e => {
				// prevent middle-click autoscroll
				if (e.button === 1) e.preventDefault()
			}}
			onAuxClick={e => {
				if (e.button !== 1 || mutation.removed) return
				TSWClient.Actions.removeSwitch(props.stores, [playerId])
			}}
		>
			<span className={mutation.removed ? 'line-through opacity-60' : undefined}>
				{props.switch.player.ids.username}
			</span>
			{!mutation.removed && (
				<button
					type="button"
					onClick={() => TSWClient.Actions.removeSwitch(props.stores, [playerId])}
					className="ml-1 hover:text-destructive"
					title="Delete switch"
				>
					<Icons.X className="h-3 w-3" />
				</button>
			)}
		</Badge>
	)
}
