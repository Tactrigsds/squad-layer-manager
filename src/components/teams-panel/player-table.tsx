import { flexRender, getCoreRowModel, getSortedRowModel, useReactTable } from '@tanstack/react-table'
import type { ColumnDef, HeaderContext, OnChangeFn, Row, RowSelectionState } from '@tanstack/react-table'
import React from 'react'

import * as RC from '@/components/feed/render-context'
import PlayerBulkContextMenuOptions from '@/components/player-bulk-context-menu-options'
import { PlayerMenuItems } from '@/components/player-context-menu-options'
import { StickyGroup } from '@/components/sticky-group.tsx'
import { StatsColumnHeader } from '@/components/teams-panel/cells'
import { PlayerRow, RowMenu, SquadGroupHeaderRow } from '@/components/teams-panel/player-rows'
import {
	type BasePlayerTableMeta,
	type BaseRowMeta,
	headerResetProps,
	LONG_PRESS_MS,
	type PlayerColumns,
	type RowMenuTarget,
	rowMenuTargetOf,
	rowPlayerId,
	sortDirFor,
	type SquadGroupInfo,
	type StatsSortMetric,
} from '@/components/teams-panel/teams-panel.helpers'
import { MenuSheet, sheetMenuSlots } from '@/components/ui/menu-sheet'
import { Table, TableBody, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import * as TeamsPanelPrt from '@/frame-partials/teams-panel.partial'
import * as SquadServerFrame from '@/frames/squad-server.frame'
import { useTruncatedCellReveal } from '@/hooks/use-truncated-cell-reveal'
import * as Browser from '@/lib/browser'
import * as FitCols from '@/lib/fitted-columns'
import { cn } from '@/lib/utils.ts'
import * as Zus from '@/lib/zustand'
import * as SM_Msgs from '@/messages/squad.messages'
import * as SM from '@/models/squad.models'
import type * as TeamsPanelModels from '@/models/teams-panel.models'
import { useZIndex, ZI_OFFSETS } from '@/models/zindex.models'
import { tr } from '@/systems/messages.client'
import * as TSWClient from '@/systems/teamswaps.client'

// module-level renderers so their identity is stable across column rebuilds — an inline closure would
// be a new component type each rebuild, remounting the header and flickering the open popover
function statsHeader<T extends TeamsPanelModels.EnrichedPlayer>({ column, table }: HeaderContext<T, number>) {
	const { statsSort, statsMayBeInaccurate } = table.options.meta as BasePlayerTableMeta
	return <StatsColumnHeader column={column} statsSort={statsSort} mayBeInaccurate={statsMayBeInaccurate} />
}

// the sort depends on the metric picked in the header popover, so this column is built per-table via useMemo.
// sortingFn reads row.original instead of the accessor value: tanstack caches accessor values per row
// (row._valuesCache), so after a metric change accessor-based sorting would re-sort by the old metric
function statsColumn<T extends TeamsPanelModels.EnrichedPlayer>(metric: StatsSortMetric): ColumnDef<T, number> {
	return {
		id: 'stats',
		accessorFn: (row) => row.stats?.[metric] ?? 0,
		sortingFn: (a, b) => (a.original.stats?.[metric] ?? 0) - (b.original.stats?.[metric] ?? 0),
		sortDescFirst: true,
		header: statsHeader,
	}
}

// Generic table shell shared by both variants: owns drag-to-select, the stats-sort popover state, header/body
// rendering and the rows' shared context menu. Callers supply the data, the variant's columns and the variant-specific meta
// (everything except statsSort, which lives here).
export function PlayerTable<T extends TeamsPanelModels.EnrichedPlayer, M extends BaseRowMeta>(props: {
	data: T[]
	columns: PlayerColumns<T, M>
	meta: Omit<BasePlayerTableMeta, 'statsSort'>
	rowMeta: M
	// which of the panel's two sort states this table drives; squad-separator rows are gated on it too, because
	// they are only coherent while the sort keeps same-squad rows contiguous
	sortingTarget: TeamsPanelPrt.SortingTarget
	label: string
	stores: SquadServerFrame.KeyProp
	// when provided, and when the sort permits it, players are grouped under squad-separator headers
	getSquadGroup?: (player: T) => SquadGroupInfo | null
	columnFit?: FitCols.Spec
	className?: string
}) {
	const rowSelection = Zus.useStore(props.stores.squadServer!, SquadServerFrame.Sel.playerSelection)
	const savedSwaps = Zus.useStore(props.stores.squadServer!, (s) => TSWClient.Sel.localState(s).savedSwaps)
	const sorting = Zus.useStore(props.stores.squadServer!, TeamsPanelPrt.Sel.sorting(props.sortingTarget))
	const showSpoilers = Zus.useStore(props.stores.squadServer!, TeamsPanelPrt.Sel.showSpoilers)
	const squadGroupsEnabled = Zus.useStore(props.stores.squadServer!, TeamsPanelPrt.Sel.squadGroupsEnabled(props.sortingTarget))
	const squadCollapse = Zus.useStore(props.stores.squadServer!, TeamsPanelPrt.Sel.squadCollapse)
	const phone = Browser.useIsSmallViewport()
	const [menuFor, setMenuFor] = React.useState<SM.PlayerId | null>(null)
	// kept after the menu closes, so its content stays put through the exit animation
	const [rowMenu, setRowMenu] = React.useState<RowMenuTarget | null>(null)
	const menuAnchorRef = React.useRef<HTMLSpanElement | null>(null)
	const longPressRef = React.useRef<number | undefined>(undefined)
	React.useEffect(() => () => window.clearTimeout(longPressRef.current), [])
	const stores = props.stores
	const panelStores: TeamsPanelPrt.KeyProp = { teamsPanel: stores.squadServer! }
	const setRowSelection: OnChangeFn<RowSelectionState> = React.useCallback(
		(updater) => SquadServerFrame.Actions.setSelection(stores, updater),
		[stores],
	)
	const dragRef = React.useRef<{ index: number; select: boolean } | null>(null)
	const [statsMetric, setStatsMetric] = React.useState<StatsSortMetric>('kills')
	const [statsSortOpen, setStatsSortOpen] = React.useState(false)
	const columns = React.useMemo(() => [...props.columns.defs, statsColumn<T>(statsMetric)], [props.columns.defs, statsMetric])
	const columnVisibility = React.useMemo(() => ({ role: showSpoilers, vehicle: showSpoilers, stats: showSpoilers }), [showSpoilers])

	const table = useReactTable<T>({
		data: props.data,
		columns,
		getCoreRowModel: getCoreRowModel(),
		getSortedRowModel: getSortedRowModel(),
		getRowId: (row) => SM.PlayerIds.getPlayerId(row.ids),
		state: { rowSelection, sorting, columnVisibility },
		onRowSelectionChange: setRowSelection,
		onSortingChange: TeamsPanelPrt.Actions.onSortingChange({ teamsPanel: props.stores.squadServer! }, props.sortingTarget),
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
	const selectedIds = Object.keys(rowSelection).filter((id) => rowSelection[id])

	// publish this table's currently-visible (post-filter) rows so selection-adding actions only draw
	// on what's on screen. Keyed by a stable per-instance id so team A/B/combined tables coexist.
	const visibleKey = React.useId()
	const displayedIds = React.useMemo(() => props.data.map((p) => SM.PlayerIds.getPlayerId(p.ids)), [props.data])
	React.useEffect(() => {
		SquadServerFrame.Actions.setVisiblePlayers(stores, visibleKey, displayedIds)
	}, [stores, visibleKey, displayedIds])
	React.useEffect(() => () => SquadServerFrame.Actions.clearVisiblePlayers(stores, visibleKey), [stores, visibleKey])
	const headersRef = React.useRef<HTMLTableSectionElement | null>(null)
	const tableRef = React.useRef<HTMLTableElement | null>(null)
	const revealRef = React.useRef<HTMLDivElement | null>(null)
	const revealZIndex = useZIndex(ZI_OFFSETS.MINOR_CEILING)
	useTruncatedCellReveal(tableRef, revealRef)
	const visibleColumnIdsKey = table
		.getVisibleLeafColumns()
		.map((column) => column.id)
		.join(',')
	const visibleColumnIds = React.useMemo(() => visibleColumnIdsKey.split(','), [visibleColumnIdsKey])
	FitCols.useFittedColumns(tableRef, props.columnFit, [
		TeamsPanelPrt.Sel.columnWidthSignature(props.data),
		props.rowMeta,
		visibleColumnIdsKey,
		sorting,
		squadCollapse,
		statsMetric,
		props.meta.statsMayBeInaccurate,
		props.meta.filters,
		props.meta.groupingId,
	])

	// the squad header row already names the faction while the sort keeps squads together
	const flat = !(props.getSquadGroup && squadGroupsEnabled)
	const renderPlayerRow = (row: Row<T>) => (
		<PlayerRow
			key={row.id}
			player={row.original}
			selected={(rowSelection[row.id] as boolean | undefined) ?? false}
			savedSwap={savedSwaps.has(row.id)}
			columnIds={visibleColumnIds}
			cells={props.columns.cells}
			meta={props.rowMeta}
			phone={phone}
			flat={flat}
			onOpenMenu={setMenuFor}
		/>
	)

	// a phone shows a player's menu as a sheet rather than at the finger; a squad's menu opens at the finger everywhere
	const rowMenuTargetAt = (target: EventTarget) => {
		const menuTarget = rowMenuTargetOf(target, stores)
		return menuTarget?.kind === 'player' && phone ? null : menuTarget
	}
	const openRowMenu = (target: RowMenuTarget, clientX: number, clientY: number) => {
		setRowMenu(target)
		// radix's trigger places, opens and dismisses the menu, and all it reads off the event is the point
		menuAnchorRef.current?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX, clientY }))
	}
	const clearLongPress = (e: React.PointerEvent) => {
		if (e.pointerType !== 'mouse') window.clearTimeout(longPressRef.current)
	}

	// Row clicks, drag-to-select and the context menu are delegated to the body, so a row's props stay unchanged unless
	// its own player, selection or swap does.
	const bodyHandlers: React.HTMLAttributes<HTMLTableSectionElement> = {
		onContextMenu: (e) => {
			window.clearTimeout(longPressRef.current)
			const playerId = phone ? rowPlayerId(e.target) : null
			const menuTarget = rowMenuTargetAt(e.target)
			if (menuTarget) {
				e.preventDefault()
				openRowMenu(menuTarget, e.clientX, e.clientY)
			} else if (playerId !== null) {
				e.preventDefault()
				setMenuFor(playerId)
			}
		},
		onPointerDown: (e) => {
			if (e.pointerType === 'mouse') return
			window.clearTimeout(longPressRef.current)
			const menuTarget = rowMenuTargetAt(e.target)
			if (!menuTarget) return
			const { clientX, clientY } = e
			longPressRef.current = window.setTimeout(() => openRowMenu(menuTarget, clientX, clientY), LONG_PRESS_MS)
		},
		onPointerMove: clearLongPress,
		onPointerUp: clearLongPress,
		onPointerCancel: clearLongPress,
		onClick: (e) => {
			const playerId = rowPlayerId(e.target)
			if (playerId === null || RC.opensWindow(e.target)) return
			TeamsPanelPrt.Actions.togglePlayerSelected(panelStores, playerId)
		},
		onMouseDown: (e) => {
			if (e.button !== 0) return
			const playerId = rowPlayerId(e.target)
			if (playerId === null) return
			dragRef.current = { index: rows.findIndex((row) => row.id === playerId), select: !rowSelection[playerId] }
		},
		onMouseUp: () => {
			dragRef.current = null
		},
		onMouseOver: (e) => {
			const drag = dragRef.current
			if (!drag) return
			const playerId = rowPlayerId(e.target)
			const index = playerId === null ? -1 : rows.findIndex((row) => row.id === playerId)
			if (index === -1 || index === drag.index) return
			const ids: SM.PlayerId[] = []
			for (let i = Math.min(drag.index, index); i <= Math.max(drag.index, index); i++) {
				if (rows[i]) ids.push(rows[i].id)
			}
			TeamsPanelPrt.Actions.setPlayersSelected(panelStores, ids, drag.select)
			drag.index = index
		},
	}

	// When sorting by squad, players of the same squad are contiguous; walk the sorted rows and emit a
	// SquadGroupHeaderRow before each such run.
	const bodyRows: React.ReactNode[] = []
	const groupHeadersEnabled = !!props.getSquadGroup && squadGroupsEnabled
	if (groupHeadersEnabled) {
		const colSpan = visibleColumnIds.length
		let i = 0
		while (i < rows.length) {
			const info = props.getSquadGroup!(rows[i].original)
			if (!info) {
				bodyRows.push(renderPlayerRow(rows[i]))
				i++
				continue
			}
			let j = i
			while (j < rows.length && props.getSquadGroup!(rows[j].original)?.key === info.key) j++
			const collapsed = TeamsPanelPrt.Sel.isSquadCollapsed(squadCollapse, info.key)
			bodyRows.push(
				<SquadGroupHeaderRow
					key={`squad-header-${info.key}`}
					info={info}
					playerIds={rows.slice(i, j).map((r) => r.id)}
					colSpan={colSpan}
					collapsed={collapsed}
					phone={phone}
					stores={props.stores}
				/>,
			)
			if (!collapsed) for (let k = i; k < j; k++) bodyRows.push(renderPlayerRow(rows[k]))
			i = j
		}
	} else {
		for (const row of rows) bodyRows.push(renderPlayerRow(row))
	}

	return (
		<StickyGroup stickyRef={headersRef}>
			<Table
				ref={tableRef}
				aria-label={props.label}
				className={cn(
					'[&_th]:px-1.5 [&_td]:px-1.5 max-phone:[&_td]:px-2.5 [&_th]:h-[calc(var(--row)-4px)] [&_td]:h-[calc(var(--row)-4px)] [&_td]:text-xs',
					props.columnFit && 'table-fixed [&_td]:overflow-hidden [&_td]:text-ellipsis [&_th]:overflow-hidden',
					props.className,
				)}
			>
				{props.columnFit && (
					<colgroup>
						{visibleColumnIds.map((id) => (
							<col key={id} data-col-id={id} />
						))}
					</colgroup>
				)}
				<TableHeader ref={headersRef} className="bg-panel-hi">
					{table.getHeaderGroups().map((headerGroup) => (
						<TableRow key={headerGroup.id}>
							{phone
								? null
								: headerGroup.headers.map((header) => {
										const sortDir = sortDirFor(sorting, header.column.id)
										return (
											<TableHead
												key={header.id}
												data-tour={`players-col-${header.column.id}`}
												onClick={
													header.column.getCanSort() && header.column.id !== 'stats'
														? header.column.getToggleSortingHandler()
														: undefined
												}
												className={cn('align-top pt-[3px] h-auto!', header.column.getCanSort() && 'cursor-pointer select-none')}
												{...headerResetProps(header.column, table.options.meta as BasePlayerTableMeta)}
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
				<TableBody className="[-webkit-touch-callout:none]" {...bodyHandlers}>
					{bodyRows}
				</TableBody>
			</Table>
			{/* outside the body, so the re-fired event does not bubble back into its handlers */}
			<RowMenu target={rowMenu} anchorRef={menuAnchorRef} stores={stores} />
			<div
				ref={revealRef}
				hidden
				aria-hidden
				style={{ zIndex: revealZIndex }}
				className="pointer-events-none absolute flex w-max items-center gap-1 whitespace-nowrap text-xs shadow-[0_2px_8px_rgba(0,0,0,0.5)] [&_*]:max-w-none! [&_*]:overflow-visible! [&_*]:[text-overflow:clip]!"
			/>
			{phone && (
				<MenuSheet
					open={menuFor !== null}
					onOpenChange={(open) => {
						if (!open) setMenuFor(null)
					}}
					title={
						menuFor && selectedIds.length >= 2 && rowSelection[menuFor]
							? tr.text(SM_Msgs.selectedCount(selectedIds.length))
							: (props.data.find((p) => SM.PlayerIds.getPlayerId(p.ids) === menuFor)?.ids.username ?? '')
					}
				>
					{menuFor && selectedIds.length >= 2 && rowSelection[menuFor] ? (
						<PlayerBulkContextMenuOptions playerIds={selectedIds} stores={props.stores} slots={sheetMenuSlots} />
					) : menuFor ? (
						<PlayerMenuItems playerId={menuFor} slots={sheetMenuSlots} stores={props.stores} />
					) : null}
				</MenuSheet>
			)}
		</StickyGroup>
	)
}
