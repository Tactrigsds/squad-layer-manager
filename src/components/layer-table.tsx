import type { Column, ColumnDef, Row } from '@tanstack/react-table'
import { createColumnHelper, flexRender, getCoreRowModel, useReactTable } from '@tanstack/react-table'
import type { Table as CoreTable } from '@tanstack/table-core'
import * as Icons from 'lucide-react'
import { ArrowDown, ArrowUp, ArrowUpDown, Dices, LoaderCircle } from 'lucide-react'
import React from 'react'
import { flushSync } from 'react-dom'

import ComboBoxMulti from '@/components/combo-box/combo-box-multi'
import { PermissionDeniedTooltip } from '@/components/permission-denied-tooltip'
import { Button } from '@/components/ui/button'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuShortcut, ContextMenuTrigger } from '@/components/ui/context-menu'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Toggle } from '@/components/ui/toggle'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import * as LayerTablePrt from '@/frame-partials/layer-table.partial'
import type * as SquadServerFrame from '@/frames/squad-server.frame'
import { useDebouncedState } from '@/hooks/use-debounce'
import * as DH from '@/lib/display-helpers'
import type { Focusable } from '@/lib/react'
import { assertNever } from '@/lib/type-guards'
import * as Typo from '@/lib/typography'
import * as Zus from '@/lib/zustand'
import * as L_Msgs from '@/messages/layer.messages'
import * as SM_Msgs from '@/messages/squad.messages'
import * as CS from '@/models/context-shared'
import * as L from '@/models/layer'
import * as LC from '@/models/layer-columns'
import type * as LQY from '@/models/layer-queries.models.ts'
import * as GlobalSettings from '@/systems/client-only-settings.client'
import * as LayerQueriesClient from '@/systems/layer-queries.client'
import * as RbacClient from '@/systems/rbac.client'
import * as UsersClient from '@/systems/users.client'

import { ConstraintEvalTooltip } from './constraint-matches-indicator'
import LayerContextMenuOptions from './layer-context-menu-options'
import MapLayerDisplay from './map-layer-display'
import { MultiLayerSetDialog } from './multi-layer-set-dialog'
import { TablePagination } from './table-pagination'
import { Checkbox } from './ui/checkbox'
import { Input } from './ui/input'
import { Label } from './ui/label'
import { Separator } from './ui/separator'
import { Switch } from './ui/switch'

export type { PostProcessedLayer } from '@/systems/layer-queries.shared'
import type { CheckedState } from '@radix-ui/react-checkbox'

import { orUndef } from '@/lib/types'
import { cn } from '@/lib/utils'
import { tr } from '@/systems/messages.client'

const columnHelper = createColumnHelper<LayerQueriesClient.RowData>()

const formatFloat = (value: number) => {
	const formatted = value.toFixed(2)
	const numeric = parseFloat(formatted)
	if (numeric > 0) return `+${formatted}`
	return formatted
}
// table-level display state shared by every cell. these values are identical across the whole
// table, so cells read them from context instead of each holding its own store subscriptions
// (~rows × cols of them) and recomputing team parity per cell
type CellDisplayCtx = { teamParity: number; displayLayersNormalized: boolean }
const LayerTableCellCtx = React.createContext<CellDisplayCtx>({ teamParity: 0, displayLayersNormalized: false })

