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
import { useRefConstructor } from '@/lib/react'
import { assertNever } from '@/lib/typeGuards'
import * as M from '@/models'
import * as RBAC from '@/rbac.models'
import * as LayerQueriesClient from '@/systems.client/layer-queries.client'
import { useLoggedInUser } from '@/systems.client/users.client'
import { ColumnDef, createColumnHelper, flexRender, getCoreRowModel, getSortedRowModel, OnChangeFn, PaginationState, Row, RowSelectionState, SortingState, useReactTable, VisibilityState } from '@tanstack/react-table'
import * as Im from 'immer'
import * as Icons from 'lucide-react'
import { ArrowDown, ArrowUp, ArrowUpDown, Dices, LoaderCircle } from 'lucide-react'
import { useRef, useState } from 'react'
import React from 'react'
import { flushSync } from 'react-dom'
import { ConstraintViolationDisplay } from './constraint-violation-display'
import { Checkbox } from './ui/checkbox'
import { Input } from './ui/input'
import { Label } from './ui/label'
import { Separator } from './ui/separator'
import { Switch } from './ui/switch'
import { Textarea } from './ui/textarea'

type ConstraintRowDetails = {
	constraints: M.LayerQueryConstraint[]
	values: boolean[]
}
type RowData = M.Layer & M.LayerComposite & { 'constraints': ConstraintRowDetails }
const columnHelper = createColumnHelper<RowData>()

const formatFloat = (value: number) => {
	const formatted = value.toFixed(2)
	const numeric = parseFloat(formatted)
	if (numeric > 0) return `+${formatted}`
	return formatted
}
const noSortCols = ['Layer', 'Map', 'Gamemode', 'LayerVersion', 'Faction1', 'SubFaction1', 'Faction2', 'SubFaction2']
function buildColumn(key: M.LayerColumnKey | M.LayerCompositeKey) {
	return columnHelper.accessor(key, {
		header: ({ column }) => {
			// @ts-expect-error idc
			const label = M.COLUMN_LABELS[column.id] ?? column.id
			const sort = column.getIsSorted()
			return (
				<Button
					className="data-[sort=true]:text-accent-foreground"
					data-sort={!!sort}
					variant="ghost"
					onClick={() => column.toggleSorting(column.getIsSorted() === 'asc')}
				>
					{label}
					{!noSortCols.includes(column.id) && (
						<>
							{!sort && <ArrowUpDown className="ml-2 h-4 w-4" />}
							{sort === 'asc' && <ArrowUp className="ml-2 h-4 w-4" />}
							{sort === 'desc' && <ArrowDown className="ml-2 h-4 w-4" />}
						</>
					)}
				</Button>
			)
		},
		cell: (info) => {
			const value = info.getValue()
			if (value === null) return DH.NULL_DISPLAY
			const type = M.COLUMN_KEY_TO_TYPE[key]

			switch (type) {
				case 'float':
					if (value === null || value === undefined) return '-'
					return formatFloat(value as number)
				case 'string':
					return value ?? '-'
				case 'collection':
					if (!Array.isArray(value)) return '-'
					return (value as string[]).filter((v) => !!v).join(', ')
				case 'integer':
					return value?.toString() ?? '-'
				case 'boolean':
					if (value === null || value === undefined) return '-'
					return value ? 'True' : 'False'
				default:
					assertNever(type)
			}
		},
	})
}

function Cell({ row }: { row: Row<RowData> }) {
	const loggedInUser = useLoggedInUser()
	const canForceWrite = !!loggedInUser && RBAC.rbacUserHasPerms(loggedInUser, RBAC.perm('queue:force-write'))

	return (
		<Checkbox
			checked={row.getIsSelected()}
			className={getIsRowDisabled(row, canForceWrite) ? 'invisible' : ''}
			aria-label="Select row"
		/>
	)
}

const COL_DEFS: ColumnDef<RowData>[] = [
	{
		id: 'select',
		header: ({ table }) => (
			<Checkbox
				checked={table.getIsAllPageRowsSelected() || (table.getIsSomePageRowsSelected() && 'indeterminate')}
				onCheckedChange={(value) => table.toggleAllPageRowsSelected(!!value)}
				aria-label="Select all"
			/>
		),
		cell: ({ row }) => <Cell row={row} />,
		enableSorting: false,
		enableHiding: false,
	},
]

