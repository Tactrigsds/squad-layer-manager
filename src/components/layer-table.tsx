import ComboBoxMulti from '@/components/combo-box/combo-box-multi'
import { Button } from '@/components/ui/button'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuShortcut, ContextMenuTrigger } from '@/components/ui/context-menu'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Toggle } from '@/components/ui/toggle'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import * as LayerTablePrt from '@/frame-partials/layer-table.partial'
import { getFrameState, useFrameStore } from '@/frames/frame-manager'
import { useDebouncedState } from '@/hooks/use-debounce'
import * as DH from '@/lib/display-helpers'
import type { Focusable } from '@/lib/react'
import * as ReactRxHelpers from '@/lib/react-rxjs-helpers'
import * as SetUtils from '@/lib/set'
import { assertNever } from '@/lib/type-guards'
import * as Typo from '@/lib/typography'
import * as ZusUtils from '@/lib/zustand'
import * as CS from '@/models/context-shared'
import * as L from '@/models/layer'
import * as LC from '@/models/layer-columns'
import * as LQY from '@/models/layer-queries.models.ts'
import * as RBAC from '@/rbac.models'
import * as GlobalSettings from '@/systems/global-settings.client'
import * as LayerQueriesClient from '@/systems/layer-queries.client'
import * as QD from '@/systems/queue-dashboard.client'
import { useLoggedInUser } from '@/systems/users.client'
import type { ColumnDef, Row } from '@tanstack/react-table'
import { createColumnHelper, flexRender, getCoreRowModel, useReactTable } from '@tanstack/react-table'
import type { Table as CoreTable } from '@tanstack/table-core'
import * as Icons from 'lucide-react'
import { ArrowDown, ArrowUp, ArrowUpDown, Dices, LoaderCircle } from 'lucide-react'
import React from 'react'
import { flushSync } from 'react-dom'
import * as Zus from 'zustand'
import { ConstraintMatchesIndicator } from './constraint-matches-indicator'
import { LayerContextMenuItems } from './layer-table-helpers'
import MapLayerDisplay from './map-layer-display'
import { TablePagination } from './table-pagination'
import { Checkbox } from './ui/checkbox'
import { Input } from './ui/input'
import { Label } from './ui/label'
import { Separator } from './ui/separator'
import { Switch } from './ui/switch'
import { Textarea } from './ui/textarea'
export type { PostProcessedLayer } from '@/systems/layer-queries.shared'
import { orUndef } from '@/lib/types'
import { cn } from '@/lib/utils'
import type { CheckedState } from '@radix-ui/react-checkbox'

const columnHelper = createColumnHelper<LayerQueriesClient.RowData>()