function buildColumn(colDef: LC.ColumnDef, isNumeric: boolean, stores: LayerTablePrt.KeyProp) {
	const useTableFrame = <O,>(selector: (table: LayerTablePrt.LayerTable) => O) =>
		Zus.useStore(stores.layerTable, (s) => selector(s.layerTable))

	return columnHelper.accessor(colDef.name, {
		enableHiding: true,
		enableSorting: false, // Disable default sorting, we'll handle it manually
		size: LayerTablePrt.getColumnSize(colDef.name, isNumeric),
		minSize: colDef.name === 'Layer' ? 150 : undefined,
		header: function ValueColHeader() {
			const sortingState = useTableFrame((table) => table.sort)
			const sort = sortingState?.type === 'column' && sortingState.sortBy === colDef.name ? sortingState : null

			const handleClick = () => {
				LayerTablePrt.Actions.setSort(stores, (old) => {
					const existing = old

					// Only numeric columns can be sorted by absolute value
					const order = isNumeric ? (['ASC', 'DESC', 'ASC:ABS', 'DESC:ABS'] as const) : (['ASC', 'DESC'] as const)
					let direction: LQY.LayersQuerySortDirection
					if (!existing || existing.type !== 'column' || existing.sortBy !== colDef.name) {
						direction = 'ASC'
					} else {
						const currentIndex = order.indexOf(existing.direction as any)
						const nextIndex = currentIndex === -1 ? 0 : (currentIndex + 1) % order.length
						direction = order[nextIndex]
					}

					return {
						type: 'column',
						sortBy: colDef.name,
						direction: direction,
					}
				})
			}

			return (
				<Button
					className="data-[sort=true]:text-accent-foreground w-full justify-between pl-4"
					size="sm"
					data-sort={!!sort}
					variant="ghost"
					title={colDef.displayName}
					onClick={handleClick}
				>
					{colDef.shortName ?? colDef.displayName}
					{!sort && <ArrowUpDown className="ml-2 h-4 w-4" />}
					{sort?.direction === 'ASC' && <ArrowUp className="ml-2 h-4 w-4" />}
					{sort?.direction === 'DESC' && <ArrowDown className="ml-2 h-4 w-4" />}
					{sort?.direction === 'ASC:ABS' && (
						<span className="ml-2 flex items-center">
							<ArrowUp className="h-4 w-4" />
							<span className="text-xs">{tr.text(L_Msgs.sortByMagnitude())}</span>
						</span>
					)}
					{sort?.direction === 'DESC:ABS' && (
						<span className="ml-2 flex items-center">
							<ArrowDown className="h-4 w-4" />
							<span className="text-xs">{tr.text(L_Msgs.sortByMagnitude())}</span>
						</span>
					)}
				</Button>
			)
		},
		cell: function ValueColCell(info) {
			const { teamParity, displayLayersNormalized } = React.useContext(LayerTableCellCtx)
			const matchDescriptors = info.row.original.matchDescriptors
			if (colDef.name === 'Layer') {
				return (
					<div className="pl-4">
						<MapLayerDisplay
							layer={L.toLayer(info.row.original.id).Layer}
							extraLayerStyles={{
								Map: DH.getColumnExtraStyles('Map', teamParity, displayLayersNormalized, matchDescriptors),
								Layer: DH.getColumnExtraStyles('Layer', teamParity, displayLayersNormalized, matchDescriptors),
								Gamemode: DH.getColumnExtraStyles('Gamemode', teamParity, displayLayersNormalized, matchDescriptors),
							}}
						/>
					</div>
				)
			}

			const emptyElt = (
				<div className="flex w-full justify-center">
					<span>-</span>
				</div>
			)

			let columnsToInclude = [colDef.name]
			if (colDef.name === 'Faction_1') {
				columnsToInclude.push('Alliance_1')
			}
			if (colDef.name === 'Faction_2') {
				columnsToInclude.push('Alliance_2')
			}

			let extraStyles: string | undefined = cn(
				...columnsToInclude.map((col) =>
					DH.getColumnExtraStyles(col as keyof L.KnownLayer, teamParity, displayLayersNormalized, matchDescriptors),
				),
			)

			const valueElt = (value: React.ReactNode) => <div className={`pl-4 ${extraStyles}`}>{value}</div>
			const value = info.getValue()
			if (value === null || value === undefined) return emptyElt
			let elt: React.ReactNode
			switch (colDef.type) {
				case 'float':
					elt = valueElt(formatFloat(value as unknown as number))
					break
				case 'string':
					elt = value ? valueElt(value) : emptyElt
					break
				case 'integer':
					elt = value ? valueElt(value.toString()) : emptyElt
					break
				case 'boolean':
					if (value === null || value === undefined) {
						elt = emptyElt
						break
					}
					elt = valueElt(value ? 'True' : 'False')
					break
				default:
					assertNever(colDef)
			}

			return elt
		},
	})
}