const COLS_ORDER = [
	'id',
	'Layer',
	'Map',
	'Gamemode',
	'LayerVersion',
	'Faction_1',
	'Unit_1',
	'Faction_2',
	'Unit_2',
	'Balance_Differential',
	'Asymmetry_Score',
] as (M.LayerColumnKey | M.LayerCompositeKey)[]

{
	const sortedColKeys = [...M.COLUMN_KEYS_WITH_COMPUTED].sort((a, b) => {
		let aIndex = COLS_ORDER.indexOf(a)
		if (aIndex === -1) aIndex = COLS_ORDER.length
		let bIndex = COLS_ORDER.indexOf(b)
		if (bIndex === -1) bIndex = COLS_ORDER.length
		return aIndex - bIndex
	})

	for (const columnKey of sortedColKeys) {
		// @ts-expect-error idk
		COL_DEFS.push(buildColumn(columnKey))
	}
}

const constraintsCol = columnHelper.accessor('constraints', {
	header: '',
	enableHiding: false,
	cell: info => {
		const { values, constraints, violationDescriptors } = info.getValue() as {
			constraints?: M.LayerQueryConstraint[]
			values?: boolean[]
			violationDescriptors?: Record<string, string[] | undefined>
		}
		if (!constraints || !values) return null
		const nodes: React.ReactNode[] = []
		for (let i = 0; i < constraints.length; i++) {
			if (constraints[i].applyAs === 'where-condition' || values[i]) continue
			nodes.push(
				<div key={constraints[i].name ?? i}>
					{constraints[i].name ?? 'Constraint ' + i}
				</div>,
			)
		}
		const namedConstraints = constraints.filter((c, i) => c.applyAs === 'field' && !values[i]) as M.NamedQueryConstraint[]
		return (
			<ConstraintViolationDisplay
				padEmpty={true}
				violated={namedConstraints}
				layerId={info.row.id}
				violationDescriptors={violationDescriptors}
			/>
		)
	},
})

// @ts-expect-error idk
COL_DEFS.push(constraintsCol)

const DEFAULT_VISIBLE_COLUMNS = ['Layer', 'Faction_1', 'Unit_1', 'Faction_2', 'Unit_2', 'Balance_Differential', 'Asymmetry_Score'] as (
	| M.LayerColumnKey
	| M.LayerCompositeKey
)[]

const DEFAULT_SORT: M.LayersQueryInput['sort'] = {
	type: 'column',
	sortBy: 'Asymmetry_Score',
	sortDirection: 'ASC',
}

