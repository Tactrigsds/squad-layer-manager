import ComboBoxMulti from '@/components/combo-box/combo-box-multi'
import { Button } from '@/components/ui/button'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuShortcut, ContextMenuTrigger } from '@/components/ui/context-menu'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Toggle } from '@/components/ui/toggle'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import * as LayerTablePrt from '@/frame-partials/layer-table.partial'
import { getFrameState, useFrameStore } from '@/frames/frame-manager'
import { useDebouncedState } from '@/hooks/use-debounce'
import * as DH from '@/lib/display-helpers'
import * as FRM from '@/lib/frame'
import { Focusable } from '@/lib/react'
import * as ReactRxHelpers from '@/lib/react-rxjs-helpers'
import { assertNever } from '@/lib/type-guards'
import * as Typo from '@/lib/typography'
import * as ZusUtils from '@/lib/zustand'
import * as CS from '@/models/context-shared'
import * as F from '@/models/filter.models'
import * as L from '@/models/layer'
import * as LC from '@/models/layer-columns'
import * as LQY from '@/models/layer-queries.models.ts'
import * as RBAC from '@/rbac.models'
import * as ConfigClient from '@/systems.client/config.client'
import * as GlobalSettings from '@/systems.client/global-settings'
import * as LayerQueriesClient from '@/systems.client/layer-queries.client'
import * as QD from '@/systems.client/queue-dashboard'
import { useLoggedInUser } from '@/systems.client/users.client'
import { ColumnDef, createColumnHelper, flexRender, getCoreRowModel, getSortedRowModel, OnChangeFn, PaginationState, Row, RowSelectionState, SortDirection, useReactTable, VisibilityState } from '@tanstack/react-table'
import * as Im from 'immer'
import * as Icons from 'lucide-react'
import { ArrowDown, ArrowUp, ArrowUpDown, Dices, LoaderCircle } from 'lucide-react'
import { useRef, useState } from 'react'
import React from 'react'
import { flushSync } from 'react-dom'
import * as Zus from 'zustand'
import { ConstraintDisplay } from './constraint-display'
import { LayerContextMenuItems } from './layer-table-helpers'
import MapLayerDisplay from './map-layer-display'
import { TablePagination } from './table-pagination'
import { Checkbox } from './ui/checkbox'
import { Input } from './ui/input'
import { Kbd } from './ui/kbd'
import { Label } from './ui/label'
import { Separator } from './ui/separator'
import { Switch } from './ui/switch'
import { Textarea } from './ui/textarea'
export type { PostProcessedLayer } from '@/systems.shared/layer-queries.shared'

type ConstraintRowDetails = {
	values: boolean[]
	violationDescriptors: LQY.MatchDescriptor[]
}
type RowData = L.KnownLayer & Record<string, any> & { 'constraints': ConstraintRowDetails }
const columnHelper = createColumnHelper<RowData>()