function buildColDefs(cfg: LQY.EffectiveColumnAndTableConfig, stores: LayerTablePrt.KeyProp) {
	const getTableFrame = () => Zus.getState(stores.layerTable).layerTable

	const tableColDefs: ColumnDef<LayerQueriesClient.RowData>[] = [
		{
			id: 'select',
			size: LayerTablePrt.SELECT_COLUMN_SIZE,
			header: function SelectHeader() {
				const { selectState, disabled } = Zus.useStore(
					stores.layerTable,
					UsersClient.loggedInUserQueryOptions,
					RbacClient.RbacStore,
					LayerTablePrt.Sel.selectAllStatus,
				)

				const toggleAllSelected = (state: CheckedState) => {
					const table = getTableFrame()
					if (!table.pageData) return
					const ids = table.pageData.layers.map((l) => l.id)
					if (state === true) {
						LayerTablePrt.Actions.setSelected(stores, (selected) => Array.from(new Set([...ids, ...selected])))
					} else {
						LayerTablePrt.Actions.setSelected(stores, (selected) => selected.filter((id) => !ids.includes(id)))
					}
				}
				let checkState: true | false | 'indeterminate'
				if (selectState === 'all') {
					checkState = true
				} else if (selectState === 'some') {
					checkState = 'indeterminate'
				} else {
					checkState = false
				}

				return (
					<div className="pl-4">
						<Checkbox
							checked={checkState}
							disabled={disabled}
							onCheckedChange={toggleAllSelected}
							aria-label={tr.text(SM_Msgs.selectAllRows())}
						/>
					</div>
				)
			},
			cell: function SelectCell({ row }) {
				const { isUnselectable, isSelected, blockedByPool } = Zus.useStore(
					stores.layerTable,
					UsersClient.loggedInUserQueryOptions,
					RbacClient.RbacStore,
					LayerTablePrt.Sel.rowSelectionStatus(row.id),
				)

				return (
					<Checkbox
						checked={isSelected}
						disabled={isUnselectable}
						// no handler here because we're already handling onClick on the row
						className={blockedByPool ? 'invisible' : ''}
						aria-label={tr.text(SM_Msgs.selectRow())}
					/>
				)
			},
			enableSorting: false,
			enableHiding: false,
		},
	]

	{
		const sortedColKeys = [...cfg.orderedColumns].sort((a, b) => {
			let aIndex = cfg.orderedColumns.findIndex((c) => c.name === a.name)
			if (aIndex === -1) aIndex = cfg.orderedColumns.length
			let bIndex = cfg.orderedColumns.findIndex((c) => c.name === b.name)
			if (bIndex === -1) bIndex = cfg.orderedColumns.length
			return aIndex - bIndex
		})

		const ctx: LC.Ctx = { ...CS.init(), effectiveColsConfig: cfg }

		// add sorted first
		for (const col of sortedColKeys) {
			const colDef = LC.getColumnDef(col.name, cfg)!
			const isNumeric = LC.isNumericColumn(col.name, ctx)
			tableColDefs.push(buildColumn(colDef, isNumeric, stores))
		}

		// then add the rest
		for (const key of Object.keys(cfg.defs)) {
			if (LC.isVirtualColumn(key, cfg)) continue
			if (sortedColKeys.some((c) => c.name === key)) continue
			const colDef = LC.getColumnDef(key, cfg)!
			const isNumeric = LC.isNumericColumn(key, ctx)
			tableColDefs.push(buildColumn(colDef, isNumeric, stores))
		}
	}

	// Always include constraints column
	const constraintsCol = columnHelper.accessor('constraints', {
		header: () => (
			<span title={tr.text(L_Msgs.layerIndicatorsColumn())}>
				<Icons.Flag />
			</span>
		),
		enableHiding: false,
		size: LayerTablePrt.CONSTRAINTS_COLUMN_SIZE,
		cell: function FlagColCell({ row }) {
			const { teamParity } = React.useContext(LayerTableCellCtx)
			return (
				<span
					onClick={(e) => {
						// if we're on the filter edit page and the user tries to navigate to the filter they're already editing, the click event will try to propagate and select the row
						e.stopPropagation()
					}}
				>
					<ConstraintEvalTooltip
						padEmpty
						layerId={row.original.id}
						itemParity={teamParity}
						matchDescriptors={row.original.constraints.matchDescriptors}
						queriedConstraints={row.original.constraints.queriedConstraints}
						height={32}
					/>
				</span>
			)
		},
	})
	tableColDefs.push(constraintsCol as any)

	return tableColDefs
}