const formatFloat = (value: number) => {
	const formatted = value.toFixed(2)
	const numeric = parseFloat(formatted)
	if (numeric > 0) return `+${formatted}`
	return formatted
}
function buildColumn(
	colDef: LC.ColumnDef,
	isNumeric: boolean,
	frameKey: LayerTablePrt.Key,
) {
	const useTableFrame = <O,>(selector: (table: LayerTablePrt.LayerTable) => O) => useFrameStore(frameKey, s => selector(s.layerTable))

	return columnHelper.accessor(colDef.name, {
		enableHiding: true,
		enableSorting: false, // Disable default sorting, we'll handle it manually
		size: ({ 'Size': 100, 'Faction_1': 40, 'Faction_2': 40 } as const)[colDef.name] ?? (isNumeric ? 50 : undefined),
		minSize: colDef.name === 'Layer' ? 150 : undefined,
		header: function ValueColHeader() {
			const [sortingState, setSorting] = useTableFrame(ZusUtils.useShallow(table => [table.sort, table.setSort]))
			const sort = sortingState?.type === 'column' && sortingState.sortBy === colDef.name ? sortingState : null

			const handleClick = () => {
				setSorting((old) => {
					const existing = old

					// Only numeric columns can be sorted by absolute value
					const order = isNumeric
						? (['ASC', 'DESC', 'ASC:ABS', 'DESC:ABS'] as const)
						: (['ASC', 'DESC'] as const)
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
							<span className="text-xs">|x|</span>
						</span>
					)}
					{sort?.direction === 'DESC:ABS' && (
						<span className="ml-2 flex items-center">
							<ArrowDown className="h-4 w-4" />
							<span className="text-xs">|x|</span>
						</span>
					)}
				</Button>
			)
		},
		cell: function ValueColCell(info) {
			const displayLayersNormalized = Zus.useStore(GlobalSettings.GlobalSettingsStore, (state) => state.displayTeamsNormalized)
			const matchDescriptors = info.row.original.matchDescriptors
			const cursor = useTableFrame(table => table.pageData?.input.cursor)
			const teamParity = ReactRxHelpers.useStateObservableSelection(
				QD.layerItemsState$,
				React.useCallback((state) => {
					if (!cursor) return 0
					return LQY.resolveTeamParityForCursor(state, LQY.fromLayerListCursor(state, cursor))
				}, [cursor]),
			)
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
					DH.getColumnExtraStyles(col as keyof L.KnownLayer, teamParity, displayLayersNormalized, matchDescriptors)
				),
			)

			const valueElt = (value: React.ReactNode) => (
				<div
					className={`pl-4 ${extraStyles}`}
				>
					{value}
				</div>
			)
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

function buildColDefs(
	cfg: LQY.EffectiveColumnAndTableConfig,
	frameKey: LayerTablePrt.Key,
) {
	const useTableFrame = <O,>(selector: (table: LayerTablePrt.LayerTable) => O) => useFrameStore(frameKey, s => selector(s.layerTable))
	const getTableFrame = () => getFrameState(frameKey).layerTable

	const tableColDefs: ColumnDef<LayerQueriesClient.RowData>[] = [
		{
			id: 'select',
			size: 40,
			header: function SelectHeader() {
				const [selectState, disabled] = useTableFrame(ZusUtils.useShallow(table => {
					if (table.pageData === null) return [null, true] as const
					const selected = new Set(table.selected)
					const pageIds = new Set(table.pageData.layers.map(l => l.id))
					const intersect = SetUtils.intersection(selected, pageIds)
					const selectState: 'all' | 'some' | null = (() => {
						if (intersect.size === pageIds.size) return 'all' as const
						if (intersect.size > 0) return 'some' as const
						return null
					})()

					const ifAllSelected = SetUtils.union(selected, pageIds)
					const ifAllUnselected = SetUtils.difference(selected, pageIds)

					const disabled = (table.maxSelected ?? Infinity) < (ifAllSelected.size)
						|| (table.minSelected ?? 0) > ifAllUnselected.size
						|| (table.pageData.layers.some(t => t.isRowDisabled))
					return [selectState, disabled] as const
				}))

				const toggleAllSelected = (state: CheckedState) => {
					const table = getTableFrame()
					if (!table.pageData) return
					const ids = table.pageData.layers.map(l => l.id)
					if (state === true) {
						table.setSelected(selected => Array.from(new Set([...ids, ...selected])))
					} else {
						table.setSelected(selected => selected.filter(id => !ids.includes(id)))
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
							aria-label="Select all"
						/>
					</div>
				)
			},
			cell: function SelectCell({ row }) {
				const [isUnselectable, isSelected] = useTableFrame(ZusUtils.useShallow(LayerTablePrt.selectRowSelectionStatus(row.id)))

				return (
					<Checkbox
						checked={isSelected}
						disabled={isUnselectable}
						// no handler here because we're already handling onClick on the row
						className={row.original.isRowDisabled ? 'invisible' : ''}
						aria-label="Select row"
					/>
				)
			},
			enableSorting: false,
			enableHiding: false,
		},
	]

	{
		const sortedColKeys = [...cfg.orderedColumns].sort((a, b) => {
			let aIndex = cfg.orderedColumns.findIndex(c => c.name === a.name)
			if (aIndex === -1) aIndex = cfg.orderedColumns.length
			let bIndex = cfg.orderedColumns.findIndex(c => c.name === b.name)
			if (bIndex === -1) bIndex = cfg.orderedColumns.length
			return aIndex - bIndex
		})

		const ctx: CS.EffectiveColumnConfig = { ...CS.init(), effectiveColsConfig: cfg }

		// add sorted first
		for (const col of sortedColKeys) {
			const colDef = LC.getColumnDef(col.name, cfg)!
			const isNumeric = LC.isNumericColumn(col.name, ctx)
			tableColDefs.push(buildColumn(colDef, isNumeric, frameKey))
		}

		// then add the rest
		for (const key of Object.keys(cfg.defs)) {
			if (sortedColKeys.some(c => c.name === key)) continue
			const colDef = LC.getColumnDef(key, cfg)!
			const isNumeric = LC.isNumericColumn(key, ctx)
			tableColDefs.push(buildColumn(colDef, isNumeric, frameKey))
		}
	}

	// Always include constraints column
	const constraintsCol = columnHelper.accessor('constraints', {
		header: () => (
			<span title="Layer Indicators">
				<Icons.Flag />
			</span>
		),
		enableHiding: false,
		size: 80,
		cell: ({ row }) => {
			const cursor = useTableFrame(table => table.pageData?.input.cursor)
			const teamParity = ReactRxHelpers.useStateObservableSelection(
				QD.layerItemsState$,
				React.useCallback((state) => {
					if (!cursor) return 0
					return LQY.resolveTeamParityForCursor(state, LQY.fromLayerListCursor(state, cursor))
				}, [cursor]),
			)
			return (
				<span
					onClick={(e) => {
						// if we're on the filter edit page and the user tries to navigate to the filter they're already editing, the click event will try to propagate and select the row
						e.stopPropagation()
					}}
				>
					<ConstraintMatchesIndicator
						side="right"
						padEmpty
						layerId={row.original.id}
						itemParity={teamParity}
						// itemParity={}
						matchingConstraintIds={row.original.constraints.matchedConstraintIds}
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
	frameKey: LayerTablePrt.Key
	extraPanelItems?: React.ReactNode

	enableForceSelect?: boolean
	canChangeRowsPerPage?: boolean
	canToggleColumns?: boolean
}) {
	const useTableFrame = <O,>(selector: (table: LayerTablePrt.LayerTable) => O) => useFrameStore(props.frameKey, s => selector(s.layerTable))

	const frameState = useTableFrame(
		ZusUtils.useShallow(table => ({
			colConfig: table.colConfig,
			showSelectedLayers: table.showSelectedLayers,
			setShowSelectedLayers: table.setShowSelectedLayers,
			sort: table.sort,
			setSort: table.setSort,
			columnVisibility: table.columnVisibility,
			onColumnVisibilityChange: table.onColumnVisibilityChange,
			pageSize: table.pageSize,
			pageIndex: table.pageIndex,
			onPaginationChange: table.onPaginationChange,
		})),
	)

	const page = useTableFrame(table => table.pageData)

	const table = useReactTable({
		data: page?.layers ?? [],
		columns: React.useMemo(() => buildColDefs(frameState.colConfig, props.frameKey), [frameState.colConfig, props.frameKey]),
		defaultColumn: {
			size: 150,
			minSize: 50,
		},
		pageCount: page?.pageCount ?? -1,
		state: {
			// sorting: tanstackState.tanstackSortingState,
			columnVisibility: frameState.columnVisibility,
			pagination: {
				pageIndex: frameState.pageIndex,
				pageSize: frameState.pageSize,
			},
		},
		getRowId: (row) => row.id,
		onColumnVisibilityChange: frameState.onColumnVisibilityChange,
		onPaginationChange: frameState.onPaginationChange,
		getCoreRowModel: getCoreRowModel(),
		// getSortedRowModel: getSortedRowModel(),
		manualPagination: true,
	})
	const rowElts: React.ReactNode[] = []
	const rows = table.getRowModel().rows
	const columns = table.getVisibleFlatColumns()
	const placeholderBase = React.useMemo(() => (
		<TableRow className="pointer-events-none">
			{columns.map((column) => (
				<TableCell
					key={column.id}
					className={column.id === 'select' ? 'pl-4' : undefined}
					style={{ width: column.getSize() }}
				>
					<div style={{ height: '32px' }} />
				</TableCell>
			))}
		</TableRow>
	), [columns])

	for (let i = 0; i < frameState.pageSize; i++) {
		if (rows[i]) {
			rowElts.push(<LayerTableRow key={rows[i].id} row={rows[i]} frameKey={props.frameKey} />)
		} else {
			rowElts.push(
				<React.Fragment key={`placeholder-${i}`}>
					{placeholderBase}
				</React.Fragment>,
			)
		}
	}

	return (
		<div className="space-y-2">
			<div className="rounded-md border min-w-250">
				<LayerTableControlPanel {...props} table={table} />
				{/*--------- table ---------*/}
				<Table>
					<TableHeader>
						{table.getHeaderGroups().map((headerGroup) => (
							<TableRow key={headerGroup.id}>
								{headerGroup.headers.map((header) => (
									<TableHead
										className="px-0"
										key={header.id}
										style={{ width: header.getSize() }}
									>
										{header.isPlaceholder ? null : flexRender(header.column.columnDef.header, header.getContext())}
									</TableHead>
								))}
							</TableRow>
						))}
					</TableHeader>
					<TableBody>
						{rowElts}
					</TableBody>
				</Table>
			</div>
			<LayerTablePaginationControls frameKey={props.frameKey} table={table} />
		</div>
	)
}

// Why? this seems to niche and thrashy to go on the frame idk
const MouseDownRowIndexStoreMap = new WeakMap<LayerTablePrt.Key, Zus.StoreApi<{ index: number; originalSelected: boolean } | null>>()
function getMouseDownRowIndexStore(frameKey: LayerTablePrt.Key) {
	if (!MouseDownRowIndexStoreMap.has(frameKey)) {
		MouseDownRowIndexStoreMap.set(frameKey, Zus.createStore<{ index: number; originalSelected: boolean } | null>(() => null))
	}
	return MouseDownRowIndexStoreMap.get(frameKey)!
}

const LayerTableRow = React.memo(function LayerTableRow(props: { frameKey: LayerTablePrt.Key; row: Row<LayerQueriesClient.RowData> }) {
	const { row } = props
	const id = row.original.id
	const getStore = () => getFrameState(props.frameKey)
	const getTableFrame = () => getFrameState(props.frameKey).layerTable
	const canFocusLayers = useFrameStore(props.frameKey, s => !!s.onLayerFocused)

	const useTableFrame = <O,>(selector: (table: LayerTablePrt.LayerTable) => O) => useFrameStore(props.frameKey, s => selector(s.layerTable))
	const [isUnselectable, isSelected] = useTableFrame(ZusUtils.useShallow(LayerTablePrt.selectRowSelectionStatus(row.id)))
	function toggleRow() {
		if (isUnselectable) return

		getTableFrame().setSelected(selected => {
			if (selected.includes(id)) {
				return selected.filter(s => s !== id)
			} else {
				return [...selected, id]
			}
		})
	}
	function setAllRowsSinceMouseDown() {
		if (getTableFrame().showSelectedLayers) return
		const rows = getTableFrame().pageData?.layers
		if (!rows) return
		const mouseDownStore = getMouseDownRowIndexStore(props.frameKey)
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
		getTableFrame().setSelected(Array.from(allIds))
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
					onMouseDown={e => {
						if (e.ctrlKey || e.button !== 0) return
						const originalSelected = !getTableFrame().selected.includes(row.original.id)
						getMouseDownRowIndexStore(props.frameKey).setState({ index: row.index, originalSelected })
					}}
					onMouseUp={() => {
						getMouseDownRowIndexStore(props.frameKey).setState(null)
					}}
					onMouseEnter={() => {
						setAllRowsSinceMouseDown()
					}}
				>
					{row.getVisibleCells().map((cell) => (
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
				<LayerTableContextMenuItems layerId={row.original.id} frameKey={props.frameKey} />
				{canFocusLayers && (
					<ContextMenuItem onClick={() => getStore().onLayerFocused?.(row.id)}>
						<span>Focus Layer</span>
						<ContextMenuShortcut>
							Ctrl
							<span>+</span>
							Click
						</ContextMenuShortcut>
					</ContextMenuItem>
				)}
			</ContextMenuContent>
		</ContextMenu>
	)
})

export function PlaceholderColumns() {
}

export function LayerTableContextMenuItems(props: { layerId: L.LayerId; frameKey: LayerTablePrt.Key }) {
	const useTableFrame = <O,>(selector: (table: LayerTablePrt.LayerTable) => O) => useFrameStore(props.frameKey, s => selector(s.layerTable))
	const selectedForCopy = useTableFrame(ZusUtils.useShallow(table => {
		if (!table.selected.includes(props.layerId)) {
			return [props.layerId]
		} else {
			return table.selected
		}
	}))

	return <LayerContextMenuItems selectedLayerIds={selectedForCopy} />
}

export function LayerTableControlPanel(
	props: {
		frameKey: LayerTablePrt.Key
		canToggleColumns?: boolean
		table: CoreTable<LayerQueriesClient.RowData>
		enableForceSelect?: boolean
		extraPanelItems?: React.ReactNode
	},
) {
	const getTableFrame = () => getFrameState(props.frameKey).layerTable
	const useTableFrame = <O,>(selector: (table: LayerTablePrt.LayerTable) => O) => useFrameStore(props.frameKey, s => selector(s.layerTable))

	const frameState = useTableFrame(
		ZusUtils.useShallow(table => ({
			colConfig: table.colConfig,
			showSelectedLayers: table.showSelectedLayers,
			setShowSelectedLayers: table.setShowSelectedLayers,
			sort: table.sort,
			setSort: table.setSort,
			maxSelectedLayers: table.maxSelected,
			editingSingleValue: LayerTablePrt.selectEditingSingleValue(table),
			selectedLayerIds: table.selected,
			isFetching: table.isFetching,
		})),
	)

	const showSelectedId = React.useId()

	const canToggleColumns = props.canToggleColumns ?? true
	// Compute default visible columns from config
	const defaultVisibleColumns = React.useMemo(() => {
		if (!frameState.colConfig) return []
		return frameState.colConfig.orderedColumns
			.filter(col => col.visible ?? true)
			.map(col => col.name)
	}, [frameState.colConfig])

	const table = props.table

	const toggleRandomizeId = React.useId()
	const randomized = frameState.sort?.type === 'random'
	function toggleRandomize() {
		const sort = getTableFrame().sort
		if (sort?.type === 'random') {
			frameState.setSort(null)
		} else {
			getTableFrame().randomize()
		}
	}

	const loggedInUser = useLoggedInUser()
	const userCanForceSelect = !!loggedInUser && RBAC.rbacUserHasPerms(loggedInUser, RBAC.perm('queue:force-write'))

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
							title="Column"
							values={table.getAllLeafColumns().filter(col => col.getIsVisible()).map(col => col.id)}
							options={table.getAllLeafColumns().map(col => ({
								value: col.id,
								label: col.id,
							}))}
							onSelect={(updater) => {
								const newSelectedIds = typeof updater === 'function'
									? updater(table.getAllLeafColumns().filter(col => col.getIsVisible()).map(col => col.id))
									: updater
								table.getAllLeafColumns().forEach(column => {
									column.toggleVisibility(newSelectedIds.includes(column.id))
								})
							}}
							restrictValueSize={false}
							reset={defaultVisibleColumns}
						>
							<Button variant="ghost" size="icon" title="Toggle Columns">
								<Icons.Columns3 />
							</Button>
						</ComboBoxMulti>
					)}

					{props.enableForceSelect && (
						<Toggle
							size="sm"
							title={`${rawSetDialogOpen ? 'Hide' : 'Show'} Raw Input`}
							aria-label={`${rawSetDialogOpen ? 'Hide' : 'Show'} Raw Input`}
							pressed={rawSetDialogOpen}
							onClick={() => setRawSetDialogOpen(prev => !prev)}
							disabled={!userCanForceSelect}
						>
							<Icons.TextCursorInput />
						</Toggle>
					)}

					<Separator orientation="vertical" className="h-full min-h-0" />

					{/*--------- show selected ---------*/}
					<div className="flex items-center space-x-1">
						<Switch
							id={showSelectedId}
							checked={frameState.showSelectedLayers}
							disabled={frameState.selectedLayerIds.length === 0}
							onCheckedChange={() =>
								frameState.setShowSelectedLayers((show: boolean) => {
									if (getTableFrame().selected.length === 0) return false
									return !show
								})}
						/>
						<Label htmlFor={showSelectedId}>Show Selected</Label>
					</div>
					<Button
						variant="ghost"
						size="icon"
						disabled={frameState.selectedLayerIds.length === 0}
						onClick={() => {
							getTableFrame().resetSelected()
						}}
						title="Reset Selected Layers"
					>
						<Icons.Trash className="h-4 w-4" />
					</Button>
					<p
						className="whitespace-nowrap text-muted-foreground data-[hide=true]:invisible"
						data-hide={frameState.selectedLayerIds.length === 0}
					>
						{frameState.selectedLayerIds.length} selected
					</p>
				</span>
				<span className="flex h-10 items-center space-x-2 ">
					{props.extraPanelItems}
					<Button
						onClick={() => getTableFrame().randomize()}
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
								<Label htmlFor={toggleRandomizeId}>Randomize</Label>
							</div>
						</TooltipTrigger>
						<TooltipContent>
							Randomize layer selection (weighted to preferable layers)
						</TooltipContent>
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
					defaultValue={frameState.editingSingleValue && frameState.selectedLayerIds.length === 1
						? L.getLayerCommand(frameState.selectedLayerIds[0], 'set-next')
						: undefined}
					onSubmit={layers => {
						getTableFrame().setSelected(prev => [...prev, ...layers.map(l => l.id)])
						getTableFrame().setShowSelectedLayers(true)
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

	const setInputText = React.useCallback((value: string) => {
		value = value.trim()
		const layerRes = L.parseRawLayerText(value)
		setValidLayer(layerRes)
	}, [setValidLayer])

	React.useImperativeHandle(props.ref, () => ({
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
	}), [setInputText])

	React.useLayoutEffect(() => {
		if (layersKnownRes.data) {
			setLayerFound(layersKnownRes.data.results[0].exists)
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
				<MultiLayerSetDialog open={multiSetLayerDialogOpen} setOpen={setMultiSetLayerDialogOpen} onSubmit={props.onSubmit} />
				<Input
					ref={inputRef}
					defaultValue={props.defaultValue}
					className="flex-1"
					placeholder="Ex: Narva_RAAS_v1 RGF USMC or a layer id"
					onChange={(e) => setInputText(e.target.value)}
					rightElement={
						<div className="flex space-x-1 items-center">
							<Label
								title="Layer exists in the database"
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

function MultiLayerSetDialog({
	onSubmit,
	open,
	setOpen,
}: {
	onSubmit: (value: L.UnvalidatedLayer[]) => void
	open: boolean
	setOpen: (open: boolean) => void
}) {
	const [possibleLayers, setPossibleLayers] = React.useState([] as L.UnvalidatedLayer[])
	function onTextChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
		const text = e.target.value
		const lines = text.trim().split('\n').filter(line => line.trim().length > 0)
		const possibleLayers = lines.map(line => L.parseRawLayerText(line.trim())).filter(l => l !== null)
		setPossibleLayers(possibleLayers)
	}

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogContent className="max-w-lg min-w-[min(700px,70vw)]">
				<DialogHeader>
					<DialogTitle>Add Multiple Layers</DialogTitle>
				</DialogHeader>
				<div className="space-y-4">
					<div className="relative">
						<Textarea
							onChange={onTextChange}
							className=" w-full min-h-75 pr-8 min-w overflow-x-auto text-sm font-mono"
							style={{ 'lineHeight': '1.5rem' }}
							wrap="off"
							placeholder="Enter one layer per line (e.g. Narva_RAAS_v1 RGF USMC or a layer id)"
						/>
					</div>
					<div className="flex justify-end space-x-2">
						<Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
						<Button
							onClick={() => {
								onSubmit(possibleLayers)
								setOpen(false)
							}}
							disabled={possibleLayers.length === 0}
						>
							Add Layers
						</Button>
					</div>
				</div>
			</DialogContent>
		</Dialog>
	)
}

function LayerTablePaginationControls(props: { frameKey: LayerTablePrt.Key; table: CoreTable<LayerQueriesClient.RowData> }) {
	const useTableFrame = <O,>(selector: (table: LayerTablePrt.LayerTable) => O) => useFrameStore(props.frameKey, s => selector(s.layerTable))

	const initStatus = Zus.useStore(
		LayerQueriesClient.Store,
		ZusUtils.useShallow(s => ({ status: s.status, errorMessage: s.errorMessage })),
	)
	const frameState = useTableFrame(ZusUtils.useShallow(table => ({
		pageSize: table.pageSize,
		pageIndex: table.pageIndex,
		totalRowCount: table.pageData?.totalCount,
		totalPageCount: table.pageData?.pageCount,
		isFetching: table.isFetching,
	})))

	return (
		<div className="flex items-center justify-between space-x-4 py-2">
			<div className="flex items-center space-x-2">
				{initStatus.status === 'ready' && !frameState.isFetching && (
					<div className="text-sm text-muted-foreground">
						{(frameState.totalRowCount ?? 0) > 0
							? (
								<>
									<span className="font-semibold text-foreground">{(frameState.totalRowCount ?? 0).toLocaleString()}</span> matched layers
								</>
							)
							: <span className="font-semibold text-foreground">No layers matched</span>}
					</div>
				)}
				<div
					data-loading={frameState.isFetching || initStatus.status === 'initializing'
						|| initStatus.status === 'downloading-layers'}
					className="flex items-center space-x-2 invisible data-[loading=true]:visible "
				>
					<LoaderCircle className="h-4 w-4 animate-spin" />
					{initStatus.status === 'initializing' && <p className={Typo.Muted}>Initializing layer database...</p>}
					{initStatus.status === 'downloading-layers' && (
						<p className={Typo.Muted}>Downloading layers from server, this may take a few minutes...</p>
					)}
				</div>
				{initStatus.status === 'error' && (
					<div className="flex items-center space-x-2 text-destructive">
						<span className="font-semibold">Error loading layers:</span>
						<span className="text-sm">{initStatus.errorMessage ?? 'Unknown error'}</span>
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
