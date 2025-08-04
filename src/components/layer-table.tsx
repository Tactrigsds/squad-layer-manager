import { Button } from '@/components/ui/button'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@/components/ui/context-menu'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Toggle } from '@/components/ui/toggle'
import { useDebounced } from '@/hooks/use-debounce'
import { toast } from '@/hooks/use-toast'
import * as DH from '@/lib/display-helpers'
import * as ReactRxHelpers from '@/lib/react-rxjs-helpers'
import { assertNever } from '@/lib/type-guards'
import * as Typo from '@/lib/typography'
import * as F from '@/models/filter.models'
import * as L from '@/models/layer'
import * as LC from '@/models/layer-columns'
import * as LQY from '@/models/layer-queries.models.ts'
import * as RBAC from '@/rbac.models'
import * as ConfigClient from '@/systems.client/config.client'
import * as GlobalSettings from '@/systems.client/global-settings'
import * as LayerQueriesClient from '@/systems.client/layer-queries.client'
import * as QD from '@/systems.client/queue-dashboard'
import * as Zus from 'zustand'
export type { PostProcessedLayer } from '@/systems.shared/layer-queries.shared'
import { Focusable } from '@/lib/react'
import { cn } from '@/lib/utils'
import { useLoggedInUser } from '@/systems.client/users.client'
import { ColumnDef, createColumnHelper, flexRender, getCoreRowModel, getSortedRowModel, OnChangeFn, PaginationState, Row, RowSelectionState, SortingState, useReactTable, VisibilityState } from '@tanstack/react-table'
import * as Im from 'immer'
import * as Icons from 'lucide-react'
import { ArrowDown, ArrowUp, ArrowUpDown, Dices, LoaderCircle } from 'lucide-react'
import { useRef, useState } from 'react'
import React from 'react'
import { flushSync } from 'react-dom'
import { ConstraintViolationDisplay } from './constraint-violation-display'
import { MapLayerDisplay } from './layer-display'
import { Checkbox } from './ui/checkbox'
import { Input } from './ui/input'
import { Label } from './ui/label'
import { Separator } from './ui/separator'
import { Switch } from './ui/switch'
import { Textarea } from './ui/textarea'

type ConstraintRowDetails = {
	values: boolean[]
	violationDescriptors: LQY.ViolationDescriptor[]
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
) {
	return columnHelper.accessor(colDef.name, {
		header: ({ column }) => {
			const sort = column.getIsSorted()
			return (
				<Button
					className="data-[sort=true]:text-accent-foreground w-full justify-between"
					size="sm"
					data-sort={!!sort}
					variant="ghost"
					title={colDef.displayName}
					onClick={() => column.toggleSorting(column.getIsSorted() === 'asc')}
				>
					{colDef.shortName ?? colDef.displayName}
					{!sort && <ArrowUpDown className="ml-2 h-4 w-4" />}
					{sort === 'asc' && <ArrowUp className="ml-2 h-4 w-4" />}
					{sort === 'desc' && <ArrowDown className="ml-2 h-4 w-4" />}
				</Button>
			)
		},
		cell: (info) => {
			const value = info.getValue()
			if (value === null) return DH.NULL_DISPLAY

			const violationDescriptors = info.row.original.violationDescriptors
			if (colDef.name === 'Layer') {
				return (
					<MapLayerDisplay
						layer={L.toLayer(info.row.original.id).Layer}
						extraLayerStyles={{
							Map: DH.getColumnExtraStyles('Map', teamParity, displayLayersNormalized, violationDescriptors),
							Layer: DH.getColumnExtraStyles('Layer', teamParity, displayLayersNormalized, violationDescriptors),
							Gamemode: DH.getColumnExtraStyles('Gamemode', teamParity, displayLayersNormalized, violationDescriptors),
						}}
					/>
				)
			}

			let text: string
			switch (colDef.type) {
				case 'float':
					if (value === null || value === undefined) {
						text = '-'
						break
					}
					text = formatFloat(value as unknown as number)
					break
				case 'string':
					text = value ?? '-'
					break
				case 'integer':
					text = value?.toString() ?? '-'
					break
				case 'boolean':
					if (value === null || value === undefined) {
						text = '-'
						break
					}
					text = value ? 'True' : 'False'
					break
				default:
					assertNever(colDef)
			}

			const extraStyles = DH.getColumnExtraStyles(
				colDef.name as keyof L.KnownLayer,
				teamParity,
				displayLayersNormalized,
				violationDescriptors,
			)

			return (
				<div
					className={extraStyles}
				>
					{text}
				</div>
			)
		},
	})
}