export default function LayerTable(props: {
	// squadServer is optional: supplied when rendered within a server context (for team-parity display), omitted elsewhere
	stores: LayerTablePrt.KeyProp & Partial<SquadServerFrame.KeyProp>
	extraPanelItems?: React.ReactNode

	enableForceSelect?: boolean
	canChangeRowsPerPage?: boolean
	canToggleColumns?: boolean
	// hide all but LayerTablePrt.COMPACT_VISIBLE_COLUMNS without touching stored visibility prefs
	compact?: boolean
}) {
	const useTableFrame = <O,>(selector: (table: LayerTablePrt.LayerTable) => O) =>
		Zus.useStore(props.stores.layerTable, (s) => selector(s.layerTable))

	const frameState = useTableFrame(
		Zus.useShallow((table) => ({
			colConfig: table.colConfig,
			showSelectedLayers: table.showSelectedLayers,
			sort: table.sort,
			pageSize: table.pageSize,
			pageIndex: table.pageIndex,
		})),
	)

	const columnVisibility = Zus.useStore(props.stores.layerTable, LayerTablePrt.Sel.columnVisibility(props.compact ?? false))

	// eslint-disable-next-line react-hooks/exhaustive-deps
	const onColumnVisibilityChange = React.useCallback(LayerTablePrt.Actions.onColumnVisibilityChange(props.stores), [props.stores])
	// eslint-disable-next-line react-hooks/exhaustive-deps
	const onPaginationChange = React.useCallback(LayerTablePrt.Actions.onPaginationChange(props.stores), [props.stores])

	const page = useTableFrame((table) => table.pageData)

	// shared display state for all cells -- see LayerTableCellCtx
	const displayLayersNormalized = Zus.useStore(GlobalSettings.GlobalSettingsStore, (state) => state.displayTeamsNormalized)
	const teamParity = Zus.useStore(props.stores.layerTable, props.stores.squadServer ?? null, LayerTablePrt.Sel.teamParity)
	const cellDisplayCtx = React.useMemo(
		(): CellDisplayCtx => ({ teamParity, displayLayersNormalized }),
		[teamParity, displayLayersNormalized],
	)

	const table = useReactTable({
		data: page?.layers ?? [],
		columns: React.useMemo(() => buildColDefs(frameState.colConfig, props.stores), [frameState.colConfig, props.stores]),
		defaultColumn: {
			size: 150,
			minSize: 50,
		},
		pageCount: page?.pageCount ?? -1,
		state: {
			// sorting: tanstackState.tanstackSortingState,
			columnVisibility,
			pagination: {
				pageIndex: frameState.pageIndex,
				pageSize: frameState.pageSize,
			},
		},
		getRowId: (row) => row.id,
		onColumnVisibilityChange,
		onPaginationChange,
		getCoreRowModel: getCoreRowModel(),
		// getSortedRowModel: getSortedRowModel(),
		manualPagination: true,
	})
	const rowElts: React.ReactNode[] = []
	const rows = table.getRowModel().rows
	const columns = table.getVisibleFlatColumns()
	const placeholderBase = React.useMemo(
		() => (
			<TableRow className="pointer-events-none">
				{columns.map((column) => (
					<TableCell key={column.id} className={column.id === 'select' ? 'pl-4' : undefined} style={{ width: column.getSize() }}>
						<div style={{ height: '32px' }} />
					</TableCell>
				))}
			</TableRow>
		),
		[columns],
	)

	for (let i = 0; i < frameState.pageSize; i++) {
		if (rows[i]) {
			rowElts.push(<LayerTableRow key={rows[i].id} row={rows[i]} stores={props.stores} visibleColumns={columns} />)
		} else {
			rowElts.push(<React.Fragment key={`placeholder-${i}`}>{placeholderBase}</React.Fragment>)
		}
	}

	return (
		<LayerTableCellCtx.Provider value={cellDisplayCtx}>
			<div className="space-y-2">
				<div className={cn('rounded-md border', !props.compact && 'min-w-250')}>
					<LayerTableControlPanel {...props} table={table} />
					{/*--------- table ---------*/}
					<Table>
						<TableHeader>
							{table.getHeaderGroups().map((headerGroup) => (
								<TableRow key={headerGroup.id}>
									{headerGroup.headers.map((header) => (
										<TableHead className="px-0" key={header.id} style={{ width: header.getSize() }}>
											{header.isPlaceholder ? null : flexRender(header.column.columnDef.header, header.getContext())}
										</TableHead>
									))}
								</TableRow>
							))}
						</TableHeader>
						<TableBody>{rowElts}</TableBody>
					</Table>
				</div>
				<LayerTablePaginationControls stores={props.stores} table={table} />
			</div>
		</LayerTableCellCtx.Provider>
	)
}

// Why? this seems to niche and thrashy to go on the frame idk
const MouseDownRowIndexStoreMap = new WeakMap<LayerTablePrt.Key, Zus.StoreApi<{ index: number; originalSelected: boolean } | null>>()
function getMouseDownRowIndexStore(layerTableKey: LayerTablePrt.Key) {
	if (!MouseDownRowIndexStoreMap.has(layerTableKey)) {
		MouseDownRowIndexStoreMap.set(
			layerTableKey,
			Zus.createStore<{ index: number; originalSelected: boolean } | null>(() => null),
		)
	}
	return MouseDownRowIndexStoreMap.get(layerTableKey)!
}

