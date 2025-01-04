import {
	ColumnDef,
	createColumnHelper,
	flexRender,
	getCoreRowModel,
	getSortedRowModel,
	OnChangeFn,
	PaginationState,
	Row,
	RowSelectionState,
	SortingState,
	useReactTable,
	VisibilityState,
} from '@tanstack/react-table'
import { ArrowUpDown, Dices } from 'lucide-react'
import { useLayoutEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@/components/ui/context-menu'
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import * as FB from '@/lib/filter-builders'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { useToast } from '@/hooks/use-toast'
import * as DH from '@/lib/display-helpers'
import * as M from '@/models'
import { LayersQueryInput } from '@/server/systems/layers-query.ts'

import { Checkbox } from './ui/checkbox'
import { Label } from './ui/label'
import { Separator } from './ui/separator'
import { Switch } from './ui/switch'
import { assertNever } from '@/lib/typeGuards'
import { useLayersQuery } from '@/hooks/use-layer-queries.ts'
import React from 'react'

const columnHelper = createColumnHelper<M.Layer & M.LayerComposite>()

const formatFloat = (value: number) => {
	const formatted = value.toFixed(2)
	const numeric = parseFloat(formatted)
	if (numeric > 0) return `+${formatted}`
	return formatted
}

function buildColumn(key: M.LayerColumnKey | M.LayerCompositeKey) {
	return columnHelper.accessor(key, {
		header: ({ column }) => {
			return (
				<Button variant="ghost" onClick={() => column.toggleSorting(column.getIsSorted() === 'asc')}>
					{column.id}
					<ArrowUpDown className="ml-2 h-4 w-4" />
				</Button>
			)
		},
		cell: (info) => {
			const value = info.getValue()
			if (value === null) return DH.NULL_DISPLAY
			const type = M.COLUMN_KEY_TO_TYPE[key]

			switch (type) {
				case 'float':
					return formatFloat(value as number)
				case 'string':
					return value
				case 'collection':
					return (value as string[]).filter((v) => !!v).join(', ')
				case 'integer':
					return value.toString()
				case 'boolean':
					return value ? 'True' : 'False'
				default:
					assertNever(type)
			}
		},
	})
}

const columns: ColumnDef<M.Layer & M.LayerComposite, any>[] = [
	{
		id: 'select',
		header: ({ table }) => (
			<Checkbox
				checked={table.getIsAllPageRowsSelected() || (table.getIsSomePageRowsSelected() && 'indeterminate')}
				onCheckedChange={(value) => table.toggleAllPageRowsSelected(!!value)}
				aria-label="Select all"
			/>
		),
		cell: ({ row }) => (
			<Checkbox checked={row.getIsSelected()} onCheckedChange={(value) => row.toggleSelected(!!value)} aria-label="Select row" />
		),
		enableSorting: false,
		enableHiding: false,
	},
]

for (const columnKey of M.COLUMN_KEYS_WITH_COMPUTED) {
	columns.push(buildColumn(columnKey))
}

const DEFAULT_VISIBLE_COLUMNS = ['Layer', 'Faction_1', 'SubFac_1', 'Faction_2', 'SubFac_2', 'Balance_Differential', 'Asymmetry_Score'] as (
	| M.LayerColumnKey
	| M.LayerCompositeKey
)[]

const DEFAULT_VISIBILITY_STATE = Object.fromEntries(M.COLUMN_KEYS_WITH_COMPUTED.map((key) => [key, DEFAULT_VISIBLE_COLUMNS.includes(key)]))
const DEFAULT_SORT: LayersQueryInput['sort'] = {
	type: 'column',
	sortBy: 'Asymmetry_Score',
	sortDirection: 'ASC',
}

export default function LayerTable(props: { filter?: M.FilterNode; pageIndex: number; setPageIndex: (num: number) => void }) {
	const { pageIndex, setPageIndex } = props
	let filter = props.filter
	const [sortingState, _setSortingState] = useState<SortingState>([])
	const setSorting: React.Dispatch<React.SetStateAction<SortingState>> = (sortingUpdate) => {
		_setSortingState((sortingState) => {
			if (typeof sortingUpdate === 'function') {
				return sortingUpdate(sortingState)
			} else return sortingState
		})
		setRandomize(false)
		setPageIndex(0)
	}
	const [randomize, setRandomize] = useState<boolean>()
	const [seed, setSeed] = useState<number>()
	function generateSeed() {
		const seed = Math.ceil(Math.random() * Number.MAX_SAFE_INTEGER)
		setSeed(seed)
	}

	function toggleRandomize() {
		setRandomize((prev) => {
			if (!prev) {
				generateSeed()
			}
			return !prev
		})
	}

	const [columnVisibility, setColumnVisibility] = useState<VisibilityState>(DEFAULT_VISIBILITY_STATE)
	const [showSelectedLayers, _setShowSelectedLayers] = useState(false)
	const setShowSelectedLayers: React.Dispatch<React.SetStateAction<boolean>> = (value) => {
		_setShowSelectedLayers(value)
		setPageIndex(0)
	}
	const [selectedLayerIds, setSelectedLayerIds] = useState<string[]>([])

	const rowSelection: RowSelectionState = Object.fromEntries(selectedLayerIds.map((id) => [id, true]))
	const onSetRowSelection: OnChangeFn<RowSelectionState> = (updated) => {
		setSelectedLayerIds((selectedIds) => {
			let newValues: RowSelectionState
			if (typeof updated === 'function') {
				newValues = updated(Object.fromEntries(selectedIds.map((key) => [key, true])))
			} else {
				newValues = updated
			}
			const newSelectedIds = Object.keys(newValues).filter((key) => newValues[key])
			if (newSelectedIds.length === 0) {
				setShowSelectedLayers(false)
			}
			return newSelectedIds
		})
	}

	const [pageSize, setPageSize] = useState(10)
	const onPaginationChange: OnChangeFn<PaginationState> = (updater) => {
		let newState: PaginationState
		if (typeof updater === 'function') {
			newState = updater({ pageIndex, pageSize })
		} else {
			newState = updater
		}
		setPageIndex(newState.pageIndex)
		setPageSize(newState.pageSize)
	}

	if (showSelectedLayers) {
		filter = FB.comp(FB.inValues('id', selectedLayerIds))
	}

	let sort: LayersQueryInput['sort'] = DEFAULT_SORT
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

	const { data: dataRaw } = useLayersQuery({
		pageIndex,
		pageSize,
		sort,
		filter: filter ?? undefined,
	})

	// for some reason I can't use usePreviousData via trpc
	const lastDataRef = useRef(dataRaw)
	useLayoutEffect(() => {
		if (dataRaw) {
			lastDataRef.current = dataRaw
		}
	}, [dataRaw])
	const data = dataRaw ?? lastDataRef.current

	const table = useReactTable({
		data: data?.layers ?? ([] as (M.Layer & M.LayerComposite)[]),
		columns,
		pageCount: data?.pageCount ?? -1,
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
		onColumnVisibilityChange: setColumnVisibility,
		onRowSelectionChange: onSetRowSelection,
		onPaginationChange,
		getCoreRowModel: getCoreRowModel(),
		getSortedRowModel: getSortedRowModel(),
		manualPagination: true,
	})
	const currentPage = Math.min(pageIndex, data?.pageCount ?? 0)
	const firstRowInPage = currentPage * (data?.layers.length ?? 0) + 1
	const lastRowInPage = Math.min(firstRowInPage + pageSize - 1, data?.totalCount ?? 0)
	const { toast } = useToast()

	function getChosenRows(row: Row<M.Layer>) {
		if (!selectedLayerIds.includes(row.original.id)) {
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
		<div className="pt-2">
			<div className="mb-2 flex items-center justify-between">
				<span className="flex h-10 items-center space-x-2">
					{/*--------- toggle columns ---------*/}
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
					<Separator orientation="vertical" className="h-full min-h-0" />
					{/*--------- show selected ---------*/}
					<div className="flex items-center space-x-1">
						<Switch
							checked={showSelectedLayers}
							disabled={selectedLayerIds.length === 0}
							onCheckedChange={() => selectedLayerIds.length > 0 && setShowSelectedLayers((show) => !show)}
							id="toggle-show-selected"
						/>
						<Label htmlFor="toggle-show-selected">Show Selected</Label>
					</div>
					{selectedLayerIds.length > 0 && (
						<>
							<Button
								variant="outline"
								onClick={() => {
									setSelectedLayerIds([])
								}}
							>
								Reset
							</Button>
							<p>{selectedLayerIds.length} layers selected</p>
						</>
					)}
				</span>
				<span className="flex h-10 items-center space-x-2">
					<Button onClick={generateSeed} variant="outline" size="icon" className={randomize ? '' : 'invisible'}>
						<Dices />
					</Button>
					<div className="flex items-center space-x-1">
						<Switch checked={randomize} onCheckedChange={() => toggleRandomize()} id="toggle-randomize" />
						<Label htmlFor="toggle-randomize">Randomize</Label>
					</div>
					<Separator orientation="vertical" />

					{/*--------- rows per page ---------*/}
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
				</span>
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
						{table.getRowModel().rows.map((row) => (
							<ContextMenu key={row.id}>
								<ContextMenuTrigger asChild>
									<TableRow key={row.id}>
										{row.getVisibleCells().map((cell) => (
											<TableCell key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</TableCell>
										))}
									</TableRow>
								</ContextMenuTrigger>
								<ContextMenuContent>
									<ContextMenuItem onClick={() => onCopySetNextLayerCommand(row)}>
										Copy AdminSetNextLayer {selectedLayerIds.includes(row.original.id) && 'for selected'}
									</ContextMenuItem>
									<ContextMenuItem onClick={() => onCopyIdCommand(row)}>
										Copy ID {selectedLayerIds.includes(row.original.id) && 'for selected'}
									</ContextMenuItem>
								</ContextMenuContent>
							</ContextMenu>
						))}
					</TableBody>
				</Table>
			</div>
			{/*--------- pagination controls ---------*/}
			<div className="flex items-center justify-between space-x-2 py-2">
				<div className="flex-1 text-sm text-muted-foreground">
					{showSelectedLayers
						? `Showing ${firstRowInPage} to ${lastRowInPage} of ${data?.totalCount} selected rows`
						: randomize
							? `Showing ${data?.layers?.length} of ${data?.totalCount} randomized rows`
							: `Showing ${firstRowInPage} to ${lastRowInPage} of ${data?.totalCount} matching rows`}
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