function Cell({ row, constraints }: { row: Row<RowData>; constraints: LQY.LayerQueryConstraint[] }) {
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
	constraints?: LQY.LayerQueryConstraint[],
) {
	const colDefs: ColumnDef<RowData>[] = [
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

		for (const col of sortedColKeys) {
			colDefs.push(buildColumn(LC.getColumnDef(col.name, cfg)!, teamParity, displayLayersNormalized))
		}
	}

	if (constraints) {
		const constraintsCol = columnHelper.accessor('constraints', {
			header: '',
			enableHiding: false,
			cell: info => {
				const { values, violationDescriptors } = info.getValue()
				if (!violationDescriptors || !values) return null
				const namedConstraints = constraints.filter((c, i) => c.applyAs === 'field' && !values[i]) as LQY.NamedQueryConstraint[]
				return (
					<ConstraintViolationDisplay
						padEmpty={true}
						violated={namedConstraints}
						violationDescriptors={violationDescriptors}
					/>
				)
			},
		})
		colDefs.push(constraintsCol as any)
	}

	return colDefs
}

export default function LayerTable(props: {
	// make sure this reference is stable
	baseInput?: LQY.LayerQueryBaseInput

	selected: L.LayerId[]
	setSelected: React.Dispatch<React.SetStateAction<L.LayerId[]>>
	resetSelected?: () => void
	enableForceSelect?: boolean

	pageIndex: number
	// make sure this reference is stable
	setPageIndex: (num: number) => void

	defaultPageSize?: number
	defaultSort?: LQY.LayersQueryInput['sort']
	defaultColumns?: string[]

	editingSingleValue?: boolean

	canChangeRowsPerPage?: boolean
	canToggleColumns?: boolean

	extraPanelItems?: React.ReactNode
	errorStore?: Zus.StoreApi<F.NodeValidationErrorStore>
}) {
	const canChangeRowsPerPage = props.canChangeRowsPerPage ?? true

	const canToggleColumns = props.canToggleColumns ?? true
	const cfg = ConfigClient.useEffectiveColConfig()
	const pageIndex = props.pageIndex

	// {
	// 	const constraintsRef = React.useRef(props.baseInput?.constraints)
	// 	if (!deepEqual(constraintsRef.current, props.baseInput?.constraints)) {
	// 		props.setPageIndex(0)
	// 		pageIndex = 0
	// 	}
	// 	constraintsRef.current = props.baseInput?.constraints
	// }

	const [showSelectedLayers, _setShowSelectedLayers] = useState(false)
	const setShowSelectedLayers: React.Dispatch<React.SetStateAction<boolean>> = (value) => {
		_setShowSelectedLayers(value)
		props.setPageIndex(0)
		if (sortingState.length > 0) {
			setSorting([])
		}
	}

	let defaultSortingState: SortingState = []
	if (props.defaultSort && props.defaultSort.type === 'column') {
		defaultSortingState = [{
			id: props.defaultSort.sortBy,
			desc: props.defaultSort.sortDirection === 'DESC',
		}]
	}

	const [sortingState, _setSortingState] = useState<SortingState>(defaultSortingState)
	const setSorting: React.Dispatch<React.SetStateAction<SortingState>> = (sortingUpdate) => {
		_setSortingState((sortingState) => {
			if (typeof sortingUpdate === 'function') {
				return sortingUpdate(sortingState)
			} else return sortingState
		})
		setRandomize(false)
		props.setPageIndex(0)
	}
	const [_randomize, setRandomize] = useState<boolean>(props.defaultSort?.type === 'random')
	const randomize = !showSelectedLayers && _randomize

	function toggleRandomize() {
		setRandomize((prev) => {
			if (!prev) {
				refreshSeed()
				_setSortingState([])
			}
			return !prev
		})
	}

	const [_columnVisibility, setColumnVisibility] = useState<VisibilityState | undefined>()
	const defaultVisibility = React.useMemo(() => cfg ? LQY.getColVisibilityState(cfg) : undefined, [cfg])
	const columnVisibility = _columnVisibility ?? defaultVisibility

	const [rawSetDialogOpen, _setRawSetDialogOpen] = useState(false)
	const rawSetDialogRef = useRef<SetRawDialogHandle>(null)
	function setRawSetDialogOpen(update: (value: boolean) => boolean) {
		flushSync(() => {
			_setRawSetDialogOpen(update)
		})
		rawSetDialogRef.current?.focus()
	}

	const rowSelection: RowSelectionState = Object.fromEntries(props.selected.map((id) => [id, true]))
	const now = Date.now()
	const insertionTimes = useRef<Record<L.LayerId, number | undefined>>(Object.fromEntries(props.selected.map((id) => [id, now])))
	const onSetRowSelection: OnChangeFn<RowSelectionState> = (updated) => {
		props.setSelected((selectedIds) => {
			let newValues: RowSelectionState
			if (typeof updated === 'function') {
				newValues = updated(Object.fromEntries(selectedIds.map((key) => [key, true])))
			} else {
				newValues = updated
			}

			// prevent seelction of disabled rows
			if (!userCanForceSelect) {
				for (const id of Object.keys(newValues)) {
					const layer = page?.layers.find(layer => layer.id === id)
					if (layer && newValues[id] && getIsLayerDisabled(layer, userCanForceSelect, props.baseInput?.constraints ?? [])) {
						newValues[id] = false
					}
				}
			}

			let updatedSelectedIds = Object.keys(newValues).filter((key) => newValues[key])
			if (updatedSelectedIds.length === 0) {
				setShowSelectedLayers(false)
			}
			if (props.editingSingleValue && updatedSelectedIds.length > 0) {
				updatedSelectedIds = updatedSelectedIds.slice(updatedSelectedIds.length - 1)
				if (updatedSelectedIds.length > 0) rawSetDialogRef.current?.setInput(updatedSelectedIds[0])
			}
			const now = Date.now()
			for (const id of Object.keys(newValues)) {
				if (!updatedSelectedIds.includes(id)) {
					delete insertionTimes.current[id]
				}
			}

			for (const id of updatedSelectedIds) {
				if (!(id in insertionTimes.current)) {
					insertionTimes.current[id] = now
				}
			}
			updatedSelectedIds.sort((a, b) => (insertionTimes.current[a] ?? now) - (insertionTimes.current[b] ?? now))
			return updatedSelectedIds
		})
	}

	const [pageSize, setPageSize] = useState(props.defaultPageSize ?? 10)
	const onPaginationChange: OnChangeFn<PaginationState> = (updater) => {
		let newState: PaginationState
		if (typeof updater === 'function') {
			newState = updater({ pageIndex, pageSize })
		} else {
			newState = updater
		}
		props.setPageIndex(newState.pageIndex)
		setPageSize(newState.pageSize)
	}
	const [seed, setSeed] = useState(Math.random() * Number.MAX_SAFE_INTEGER)
	function refreshSeed() {
		setSeed(Math.random() * Number.MAX_SAFE_INTEGER)
	}

	let sort: LQY.LayersQueryInput['sort'] = LQY.DEFAULT_SORT
	if (randomize) {
		sort = { type: 'random', seed }
	} else if (sortingState.length > 0) {
		const { id, desc } = sortingState[0]
		sort = {
			type: 'column',
			sortBy: id,
			sortDirection: desc ? 'DESC' : 'ASC',
		}
	}

	const queryInput = LayerQueriesClient.getLayerQueryInput(props.baseInput ?? {}, {
		cfg,
		pageIndex,
		selectedLayers: showSelectedLayers ? props.selected : undefined,
		pageSize,
		sort,
	})
	// const prevQueryInput = React.useRef(queryInput)
	// if (!deepEqual(prevQueryInput.current, queryInput)) {
	// 	debugger
	// 	prevQueryInput.current = queryInput
	// }
	const layersRes = LayerQueriesClient.useLayersQuery(queryInput, { errorStore: props.errorStore })

	const page = React.useMemo(() => {
		let _page = layersRes.data
		if (showSelectedLayers && _page) {
			_page = { ..._page, layers: [..._page.layers] }
			const returnedIds = new Set(_page.layers.map(layer => layer.id))
			for (
				const selectedId of props.selected.slice(
					pageIndex * pageSize,
					// no need to bounds-check slice in js
					(pageIndex * pageSize) + pageSize,
				)
			) {
				if (returnedIds.has(selectedId)) continue
				const unvalidated = L.toLayer(selectedId)
				if (L.isKnownLayer(unvalidated)) {
					// @ts-expect-error idc
					_page.layers.push(unvalidated)
				} else {
					// @ts-expect-error idc
					_page.layers.push({ ...(unvalidated.partialLayer ?? {}), id: unvalidated.id })
				}
			}
			;(_page.layers as Record<string, any>[]).sort((a: any, b: any) => {
				if (sort && sort.type === 'random') {
					// For random sort just shuffle the entries
					return Math.random() - 0.5
				} else if (sort && sort.type === 'column') {
					const column = sort.sortBy
					const direction = sort.sortDirection === 'ASC' ? 1 : -1

					if (a[column] === b[column]) return 0
					if (a[column] === null || a[column] === undefined) return direction
					if (b[column] === null || b[column] === undefined) return -direction

					return a[column] < b[column] ? -direction : direction
				}
				// Default sort by insertion time if no sort specified
				return (insertionTimes.current[a.id] ?? now) - (insertionTimes.current[b.id] ?? now)
			})
		}
		return _page
			? {
				..._page,
				layers: _page.layers.map((layer): RowData => ({
					...layer,
					constraints: { values: layer.constraints, violationDescriptors: layer.violationDescriptors },
				})),
			}
			: undefined
	}, [layersRes.data, showSelectedLayers, props.selected, pageIndex, pageSize, sort, now])

	React.useLayoutEffect(() => {
		if (props.editingSingleValue && page?.layers.length === 1 && page.totalCount === 1) {
			const layer = page.layers[0]
			if (!props.selected.includes(layer.id)) {
				props.setSelected([layer.id])
			}
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [page, props.editingSingleValue])

	const teamParity = ReactRxHelpers.useStateObservableSelection(
		QD.layerItemsState$,
		React.useCallback((state) => {
			return props.baseInput ? LQY.resolveTeamParityForCursor(state, props.baseInput) : undefined
		}, [props.baseInput]),
	)
	const displayTeamsNormalized = Zus.useStore(GlobalSettings.GlobalSettingsStore, (state) => state.displayTeamsNormalized)

	const table = useReactTable({
		data: page?.layers ?? [],
		columns: React.useMemo(
			() => cfg ? buildColDefs(cfg, teamParity ?? 0, displayTeamsNormalized, props.baseInput?.constraints) : [],
			[
				cfg,
				teamParity,
				displayTeamsNormalized,
				props.baseInput?.constraints,
			],
		),
		pageCount: page?.pageCount ?? -1,
		state: {
			sorting: sortingState,
			columnVisibility,
			rowSelection,
			pagination: {
				pageIndex: pageIndex,
				pageSize,
			},
		},
		getRowId: (row) => row.id,
		onSortingChange: setSorting,
		onColumnVisibilityChange: setColumnVisibility as React.Dispatch<React.SetStateAction<VisibilityState>>,
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
		if (!props.selected.includes(row.original.id)) {
			return [row.original]
		} else {
			return table
				.getRowModel()
				.rows.filter((r) => rowSelection[r.id])
				.map((r) => r.original)
		}
	}

	function onCopyIdCommand(row: Row<L.KnownLayer>) {
		const chosenRows = getChosenRows(row)
		let text = ''
		for (const row of chosenRows) {
			if (text !== '') text += '\n'
			text += row.id
		}
		navigator.clipboard.writeText(text)
		toast({ description: 'Layer ID copied to clipboard' })
	}

	function onCopySetNextLayerCommand(row: Row<L.KnownLayer>) {
		const chosenRows = getChosenRows(row)
		let text = ''
		for (const row of chosenRows) {
			if (text !== '') text += '\n'
			text += L.getAdminSetNextLayerCommand(row)
		}
		navigator.clipboard.writeText(text)
		toast({ description: 'Command copied to clipboard' })
	}
	const toggleRandomizeId = React.useId()

	return (
		<div className="space-y-2">
			<div className="flex items-center justify-between">
				<span className="flex h-10 items-center space-x-2">
					{/*--------- toggle columns ---------*/}
					{canToggleColumns && (
						<DropdownMenu>
							<DropdownMenuTrigger asChild>
								<Button variant="outline">Toggle Columns</Button>
							</DropdownMenuTrigger>
							<DropdownMenuContent className="w-56 h-[500px] min-h-0 overflow-y-scroll">
								{table.getAllLeafColumns().map((column) => {
									return (
										<DropdownMenuCheckboxItem
											key={column.id}
											className="capitalize"
											checked={column.getIsVisible()}
											onCheckedChange={(value) => {
												column.toggleVisibility(!!value)
											}}
											onSelect={(e) => {
												e.preventDefault()
											}}
										>
											{column.id}
										</DropdownMenuCheckboxItem>
									)
								})}
							</DropdownMenuContent>
						</DropdownMenu>
					)}
					<Separator orientation="vertical" className="h-full min-h-0" />

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

					{/*--------- show selected ---------*/}
					<div className="flex items-center space-x-1">
						<Switch
							checked={showSelectedLayers}
							disabled={props.selected.length === 0}
							onCheckedChange={() => props.selected.length > 0 && setShowSelectedLayers((show) => !show)}
							id="toggle-show-selected"
						/>
						<Label htmlFor="toggle-show-selected">Show Selected</Label>
					</div>
					{props.selected.length > 0 && (
						<>
							<Button
								variant="outline"
								onClick={() => {
									if (props.resetSelected) props.resetSelected()
									else props.setSelected([])

									setShowSelectedLayers(false)
								}}
							>
								Reset
							</Button>
							{!props.editingSingleValue && (
								<p className="whitespace-nowrap">
									{props.selected.length} layers selected
								</p>
							)}
						</>
					)}
				</span>
				<span className="flex h-10 items-center space-x-2">
					{props.extraPanelItems}
					<Button
						onClick={() => refreshSeed()}
						disabled={layersRes.isFetching}
						variant="outline"
						size="icon"
						data-enabled={randomize}
						className="data-[enabled=true]:visible invisible"
					>
						<Dices />
					</Button>
					<div className="flex items-center space-x-1">
						<Switch disabled={showSelectedLayers} checked={randomize} onCheckedChange={() => toggleRandomize()} id={toggleRandomizeId} />
						<Label htmlFor={toggleRandomizeId}>Randomize</Label>
					</div>
					<Separator orientation="vertical" />

					{/*--------- rows per page ---------*/}
					{canChangeRowsPerPage && (
						<div className="flex items-center space-x-2">
							<p className="text-sm font-medium">Rows per page</p>
							<Select
								value={`${table.getState().pagination.pageSize}`}
								onValueChange={(value) => {
									table.setPageSize(Number(value))
								}}
							>
								<SelectTrigger className="h-8 w-[70px]">
									<SelectValue placeholder={table.getState().pagination.pageSize} />
								</SelectTrigger>
								<SelectContent side="top">
									{[10, 20, 30, 40, 50].map((pageSize) => (
										<SelectItem key={pageSize} value={`${pageSize}`}>
											{pageSize}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
					)}
				</span>
			</div>
			<div>
				<SetRawLayerDialog
					ref={rawSetDialogRef}
					singleOnly={props.editingSingleValue}
					open={rawSetDialogOpen}
					setOpen={setRawSetDialogOpen}
					defaultValue={props.editingSingleValue && props.selected.length === 1
						? L.getAdminSetNextLayerCommand(props.selected[0])
						: undefined}
					onSubmit={layers => {
						if (props.editingSingleValue) {
							props.setSelected(layers.slice(layers.length - 1).map(layer => layer.id))
						} else {
							props.setSelected(selected => [...selected, ...layers.map(layer => layer.id)])
						}
						setShowSelectedLayers(true)
					}}
				/>
			</div>
			<div className="rounded-md border">
				{/*--------- table ---------*/}
				<Table>
					<TableHeader>
						{table.getHeaderGroups().map((headerGroup) => (
							<TableRow key={headerGroup.id}>
								{headerGroup.headers.map((header) => (
									<TableHead className="px-0" key={header.id}>
										{header.isPlaceholder ? null : flexRender(header.column.columnDef.header, header.getContext())}
									</TableHead>
								))}
							</TableRow>
						))}
					</TableHeader>
					<TableBody>
						{table.getRowModel().rows.map((row) => {
							const id = row.original.id
							const disabled = 'hover:bg-unset bg-gray-800'
							return (
								<ContextMenu key={row.id}>
									<ContextMenuTrigger asChild>
										<TableRow
											key={row.id}
											className={getIsRowDisabled(row, userCanForceSelect, props.baseInput?.constraints ?? []) ? disabled : ''}
											onClick={() => {
												if (getIsRowDisabled(row, userCanForceSelect, props.baseInput?.constraints ?? [])) return
												onSetRowSelection(
													Im.produce(rowSelection, (draft) => {
														draft[id] = !draft[id]
													}),
												)
											}}
										>
											{row.getVisibleCells().map((cell) => (
												<TableCell className="pl-4" key={cell.id}>
													{flexRender(cell.column.columnDef.cell, cell.getContext())}
												</TableCell>
											))}
										</TableRow>
									</ContextMenuTrigger>
									<ContextMenuContent>
										<ContextMenuItem onClick={() => onCopySetNextLayerCommand(row)}>
											Copy AdminSetNextLayer {props.selected.includes(row.original.id) && 'for selected'}
										</ContextMenuItem>
										<ContextMenuItem onClick={() => onCopyIdCommand(row)}>
											Copy ID {props.selected.includes(row.original.id) && 'for selected'}
										</ContextMenuItem>
									</ContextMenuContent>
								</ContextMenu>
							)
						})}
					</TableBody>
				</Table>
			</div>
			{/*--------- pagination controls ---------*/}
			<div className="flex items-center justify-between space-x-2 py-2">
				<div className="flex-1  flex items-center space-x-2">
					<div className="text-sm text-muted-foreground">
						{page
							&& (showSelectedLayers
								? `Showing ${firstRowInPage} to ${lastRowInPage} of ${page?.totalCount} selected rows`
								: randomize
								? `Showing ${page?.layers?.length} of ${page?.totalCount} randomized rows`
								: `Showing ${firstRowInPage} to ${lastRowInPage} of ${page?.totalCount} matching rows`)}
					</div>
					<div data-loading={layersRes.isFetching} className="flex items-center space-x-2 invisible data-[loading=true]:visible ">
						<LoaderCircle className="h-4 w-4 animate-spin" />
						{fetchingBuffer && <p className={Typo.Muted}>Downloading layers from server, this may take a few minutes...</p>}
					</div>
				</div>
				<div className={'space-x-2 ' + (randomize ? 'invisible' : '')}>
					<Button variant="outline" size="sm" onClick={() => table.previousPage()} disabled={!table.getCanPreviousPage() || randomize}>
						Previous
					</Button>
					<Button variant="outline" size="sm" onClick={() => table.nextPage()} disabled={!table.getCanNextPage() || randomize}>
						Next
					</Button>
				</div>
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
	singleOnly?: boolean
	defaultValue?: string
	onSubmit: (layer: L.UnvalidatedLayer[]) => void
	ref?: React.ForwardedRef<SetRawDialogHandle>
}) {
	const inputRef = React.useRef<HTMLInputElement>(null)
	const [validLayer, setValidLayer] = React.useState<L.UnvalidatedLayer | null>(null)
	const [validLayerDebounced, setValidLayerDebounced] = React.useState<L.UnvalidatedLayer | null>(null)
	const [multiSetLayerDialogOpen, setMultiSetLayerDialogOpen] = React.useState<boolean>(false)
	const [layerFound, setLayerFound] = React.useState<boolean>(false)
	const validLayerDebouncer = useDebounced({
		defaultValue: () => null as null | L.UnvalidatedLayer,
		onChange: (v) => setValidLayerDebounced(v),
		delay: 400,
	})
	const layerIds = validLayerDebounced ? [validLayerDebounced.id] : []
	const layersKnownRes = LayerQueriesClient.useLayerExists(layerIds, { enabled: !!validLayerDebounced })

	const setInputText = React.useCallback((value: string) => {
		value = value.trim()
		const layerRes = L.parseRawLayerText(value)
		validLayerDebouncer.setValue(layerRes)
		setValidLayer(layerRes)
	}, [validLayerDebouncer])

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
			console.log(layersKnownRes.data.results)
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
								data-singleOnly={props.singleOnly}
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
						if (!props.singleOnly) inputRef.current!.value = ''
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
function getIsLayerDisabled(layerData: RowData, canForceSelect: boolean, constraints: LQY.LayerQueryConstraint[]) {
	return !canForceSelect && layerData.constraints.values?.some((v, i) => !v && constraints[i].type !== 'do-not-repeat')
}

function getIsRowDisabled(row: Row<RowData>, canForceSelect: boolean, constraints: LQY.LayerQueryConstraint[]) {
	return !row.getIsSelected() && getIsLayerDisabled(row.original, canForceSelect, constraints)
}