const LayerTableRow = React.memo(function LayerTableRow(props: {
	stores: LayerTablePrt.KeyProp
	row: Row<LayerQueriesClient.RowData>
	// row identity is stable across column visibility changes, so visibility has to flow in as a
	// prop: it busts this React.memo, and cells must derive from it below — row.getVisibleCells()
	// reads mutable table state the react compiler can't track and would serve stale cells
	visibleColumns: Column<LayerQueriesClient.RowData, unknown>[]
}) {
	const { row } = props
	const allCells = row.getAllCells()
	const visibleCells = props.visibleColumns.map((column) => allCells.find((cell) => cell.column.id === column.id)!)
	const id = row.original.id
	const getStore = () => Zus.getState(props.stores.layerTable)
	const getTableFrame = () => Zus.getState(props.stores.layerTable).layerTable
	const canFocusLayers = Zus.useStore(props.stores.layerTable, (s) => !!s.onLayerFocused)

	const { isUnselectable, isSelected } = Zus.useStore(
		props.stores.layerTable,
		UsersClient.loggedInUserQueryOptions,
		RbacClient.RbacStore,
		LayerTablePrt.Sel.rowSelectionStatus(row.id),
	)
	function toggleRow() {
		if (isUnselectable) return

		LayerTablePrt.Actions.setSelected(props.stores, (selected) => {
			if (selected.includes(id)) {
				return selected.filter((s) => s !== id)
			} else {
				return [...selected, id]
			}
		})
	}
	function setAllRowsSinceMouseDown() {
		if (getTableFrame().showSelectedLayers) return
		const rows = getTableFrame().pageData?.layers
		if (!rows) return
		const mouseDownStore = getMouseDownRowIndexStore(props.stores.layerTable)
		const mouseDownIndex = mouseDownStore.getState()?.index
		const originalState = mouseDownStore.getState()?.originalSelected
		if (mouseDownIndex === undefined || originalState === undefined) return
		const [lowIdx, highIdx] = [Math.min(mouseDownIndex, row.index), Math.max(mouseDownIndex, row.index)]
		const allIds = new Set(getTableFrame().selected)
		for (let i = lowIdx; i <= highIdx; i++) {
			if (originalState) {
				allIds.add(rows[i].id)
			} else {
				allIds.delete(rows[i].id)
			}
		}
		LayerTablePrt.Actions.setSelected(props.stores, Array.from(allIds))
		// update this a little so we're not n+1 :shrug:
		mouseDownStore.setState({ index: row.index, originalSelected: originalState })
	}

	return (
		<ContextMenu key={row.id}>
			<ContextMenuTrigger asChild>
				<TableRow
					key={row.id}
					className="select-none h-8 data-disabled:hover:bg-unset data-disabled:hover:bg-unset data-disabled:bg-grey-800"
					data-disabled={orUndef(isUnselectable && !isSelected)}
					onClick={(e) => {
						if (isUnselectable) return
						if (e.ctrlKey && e.button === 0) {
							getStore().onLayerFocused?.(id)
							return
						}
						toggleRow()
					}}
					onMouseDown={(e) => {
						if (e.ctrlKey || e.button !== 0) return
						const originalSelected = !getTableFrame().selected.includes(row.original.id)
						getMouseDownRowIndexStore(props.stores.layerTable).setState({ index: row.index, originalSelected })
					}}
					onMouseUp={() => {
						getMouseDownRowIndexStore(props.stores.layerTable).setState(null)
					}}
					onMouseEnter={() => {
						setAllRowsSinceMouseDown()
					}}
				>
					{visibleCells.map((cell) => (
						<TableCell
							className={cell.column.id === 'select' ? 'pl-4 h-full' : 'h-full'}
							key={cell.id}
							style={{ width: cell.column.getSize() }}
						>
							{flexRender(cell.column.columnDef.cell, cell.getContext())}
						</TableCell>
					))}
				</TableRow>
			</ContextMenuTrigger>
			<ContextMenuContent>
				<LayerTableContextMenuItems layerId={row.original.id} stores={props.stores} />
				{canFocusLayers && (
					<ContextMenuItem onClick={() => getStore().onLayerFocused?.(row.id)}>
						<span>{tr.text(L_Msgs.focusLayer())}</span>
						<ContextMenuShortcut>{tr.text(L_Msgs.focusLayerShortcut())}</ContextMenuShortcut>
					</ContextMenuItem>
				)}
			</ContextMenuContent>
		</ContextMenu>
	)
})

export function LayerTableContextMenuItems(props: { layerId: L.LayerId; stores: LayerTablePrt.KeyProp }) {
	const useTableFrame = <O,>(selector: (table: LayerTablePrt.LayerTable) => O) =>
		Zus.useStore(props.stores.layerTable, (s) => selector(s.layerTable))
	const selectedForCopy = useTableFrame(
		Zus.useShallow((table) => {
			if (!table.selected.includes(props.layerId)) {
				return [props.layerId]
			} else {
				return table.selected
			}
		}),
	)

	return <LayerContextMenuOptions layerIds={selectedForCopy} />
}