export default function LayerTable(props: {
	queryContext?: M.LayerQueryContext

	selected: M.LayerId[]
	setSelected: React.Dispatch<React.SetStateAction<M.LayerId[]>>
	resetSelected?: () => void
	enableForceSelect?: boolean

	pageIndex: number
	setPageIndex: (num: number) => void

	defaultPageSize?: number
	defaultSortBy?: M.LayerColumnKey | M.LayerCompositeKey | 'random'
	defaultSortDirection?: 'ASC' | 'DESC'
	defaultColumns?: (M.LayerColumnKey | M.LayerCompositeKey)[]

	maxSelected?: number

	canChangeRowsPerPage?: boolean
	canToggleColumns?: boolean

	autoSelectIfSingleResult?: boolean

	extraPanelItems?: React.ReactNode
}) {
	const maxSelected = props.maxSelected ?? Infinity
	const canChangeRowsPerPage = props.canChangeRowsPerPage ?? true

	const canToggleColumns = props.canToggleColumns ?? true
	const autoSelectIfSingleResult = props.autoSelectIfSingleResult ?? false

	{
		const setPageIndex = props.setPageIndex
		React.useEffect(() => {
			setPageIndex(0)
		}, [props.queryContext?.constraints, setPageIndex])
	}

	const [showSelectedLayers, _setShowSelectedLayers] = useState(false)
	const setShowSelectedLayers: React.Dispatch<React.SetStateAction<boolean>> = (value) => {
		_setShowSelectedLayers(value)
		props.setPageIndex(0)
		if (sortingState.length > 0) {
			setSorting([])
		}
	}

	let defaultSortingState: SortingState = []
	if (props.defaultSortBy && props.defaultSortBy !== 'random') {
		defaultSortingState = [{
			id: props.defaultSortBy,
			desc: props.defaultSortDirection === 'DESC',
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
	const [_randomize, setRandomize] = useState<boolean>(props.defaultSortBy === 'random')
	const randomize = !showSelectedLayers && _randomize
	const [seed, setSeed] = useState<number>(generateSeed())
	function generateSeed() {
		return Math.ceil(Math.random() * Number.MAX_SAFE_INTEGER)
	}

	function toggleRandomize() {
		setRandomize((prev) => {
			if (!prev) {
				setSeed(generateSeed())
				_setSortingState([])
			}
			return !prev
		})
	}
	const defaultVisibility = useRefConstructor(() => {
		if (!props.defaultColumns) {
			return Object.fromEntries(M.COLUMN_KEYS_WITH_COMPUTED.map((key) => [key, DEFAULT_VISIBLE_COLUMNS.includes(key)]))
		}
		return Object.fromEntries(M.COLUMN_KEYS_WITH_COMPUTED.map((key) => [key, props.defaultColumns!.includes(key)]))
	})

	const [columnVisibility, setColumnVisibility] = useState<VisibilityState>(defaultVisibility.current)

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
	const insertionTimes = useRef<Record<M.LayerId, number | undefined>>(Object.fromEntries(props.selected.map((id) => [id, now])))
	const onSetRowSelection: OnChangeFn<RowSelectionState> = (updated) => {
		props.setSelected((selectedIds) => {
			let newValues: RowSelectionState
			if (typeof updated === 'function') {
				newValues = updated(Object.fromEntries(selectedIds.map((key) => [key, true])))
			} else {
				newValues = updated
			}
			const updatedSelectedIds = Object.keys(newValues).filter((key) => newValues[key])
			if (updatedSelectedIds.length === 0) {
				setShowSelectedLayers(false)
			}
			if (updatedSelectedIds.length > maxSelected) {
				updatedSelectedIds.splice(0, updatedSelectedIds.length - maxSelected)
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
			if (updatedSelectedIds.length > maxSelected) {
				updatedSelectedIds.splice(0, updatedSelectedIds.length - maxSelected)
			}
			return updatedSelectedIds
		})
	}

	const [pageSize, setPageSize] = useState(10)
	const onPaginationChange: OnChangeFn<PaginationState> = (updater) => {
		let newState: PaginationState
		if (typeof updater === 'function') {
			newState = updater({ pageIndex: props.pageIndex, pageSize })
		} else {
			newState = updater
		}
		props.setPageIndex(newState.pageIndex)
		setPageSize(newState.pageSize)
	}

	let sort: M.LayersQueryInput['sort'] = DEFAULT_SORT
	if (randomize) {
		sort = { type: 'random', seed: seed! }
	} else if (sortingState.length > 0) {
		const { id, desc } = sortingState[0]
		sort = {
			type: 'column',
			sortBy: id as (typeof M.COLUMN_KEYS)[number],
			sortDirection: desc ? 'DESC' : 'ASC',
		}
	}

	const layersRes = LayerQueriesClient.useLayersQuery(LayerQueriesClient.getLayerQueryInput(props.queryContext ?? {}, {
		pageIndex: props.pageIndex,
		selectedLayers: showSelectedLayers ? props.selected : undefined,
		pageSize,
		sort,
	}))

	let page = layersRes.data
	if (showSelectedLayers && page) {
		page = { ...page, layers: [...page.layers] }
		const returnedIds = new Set(page.layers.map(layer => layer.id))
		for (
			const selectedId of props.selected.slice(
				props.pageIndex * pageSize,
				// no need to bounds-check slice in js
				(props.pageIndex * pageSize) + pageSize,
			)
		) {
			if (returnedIds.has(selectedId)) continue
			const unvalidated = M.getUnvalidatedLayerFromId(selectedId)
			if (unvalidated.code === 'parsed') {
				// @ts-expect-error idc
				page.layers.push(unvalidated.layer)
			} else {
				// @ts-expect-error idc
				page.layers.push({ ...(unvalidated.partialLayer ?? {}), id: unvalidated.id })
			}
		}
		page.layers.sort((a, b) => {
			if (sort && sort.type === 'column') {
				const column = sort.sortBy
				const direction = sort.sortDirection === 'ASC' ? 1 : -1

				if (a[column] === b[column]) return 0
				if (a[column] === null || a[column] === undefined) return direction
				if (b[column] === null || b[column] === undefined) return -direction

				return a[column] < b[column] ? -direction : direction
			} else if (sort && sort.type === 'random') {
				// For random sort just shuffle the entries
				return Math.random() - 0.5
			}
			// Default sort by insertion time if no sort specified
			return (insertionTimes.current[a.id] ?? now) - (insertionTimes.current[b.id] ?? now)
		})
	}
	React.useLayoutEffect(() => {
		if (autoSelectIfSingleResult && page?.layers.length === 1 && page.totalCount === 1) {
			const layer = page.layers[0]
			if (!props.selected.includes(layer.id)) {
				props.setSelected([layer.id])
			}
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [page, autoSelectIfSingleResult])

	const table = useReactTable({
		data: page?.layers.map((layer): RowData => ({
			...layer,
			constraints: { values: layer.constraints, constraints: props.queryContext?.constraints ?? [] },
		})) ?? [],
		columns: COL_DEFS,
		pageCount: page?.pageCount ?? -1,
		state: {
			sorting: sortingState,
			columnVisibility,
			rowSelection,
			pagination: {
				pageIndex: props.pageIndex,
				pageSize,
			},
		},
		getRowId: (row) => row.id,
		onSortingChange: setSorting,
		onColumnVisibilityChange: setColumnVisibility,
		onRowSelectionChange: onSetRowSelection,
		onPaginationChange,
		getCoreRowModel: getCoreRowModel(),
		getSortedRowModel: getSortedRowModel(),
		manualPagination: true,
	})

	const currentPage = Math.min(props.pageIndex, page?.pageCount ?? 0)
	const firstRowInPage = currentPage * (page?.layers.length ?? 0) + 1
	const lastRowInPage = Math.min(firstRowInPage + pageSize - 1, page?.totalCount ?? 0)

	const loggedInUser = useLoggedInUser()
	const canForceSelect = !!loggedInUser && RBAC.rbacUserHasPerms(loggedInUser, RBAC.perm('queue:force-write'))

	function getChosenRows(row: Row<M.Layer>) {
		if (!props.selected.includes(row.original.id)) {
			return [row.original]
		} else {
			return table
				.getRowModel()
				.rows.filter((r) => rowSelection[r.id])
				.map((r) => r.original)
		}
	}

	function onCopyIdCommand(row: Row<M.Layer>) {
		const chosenRows = getChosenRows(row)
		let text = ''
		for (const row of chosenRows) {
			if (text !== '') text += '\n'
			text += row.id
		}
		navigator.clipboard.writeText(text)
		toast({ description: 'Layer ID copied to clipboard' })
	}

	function onCopySetNextLayerCommand(row: Row<M.Layer>) {
		const chosenRows = getChosenRows(row)
		let text = ''
		for (const row of chosenRows) {
			if (text !== '') text += '\n'
			text += M.getAdminSetNextLayerCommand(row)
		}
		navigator.clipboard.writeText(text)
		toast({ description: 'Command copied to clipboard' })
	}

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
							disabled={!canForceSelect}
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
								}}
							>
								Reset
							</Button>
							<p className="whitespace-nowrap">
								{props.selected.length} {props.maxSelected ? ` / ${props.maxSelected}` : ''} layers selected
							</p>
						</>
					)}
				</span>
				<span className="flex h-10 items-center space-x-2">
					{props.extraPanelItems}
					<Button
						onClick={() => setSeed(generateSeed())}
						disabled={layersRes.isFetching}
						variant="outline"
						size="icon"
						data-enabled={randomize}
						className="data-[enabled=true]:visible invisible"
					>
						<Dices />
					</Button>
					<div className="flex items-center space-x-1">
						<Switch disabled={showSelectedLayers} checked={randomize} onCheckedChange={() => toggleRandomize()} id="toggle-randomize" />
						<Label htmlFor="toggle-randomize">Randomize</Label>
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
					open={rawSetDialogOpen}
					setOpen={setRawSetDialogOpen}
					onSubmit={layers => {
						props.setSelected(Im.produce(selected => {
							for (const layer of layers) {
								if (selected.includes(layer.id)) continue
								if (props.maxSelected && props.selected.length >= props.maxSelected) {
									selected.shift()
								}
								selected.push(layer.id)
							}
						}))
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
									<TableHead key={header.id}>
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
											className={getIsRowDisabled(row, canForceSelect) ? disabled : ''}
											onClick={() => {
												if (getIsRowDisabled(row, canForceSelect)) return
												onSetRowSelection(
													Im.produce(rowSelection, (draft) => {
														draft[id] = !draft[id]
													}),
												)
											}}
										>
											{row.getVisibleCells().map((cell) => (
												<TableCell className="px-4" key={cell.id}>
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
					<LoaderCircle data-loading={layersRes.isFetching} className="invisible data-[loading=true]:visible h-4 w-4 animate-spin" />
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

type SetRawDialogHandle = {
	focus: () => void
}

const SetRawLayerDialog = React.forwardRef<
	SetRawDialogHandle,
	{ open: boolean; setOpen: (update: (value: boolean) => boolean) => void; onSubmit: (layer: M.UnvalidatedMiniLayer[]) => void }
>(function SetRawLayerDialog(props, ref) {
	const inputRef = React.useRef<HTMLInputElement>(null)
	const [validLayer, setValidLayer] = React.useState<M.UnvalidatedMiniLayer | null>(null)
	const [validLayerDebounced, setValidLayerDebounced] = React.useState<M.UnvalidatedMiniLayer | null>(null)
	const [multiSetLayerDialogOpen, setMultiSetLayerDialogOpen] = React.useState<boolean>(false)
	const [layerFound, setLayerFound] = React.useState<boolean>(false)
	const validLayerDebouncer = useDebounced({
		defaultValue: () => null as null | M.UnvalidatedMiniLayer,
		onChange: (v) => setValidLayerDebounced(v),
		delay: 400,
	})
	const layerIds = validLayerDebounced ? [validLayerDebounced.id] : []
	const layersKnownRes = LayerQueriesClient.useLayerExists(layerIds, { enabled: !!validLayerDebounced })

	React.useImperativeHandle(
		ref,
		() => ({
			focus: () => {
				inputRef.current?.focus()
			},
		}),
		[],
	)

	React.useLayoutEffect(() => {
		if (layersKnownRes.data) {
			if (layersKnownRes.data.code !== 'ok') {
				throw new Error('Something went wrong')
			}
			setLayerFound(layersKnownRes.data.results[0].exists)
		}
	}, [layersKnownRes.data])

	function setInputText(value: string) {
		value = value.trim()
		const layerRes = M.parseRawLayerText(value)
		validLayerDebouncer.setValue(layerRes)
		setValidLayer(layerRes)
	}

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
					className="flex-1"
					placeholder="Ex: Narva_RAAS_v1 RGF USMC or a layer id"
					onChange={(e) => setInputText(e.target.value)}
					rightElement={
						<div className="flex space-x-1 items-center">
							<Label title="Layer exists in the database" className={validLayerDebounced && layerFound ? 'visible' : 'invisible'}>
								<Icons.CheckSquare className="text-info" />
							</Label>
							<Button
								variant="ghost"
								className="h-6 w-6"
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
						inputRef.current!.value = ''
						inputRef.current!.focus()
					}}
				>
					<Icons.Plus />
				</Button>
			</div>
		)
	)
})

function MultiLayerSetDialog({
	onSubmit,
	open,
	setOpen,
}: {
	onSubmit: (value: M.UnvalidatedMiniLayer[]) => void
	open: boolean
	setOpen: (open: boolean) => void
}) {
	const [possibleLayers, setPossibleLayers] = useState([] as M.UnvalidatedMiniLayer[])
	function onTextChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
		const text = e.target.value
		const lines = text.trim().split('\n').filter(line => line.trim().length > 0)
		const possibleLayers = lines.map(line => M.parseRawLayerText(line.trim()))
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

function getIsRowDisabled(row: Row<RowData>, canForceSelect: boolean) {
	const constraints = row.original.constraints
	return !row.getIsSelected() && !canForceSelect
		&& constraints.values.some((v, i) => !v && constraints.constraints[i].type !== 'do-not-repeat')
}