const formatFloat = (value: number) => {
	const formatted = value.toFixed(2)
	const numeric = parseFloat(formatted)
	if (numeric > 0) return `+${formatted}`
	return formatted
}
function buildColumn(
	colDef: LC.ColumnDef,
	teamParity: number,
	displayLayersNormalized: boolean,
	isNumeric: boolean,
	sortingState: LayerTablePrt.LayerTable['sort'],
	setSorting: LayerTablePrt.LayerTable['setSort'],
) {
	return columnHelper.accessor(colDef.name, {
		enableHiding: true,
		enableSorting: false, // Disable default sorting, we'll handle it manually
		size: colDef.name === 'Layer' ? 300 : isNumeric ? 50 : undefined,
		minSize: colDef.name === 'Layer' ? 200 : undefined,
		header: () => {
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
		cell: (info) => {
			const violationDescriptors = info.row.original.violationDescriptors
			if (colDef.name === 'Layer') {
				return (
					<div className="pl-4">
						<MapLayerDisplay
							layer={L.toLayer(info.row.original.id).Layer}
							extraLayerStyles={{
								Map: DH.getColumnExtraStyles('Map', teamParity, displayLayersNormalized, violationDescriptors),
								Layer: DH.getColumnExtraStyles('Layer', teamParity, displayLayersNormalized, violationDescriptors),
								Gamemode: DH.getColumnExtraStyles('Gamemode', teamParity, displayLayersNormalized, violationDescriptors),
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
			const extraStyles = DH.getColumnExtraStyles(
				colDef.name as keyof L.KnownLayer,
				teamParity,
				displayLayersNormalized,
				violationDescriptors,
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

function Cell({ row, constraints }: { row: Row<RowData>; constraints: LQY.Constraint[] }) {
	const loggedInUser = useLoggedInUser()
	const canForceWrite = !!loggedInUser && RBAC.rbacUserHasPerms(loggedInUser, RBAC.perm('queue:force-write'))

	return (
		<Checkbox
			checked={row.getIsSelected()}
			className={getIsRowDisabled(row, canForceWrite, constraints) ? 'invisible' : ''}
			aria-label="Select row"
		/>
	)
}

function buildColDefs(
	cfg: LQY.EffectiveColumnAndTableConfig,
	teamParity: number,
	displayLayersNormalized: boolean,
	constraints: LQY.Constraint[] | undefined,
	sort: LayerTablePrt.LayerTable['sort'],
	setSort: LayerTablePrt.LayerTable['setSort'],
) {
	const tableColDefs: ColumnDef<RowData>[] = [
		{
			id: 'select',
			header: ({ table }) => (
				<div className="pl-4">
					<Checkbox
						checked={table.getIsAllPageRowsSelected() || (table.getIsSomePageRowsSelected() && 'indeterminate')}
						onCheckedChange={(value) => table.toggleAllPageRowsSelected(!!value)}
						aria-label="Select all"
					/>
				</div>
			),
			cell: ({ row }) => <Cell row={row} constraints={constraints ?? []} />,
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

		const ctx: CS.EffectiveColumnConfig = { effectiveColsConfig: cfg }

		// add sorted first
		for (const col of sortedColKeys) {
			const colDef = LC.getColumnDef(col.name, cfg)!
			const isNumeric = LC.isNumericColumn(col.name, ctx)
			tableColDefs.push(buildColumn(colDef, teamParity, displayLayersNormalized, isNumeric, sort, setSort))
		}

		// then add the rest
		for (const key of Object.keys(cfg.defs)) {
			if (sortedColKeys.some(c => c.name === key)) continue
			const colDef = LC.getColumnDef(key, cfg)!
			const isNumeric = LC.isNumericColumn(key, ctx)
			tableColDefs.push(buildColumn(colDef, teamParity, displayLayersNormalized, isNumeric, sort, setSort))
		}
	}

	if (constraints) {
		const constraintsCol = columnHelper.accessor('constraints', {
			header: '',
			enableHiding: false,
			cell: info => {
				const { values, violationDescriptors: matchDescriptors } = info.getValue()
				if (!matchDescriptors || !values || !constraints) return null
				const matchingConstraints = constraints!.filter((c, i) => values[i])
				return (
					<div>
						<ConstraintDisplay
							className="w-full"
							side="right"
							padEmpty={true}
							matchingConstraints={matchingConstraints}
							height={32}
						/>
					</div>
				)
			},
		})
		tableColDefs.push(constraintsCol as any)
	}

	return tableColDefs
}

export default function LayerTable(props: {
	frameKey: LayerTablePrt.Key
	extraPanelItems?: React.ReactNode

	enableForceSelect?: boolean
	canChangeRowsPerPage?: boolean
	canToggleColumns?: boolean
}) {
	const getTableFrame = () => getFrameState(props.frameKey).layerTable
	const getStore = () => getFrameState(props.frameKey)
	const useTableFrame = <O,>(selector: (table: LayerTablePrt.LayerTable) => O) => useFrameStore(props.frameKey, s => selector(s.layerTable))

	const canChangeRowsPerPage = props.canChangeRowsPerPage ?? true

	const canToggleColumns = props.canToggleColumns ?? true
	const cfg = ConfigClient.useEffectiveColConfig()

	// Compute default visible columns from config
	const defaultVisibleColumns = React.useMemo(() => {
		if (!cfg) return []
		return cfg.orderedColumns
			.filter(col => col.visible ?? true)
			.map(col => col.name)
	}, [cfg])

	const [showSelectedLayers, setShowSelectedLayers] = useTableFrame(
		ZusUtils.useShallow(table => [table.showSelectedLayers, table.setShowSelectedLayers]),
	)
	const [sort, setSort] = useTableFrame(
		ZusUtils.useShallow(table => [table.sort, table.setSort]),
	)
	const randomized = sort?.type === 'random'

	const tanstackSortingState = useTableFrame(
		ZusUtils.useDeep(LayerTablePrt.selectTanstackSortingState),
	)

	function toggleRandomize() {
		const sort = getTableFrame().sort
		if (sort?.type === 'random') {
			setSort(null)
		} else {
			getTableFrame().randomize()
		}
	}

	const [columnVisibility, onColumnVisibilityChange] = useTableFrame(
		ZusUtils.useShallow(table => [table.columnVisibility, table.onColumnVisibilityChange]),
	)

	const [rawSetDialogOpen, _setRawSetDialogOpen] = useState(false)
	const rawSetDialogRef = useRef<SetRawDialogHandle>(null)
	function setRawSetDialogOpen(update: (value: boolean) => boolean) {
		flushSync(() => {
			_setRawSetDialogOpen(update)
		})
		rawSetDialogRef.current?.focus()
	}

	const maxSelectedLayers = useTableFrame(t => t.maxSelected)
	const editingSingleValue = useTableFrame(LayerTablePrt.selectEditingSingleValue)
	const selectedLayerIds = useTableFrame(t => t.selected)
	const rowSelection: RowSelectionState = useTableFrame(
		ZusUtils.useDeep(LayerTablePrt.selectTanstackRowSelection),
	)
	const onSetRowSelection: OnChangeFn<RowSelectionState> = useTableFrame(t => t.onSetRowSelection)
	const [pageSize, pageIndex] = useTableFrame(
		ZusUtils.useShallow(t => [t.pageSize, t.pageIndex]),
	)
	const onPaginationChange: OnChangeFn<PaginationState> = useTableFrame(t => t.onPaginationChange)
	const queryInput = useFrameStore(props.frameKey, ZusUtils.useDeep(LayerTablePrt.selectQueryInput))
	const layersRes = LayerQueriesClient.useLayersQuery(queryInput)

	const page = React.useMemo(() => {
		let _page = layersRes.data
		if (layersRes.data && layersRes.data.code !== 'ok') return null
		if (showSelectedLayers && _page) {
			const layerIdsForPage = selectedLayerIds.slice(pageIndex * pageSize, (pageIndex * pageSize) + pageSize)
			const selectedLayers = layerIdsForPage.map((id) => {
				const layer = _page!.layers.find(l => l.id === id)
				if (layer) return layer
				return {
					...L.toLayer(id),
					constraints: Array(queryInput.constraints?.length ?? 0).fill(false),
					violationDescriptors: [],
				}
			})
			if (sort) {
				;(selectedLayers as Record<string, any>[]).sort((a: any, b: any) => {
					if (sort.type === 'random') {
						// For random sort just shuffle the entries
						return Math.random() - 0.5
					} else if (sort.type === 'column') {
						const column = sort.sortBy
						const direction = sort.direction === 'ASC' ? 1 : -1

						if (a[column] === b[column]) return 0
						if (a[column] === null || a[column] === undefined) return direction
						if (b[column] === null || b[column] === undefined) return -direction

						return a[column] < b[column] ? -direction : direction
					} else {
						assertNever(sort)
					}
				})
			}
			_page = { ..._page, layers: [...selectedLayers as any] }
		}
		if (_page) {
			return {
				..._page,
				layers: _page.layers?.map((layer): RowData => ({
					...layer,
					constraints: { values: layer.constraints, violationDescriptors: layer.violationDescriptors },
				})),
			}
		} else {
			return undefined
		}
	}, [layersRes.data, showSelectedLayers, selectedLayerIds, pageIndex, pageSize, sort, queryInput.constraints?.length])

	const teamParity = ReactRxHelpers.useStateObservableSelection(
		QD.layerItemsState$,
		React.useCallback((state) => {
			LQY.resolveTeamParityForCursor(state, queryInput)
		}, [queryInput]),
	)
	const displayTeamsNormalized = Zus.useStore(GlobalSettings.GlobalSettingsStore, (state) => state.displayTeamsNormalized)

	const table = useReactTable({
		data: page?.layers ?? [],
		columns: React.useMemo(
			() => cfg ? buildColDefs(cfg, teamParity ?? 0, displayTeamsNormalized, queryInput.constraints, sort, setSort) : [],
			[
				cfg,
				teamParity,
				displayTeamsNormalized,
				queryInput.constraints,
				sort,
				setSort,
			],
		),
		defaultColumn: {
			size: 150,
			minSize: 50,
		},
		pageCount: page?.pageCount ?? -1,
		state: {
			sorting: tanstackSortingState,
			columnVisibility,
			rowSelection,
			pagination: {
				pageIndex: pageIndex,
				pageSize,
			},
		},
		getRowId: (row) => row.id,
		onColumnVisibilityChange: onColumnVisibilityChange,
		onRowSelectionChange: onSetRowSelection,
		onPaginationChange,
		getCoreRowModel: getCoreRowModel(),
		getSortedRowModel: getSortedRowModel(),
		manualPagination: true,
	})

	const currentPage = Math.min(pageIndex, page?.pageCount ?? 0)
	const firstRowInPage = currentPage * (page?.layers.length ?? 0) + 1
	const lastRowInPage = Math.min(firstRowInPage + pageSize - 1, page?.totalCount ?? 0)

	const loggedInUser = useLoggedInUser()
	const userCanForceSelect = !!loggedInUser && RBAC.rbacUserHasPerms(loggedInUser, RBAC.perm('queue:force-write'))
	const fetchingBuffer = LayerQueriesClient.useFetchingBuffer()

	function getChosenRows(row: Row<L.KnownLayer>) {
		if (!getTableFrame().selected.includes(row.original.id)) {
			return [row.original.id]
		} else {
			const rowSelection = LayerTablePrt.selectTanstackRowSelection(getTableFrame())
			return table
				.getRowModel()
				.rows.filter((r) => rowSelection[r.id])
				.map((r) => r.original.id)
		}
	}

	const toggleRandomizeId = React.useId()

	const canFocusLayers = useFrameStore(props.frameKey, s => !!s.onLayerFocused)

	return (
		<div className="space-y-2">
			<div className="flex items-center justify-between">
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
							checked={showSelectedLayers}
							disabled={selectedLayerIds.length === 0}
							onCheckedChange={() =>
								setShowSelectedLayers((show: boolean) => {
									if (getTableFrame().selected.length === 0) return false
									return !show
								})}
							id="toggle-show-selected"
						/>
						<Label htmlFor="toggle-show-selected">Show Selected</Label>
					</div>
					<Button
						variant="ghost"
						size="icon"
						disabled={selectedLayerIds.length === 0}
						onClick={() => {
							getTableFrame().resetSelected()
						}}
						title="Reset Selected Layers"
					>
						<Icons.Trash />
					</Button>
					<p className="whitespace-nowrap text-muted-foreground">
						{selectedLayerIds.length} selected
					</p>
				</span>
				<span className="flex h-10 items-center space-x-2 ">
					{props.extraPanelItems}
					<Button
						onClick={() => getTableFrame().randomize()}
						disabled={layersRes.isFetching}
						variant="outline"
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
									disabled={showSelectedLayers}
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
					maxSelectedLayers={maxSelectedLayers}
					editingSingleValue={editingSingleValue}
					open={rawSetDialogOpen}
					setOpen={setRawSetDialogOpen}
					defaultValue={editingSingleValue && selectedLayerIds.length === 1
						? L.getLayerCommand(selectedLayerIds[0], 'set-next')
						: undefined}
					onSubmit={layers => {
						getTableFrame().setSelected(prev => [...prev, ...layers.map(l => l.id)])
						getTableFrame().setShowSelectedLayers(true)
					}}
				/>
			</div>
			<div className="rounded-md border min-w-[1000px]">
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
						{table.getRowModel().rows.map((row) => {
							const id = row.original.id
							const disabled = 'hover:bg-unset bg-grey-800'
							const selectedForCopy = getChosenRows(row)

							return (
								<ContextMenu key={row.id}>
									<ContextMenuTrigger asChild>
										<TableRow
											key={row.id}
											className={getIsRowDisabled(row, userCanForceSelect, queryInput.constraints ?? []) ? disabled : ''}
											onClick={(e) => {
												if (e.ctrlKey && e.button === 0) {
													getStore().onLayerFocused?.(id)
													return
												}

												if (getIsRowDisabled(row, userCanForceSelect, queryInput.constraints ?? [])) return

												onSetRowSelection(
													Im.produce(rowSelection, (draft) => {
														draft[id] = !draft[id]
													}),
												)
											}}
										>
											{row.getVisibleCells().map((cell) => (
												<TableCell
													className={cell.column.id === 'select' ? 'pl-4' : undefined}
													key={cell.id}
													style={{ width: cell.column.getSize() }}
												>
													{flexRender(cell.column.columnDef.cell, cell.getContext())}
												</TableCell>
											))}
										</TableRow>
									</ContextMenuTrigger>
									<ContextMenuContent>
										{<LayerContextMenuItems selectedLayerIds={selectedForCopy} />}
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
						})}
						{/* Placeholder rows to prevent layout shift when table is not full */}
						{Array.from({ length: Math.max(0, pageSize - table.getRowModel().rows.length) }).map((_, index) => (
							<TableRow key={`placeholder-${index}`} className="pointer-events-none">
								{table.getVisibleFlatColumns().map((column) => (
									<TableCell
										key={column.id}
										className={column.id === 'select' ? 'pl-4' : undefined}
										style={{ width: column.getSize() }}
									>
										<div style={{ height: '32px' }} />
									</TableCell>
								))}
							</TableRow>
						))}
					</TableBody>
				</Table>
			</div>
			{/*--------- pagination controls ---------*/}
			<div className="flex items-center justify-between space-x-4 py-2">
				<div className="flex items-center space-x-2">
					<div className="text-sm text-muted-foreground">
						{page && true && (
							<>
								<span className="font-semibold text-foreground">{page?.totalCount?.toLocaleString()}</span> matched layers
							</>
						)}
					</div>
					<div data-loading={layersRes.isFetching} className="flex items-center space-x-2 invisible data-[loading=true]:visible ">
						<LoaderCircle className="h-4 w-4 animate-spin" />
						{fetchingBuffer && <p className={Typo.Muted}>Downloading layers from server, this may take a few minutes...</p>}
					</div>
				</div>
				{(page?.pageCount ?? 0) > 0 && (
					<TablePagination
						pageIndex={pageIndex}
						pageCount={page?.pageCount ?? 0}
						onPageChange={(newPageIndex) => {
							table.setPageIndex(newPageIndex)
						}}
						disabled={layersRes.isFetching}
					/>
				)}
			</div>
		</div>
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
				className="flex items-center space-x-1 whitespace-nowrap w-full"
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
	const [possibleLayers, setPossibleLayers] = useState([] as L.UnvalidatedLayer[])
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
							className=" w-full min-h-[300px] pr-8 min-w overflow-x-auto text-sm font-mono"
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
function getIsLayerDisabled(layerData: RowData, canForceSelect: boolean, constraints: LQY.Constraint[]) {
	return !canForceSelect && layerData.constraints.values?.some((v, i) => !v && constraints[i].type !== 'do-not-repeat')
}

function getIsRowDisabled(row: Row<RowData>, canForceSelect: boolean, constraints: LQY.Constraint[]) {
	return !row.getIsSelected() && getIsLayerDisabled(row.original, canForceSelect, constraints)
}