export function LayerTableControlPanel(props: {
	stores: LayerTablePrt.KeyProp
	canToggleColumns?: boolean
	table: CoreTable<LayerQueriesClient.RowData>
	enableForceSelect?: boolean
	extraPanelItems?: React.ReactNode
	compact?: boolean
}) {
	const getTableFrame = () => Zus.getState(props.stores.layerTable).layerTable

	const frameState = Zus.useStore(
		props.stores.layerTable,
		Zus.useShallow((s) => ({
			showSelectedLayers: s.layerTable.showSelectedLayers,
			sort: s.layerTable.sort,
			maxSelectedLayers: s.layerTable.maxSelected,
			editingSingleValue: LayerTablePrt.Sel.editingSingleValue(s),
			selectedLayerIds: s.layerTable.selected,
			isFetching: s.layerTable.isFetching,
		})),
	)

	const showSelectedId = React.useId()

	// while compact mode overrides visibility, toggling stored prefs would have no visible effect
	const canToggleColumns = (props.canToggleColumns ?? true) && !props.compact
	const defaultVisibleColumns = Zus.useStore(props.stores.layerTable, LayerTablePrt.Sel.defaultVisibleColumns)

	const table = props.table

	const toggleRandomizeId = React.useId()
	const randomized = frameState.sort?.type === 'random'
	function toggleRandomize() {
		const sort = getTableFrame().sort
		if (sort?.type === 'random') {
			LayerTablePrt.Actions.setSort(props.stores, null)
		} else {
			LayerTablePrt.Actions.randomize(props.stores)
		}
	}

	const forceSelectDenied = RbacClient.useAnyServerPermsCheck('queue:force-write')

	const [rawSetDialogOpen, _setRawSetDialogOpen] = React.useState(false)
	const rawSetDialogRef = React.useRef<SetRawDialogHandle>(null)
	function setRawSetDialogOpen(update: (value: boolean) => boolean) {
		flushSync(() => {
			_setRawSetDialogOpen(update)
		})
		rawSetDialogRef.current?.focus()
	}

	return (
		<>
			{/* pl-1.5 for near-perfect spacing with checkboxes */}
			<div className="flex items-center justify-between pl-1.5 pr-2">
				<span className="flex h-10 items-center space-x-2">
					{/*--------- toggle columns ---------*/}
					{canToggleColumns && (
						<ComboBoxMulti
							title={tr.text(L_Msgs.columnPicker())}
							values={table
								.getAllLeafColumns()
								.filter((col) => col.getIsVisible())
								.map((col) => col.id)}
							options={table.getAllLeafColumns().map((col) => ({
								value: col.id,
								label: col.id,
							}))}
							onSelect={(updater) => {
								const newSelectedIds =
									typeof updater === 'function'
										? updater(
												table
													.getAllLeafColumns()
													.filter((col) => col.getIsVisible())
													.map((col) => col.id),
											)
										: updater
								table.getAllLeafColumns().forEach((column) => {
									column.toggleVisibility(newSelectedIds.includes(column.id))
								})
							}}
							restrictValueSize={false}
							reset={defaultVisibleColumns}
						>
							<Button variant="ghost" size="icon" title={tr.text(L_Msgs.toggleColumns())}>
								<Icons.Columns3 />
							</Button>
						</ComboBoxMulti>
					)}

					{props.enableForceSelect && (
						<PermissionDeniedTooltip denied={forceSelectDenied}>
							<Toggle
								size="sm"
								title={`${rawSetDialogOpen ? 'Hide' : 'Show'} Raw Input`}
								aria-label={`${rawSetDialogOpen ? 'Hide' : 'Show'} Raw Input`}
								pressed={rawSetDialogOpen}
								onClick={() => setRawSetDialogOpen((prev) => !prev)}
								disabled={!!forceSelectDenied}
							>
								<Icons.TextCursorInput />
							</Toggle>
						</PermissionDeniedTooltip>
					)}

					<Separator orientation="vertical" className="h-full min-h-0" />

					{/*--------- show selected ---------*/}
					<div data-tour="table-show-selected" className="flex items-center space-x-1">
						<Switch
							id={showSelectedId}
							checked={frameState.showSelectedLayers}
							disabled={frameState.selectedLayerIds.length === 0}
							onCheckedChange={() =>
								LayerTablePrt.Actions.setShowSelectedLayers(props.stores, (show: boolean) => {
									if (getTableFrame().selected.length === 0) return false
									return !show
								})
							}
						/>
						<Label htmlFor={showSelectedId}>{tr.text(L_Msgs.showSelected())}</Label>
					</div>
					<Button
						variant="ghost"
						size="icon"
						disabled={frameState.selectedLayerIds.length === 0}
						onClick={() => {
							LayerTablePrt.Actions.resetSelected(props.stores)
						}}
						title={tr.text(L_Msgs.resetSelectedLayers())}
					>
						<Icons.Trash className="h-4 w-4" />
					</Button>
					<p
						className="whitespace-nowrap text-muted-foreground data-[hide=true]:invisible"
						data-hide={frameState.selectedLayerIds.length === 0}
					>
						{tr.text(L_Msgs.selectedCount(frameState.selectedLayerIds.length))}
					</p>
				</span>
				<span className="flex h-10 items-center space-x-2 ">
					{props.extraPanelItems}
					<Button
						onClick={() => LayerTablePrt.Actions.randomize(props.stores)}
						disabled={frameState.isFetching}
						variant="ghost"
						size="icon"
						data-enabled={randomized}
						className="data-[enabled=true]:visible invisible"
					>
						<Dices />
					</Button>
					<Tooltip>
						<TooltipTrigger asChild>
							<div className="flex items-center space-x-1">
								<Switch
									disabled={frameState.showSelectedLayers}
									checked={randomized}
									onCheckedChange={() => toggleRandomize()}
									id={toggleRandomizeId}
								/>
								<Label htmlFor={toggleRandomizeId}>{tr.text(L_Msgs.randomize())}</Label>
							</div>
						</TooltipTrigger>
						<TooltipContent>{tr.text(L_Msgs.randomizeHint())}</TooltipContent>
					</Tooltip>
				</span>
			</div>
			<div>
				<SetRawLayerDialog
					ref={rawSetDialogRef}
					maxSelectedLayers={frameState.maxSelectedLayers}
					editingSingleValue={frameState.editingSingleValue}
					open={rawSetDialogOpen}
					setOpen={setRawSetDialogOpen}
					defaultValue={
						frameState.editingSingleValue && frameState.selectedLayerIds.length === 1
							? L.getLayerCommand(frameState.selectedLayerIds[0], 'set-next')
							: undefined
					}
					onSubmit={(layers) => {
						LayerTablePrt.Actions.setSelected(props.stores, (prev) => [...prev, ...layers.map((l) => l.id)])
						LayerTablePrt.Actions.setShowSelectedLayers(props.stores, true)
					}}
				/>
			</div>
		</>
	)
}

type SetRawDialogHandle = Focusable & {
	setInput: (value: string) => void
}
function SetRawLayerDialog(props: {
	open: boolean
	setOpen: (update: (value: boolean) => boolean) => void
	maxSelectedLayers?: number | null
	editingSingleValue: boolean
	defaultValue?: string
	onSubmit: (layer: L.UnvalidatedLayer[]) => void
	ref?: React.ForwardedRef<SetRawDialogHandle>
}) {
	const inputRef = React.useRef<HTMLInputElement>(null)
	const [validLayerDebounced, setValidLayerDebounced] = React.useState<L.UnvalidatedLayer | null>(null)
	const [validLayer, setValidLayer] = useDebouncedState<L.UnvalidatedLayer | null>(null, { onChange: setValidLayerDebounced, delay: 400 })
	const [multiSetLayerDialogOpen, setMultiSetLayerDialogOpen] = React.useState<boolean>(false)
	const [layerFound, setLayerFound] = React.useState<boolean>(false)
	const layerIds = validLayerDebounced ? [validLayerDebounced.id] : []
	const layersKnownRes = LayerQueriesClient.useLayerExists(layerIds, { enabled: !!validLayerDebounced })

	const setInputText = React.useCallback(
		(value: string) => {
			value = value.trim()
			const layerRes = L.parseRawLayerText(value)
			setValidLayer(layerRes)
		},
		[setValidLayer],
	)

	React.useImperativeHandle(
		props.ref,
		() => ({
			get isFocused() {
				return document.activeElement === inputRef.current
			},
			focus() {
				inputRef.current?.focus()
			},
			setInput(value: string) {
				setInputText(value)
				if (inputRef.current) inputRef.current.value = value
			},
		}),
		[setInputText],
	)

	React.useLayoutEffect(() => {
		if (layersKnownRes.data) {
			setLayerFound(layersKnownRes.data[0].exists)
		} else {
			setLayerFound(false)
		}
	}, [layersKnownRes.data])

	return (
		props.open && (
			<div
				className="flex items-center space-x-1 whitespace-nowrap w-full px-1"
				onKeyDown={(e) => {
					if (e.key === 'Enter' && e.target === inputRef.current) {
						e.preventDefault()
						if (validLayer) {
							props.onSubmit([validLayer])
						}
					}
				}}
			>
				<MultiLayerSetDialog open={multiSetLayerDialogOpen} onOpenChange={setMultiSetLayerDialogOpen} onSubmit={props.onSubmit} />
				<Input
					ref={inputRef}
					defaultValue={props.defaultValue}
					className="flex-1"
					placeholder={tr.text(L_Msgs.rawLayerPlaceholder())}
					onChange={(e) => setInputText(e.target.value)}
					rightElement={
						<div className="flex space-x-1 items-center">
							<Label
								title={tr.text(L_Msgs.layerFound())}
								data-layerFound={validLayerDebounced && layerFound}
								className="invisible data-[layerFound=true]:visible"
							>
								<Icons.CheckSquare className="text-info" />
							</Label>
							<Button
								variant="ghost"
								className="h-6 w-6 data-[singleOnly=true]:invisible"
								data-singleOnly={props.maxSelectedLayers === 1}
								size="icon"
								onClick={() => {
									setMultiSetLayerDialogOpen(true)
								}}
							>
								<Icons.Expand className="h-4 w-4" />
							</Button>
						</div>
					}
				/>
				<Button
					disabled={!validLayer}
					variant="secondary"
					size="icon"
					onClick={() => {
						props.onSubmit([validLayer!])
						if (!props.editingSingleValue) inputRef.current!.value = ''
						inputRef.current!.focus()
					}}
				>
					<Icons.Plus />
				</Button>
			</div>
		)
	)
}

function LayerTablePaginationControls(props: { stores: LayerTablePrt.KeyProp; table: CoreTable<LayerQueriesClient.RowData> }) {
	const useTableFrame = <O,>(selector: (table: LayerTablePrt.LayerTable) => O) =>
		Zus.useStore(props.stores.layerTable, (s) => selector(s.layerTable))

	const initStatus = Zus.useStore(
		LayerQueriesClient.Store,
		Zus.useShallow((s) => ({ status: s.status, errorMessage: s.errorMessage })),
	)
	const frameState = useTableFrame(
		Zus.useShallow((table) => ({
			pageSize: table.pageSize,
			pageIndex: table.pageIndex,
			totalRowCount: table.pageData?.totalCount,
			totalPageCount: table.pageData?.pageCount,
			isFetching: table.isFetching,
		})),
	)

	return (
		<div className="flex items-center justify-between space-x-4 py-2">
			<div className="flex items-center space-x-2">
				{initStatus.status === 'ready' && !frameState.isFetching && (
					<div className="text-sm text-muted-foreground [&_strong]:font-semibold [&_strong]:text-foreground">
						{(frameState.totalRowCount ?? 0) > 0 ? (
							tr.richText(L_Msgs.matchedLayers((frameState.totalRowCount ?? 0).toLocaleString()))
						) : (
							<span className="font-semibold text-foreground">{tr.text(L_Msgs.noLayersMatched())}</span>
						)}
					</div>
				)}
				<div
					data-loading={frameState.isFetching || initStatus.status === 'initializing' || initStatus.status === 'downloading-layers'}
					className="flex items-center space-x-2 invisible data-[loading=true]:visible "
				>
					<LoaderCircle className="h-4 w-4 animate-spin" />
					{initStatus.status === 'initializing' && <p className={Typo.Muted}>{tr.text(L_Msgs.initializingDatabase())}</p>}
					{initStatus.status === 'downloading-layers' && <p className={Typo.Muted}>{tr.text(L_Msgs.downloadingLayers())}</p>}
				</div>
				{initStatus.status === 'error' && (
					<div className="flex items-center space-x-2 text-destructive">
						<span className="font-semibold">{tr.text(L_Msgs.loadFailed())}</span>
						<span className="text-sm">{initStatus.errorMessage ?? tr.text(L_Msgs.loadFailedUnknown())}</span>
					</div>
				)}
			</div>
			{(frameState?.totalPageCount ?? 0) > 0 && (
				<TablePagination
					pageIndex={frameState.pageIndex}
					pageCount={frameState?.totalPageCount ?? 0}
					onPageChange={(newPageIndex) => {
						props.table.setPageIndex(newPageIndex)
					}}
					disabled={frameState.isFetching}
				/>
			)}
		</div>
	)
}
