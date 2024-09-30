import { Button } from '@/components/ui/button'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@/components/ui/context-menu'
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { useToast } from '@/hooks/use-toast'
import { trpc } from '@/lib/trpc'
import * as M from '@/models'
import { LayersQuery } from '@/server/layers-query'
import {
	ColumnDef,
	OnChangeFn,
	PaginationState,
	Row,
	RowSelectionState,
	SortingState,
	VisibilityState,
	createColumnHelper,
	flexRender,
	getCoreRowModel,
	getSortedRowModel,
	useReactTable,
} from '@tanstack/react-table'
import { ArrowUpDown, Dice1, Dice2, Dice2Icon, Dice4, Dices } from 'lucide-react'
import { useLayoutEffect, useRef, useState } from 'react'

import { Checkbox } from './ui/checkbox'
import { Label } from './ui/label'
import { Separator } from './ui/separator'
import { Switch } from './ui/switch'

const columnHelper = createColumnHelper<M.Layer>()

const formatNumber = (value: number | null | undefined) => {
	if (value == null) return '<missing>'
	const formatted = value.toFixed(2)
	const numeric = parseFloat(formatted)
	if (numeric > 0) return `+${formatted}`
	return formatted
}

function getColumn(key: M.LayerColumnKey) {
	return columnHelper.accessor(key, {
		header: ({ column }) => {
			return (
				<Button variant="ghost" onClick={() => column.toggleSorting(column.getIsSorted() === 'asc')}>
					{column.id}
					<ArrowUpDown className="ml-2 h-4 w-4" />
				</Button>
			)
		},
		cell: (info) => (M.COLUMN_KEY_TO_TYPE[key] === 'float' ? formatNumber(info.getValue() as number) : info.getValue() || '<missing>'),
	})
}

const columns: ColumnDef<M.Layer, any>[] = [
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
	getColumn('Id'),
	getColumn('Level'),
	getColumn('Layer'),
	getColumn('Size'),
	getColumn('Gamemode'),
	getColumn('LayerVersion'),
	getColumn('Faction_1'),
	getColumn('SubFac_1'),
	getColumn('Faction_2'),
	getColumn('SubFac_2'),
	getColumn('Logistics_Diff'),
	getColumn('Transportation_Diff'),
	getColumn('Anti-Infantry_Diff'),
	getColumn('Armor_Diff'),
	getColumn('ZERO_Score_Diff'),
	getColumn('Balance_Differential'),
	getColumn('Asymmetry Score'),
]

const DEFAULT_VISIBLE_COLUMNS = [
	'Layer',
	'Faction_1',
	'SubFac_1',
	'Faction_2',
	'SubFac_2',
	'Anti-Infantry_1',
	'Anti-Infantry_Diff',
	'Armor_Diff',
	'Balance_Differential',
	'Asymmetry Score',
] as M.LayerColumnKey[]

const DEFAULT_VISIBILITY_STATE = Object.fromEntries(M.COLUMN_KEYS.map((key) => [key, DEFAULT_VISIBLE_COLUMNS.includes(key)]))

export default function LayerTable(props: { filter: M.FilterNode | null; pageIndex: number; setPageIndex: (value: number) => void }) {
	let { filter } = props
	const [sorting, setSorting] = useState<SortingState>([])
	const [randomize, setRandomize] = useState<boolean>()
	const [seed, setSeed] = useState<string>()
	function generateSeed() {
		const values = crypto.getRandomValues(new Uint8Array(16))
		// convert to base64
		const base64 = btoa(String.fromCharCode(...values))
		setSeed(base64)
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
	const [showSelectedLayers, setShowSelectedLayers] = useState(false)
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
		if (typeof updater === 'function') {
			const { pageIndex, pageSize: newPageSize } = updater({ pageIndex: props.pageIndex, pageSize })
			props.setPageIndex(pageIndex)
			setPageSize(newPageSize)
		} else {
			const { pageIndex, pageSize } = updater
			props.setPageIndex(pageIndex)
			setPageSize(pageSize)
		}
	}

	if (showSelectedLayers) {
		filter = { type: 'comp', comp: { code: 'in', column: 'Id', values: selectedLayerIds } }
	}
	let sort: LayersQuery['sort'] = undefined
	if (randomize) {
		sort = { type: 'random', seed: seed! }
	} else if (sorting.length > 0) {
		const { id, desc } = sorting[0]
		sort = { type: 'column', sortBy: id as M.LayerColumnKey, sortDirection: desc ? 'DESC' : 'ASC' }
	}

	const { data: dataRaw } = trpc.getLayers.useQuery({
		pageIndex: props.pageIndex,
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
		data: data?.layers ?? ([] as M.Layer[]),
		columns,
		pageCount: data?.pageCount ?? -1,
		state: {
			sorting,
			columnVisibility,
			rowSelection,
			pagination: {
				pageIndex: props.pageIndex,
				pageSize,
			},
		},
		getRowId: (row) => row.Id,
		onSortingChange: setSorting,
		onColumnVisibilityChange: setColumnVisibility,
		onRowSelectionChange: onSetRowSelection,
		onPaginationChange,
		getCoreRowModel: getCoreRowModel(),
		getSortedRowModel: getSortedRowModel(),
		manualPagination: true,
	})
	const firstRowInPage = props.pageIndex * pageSize + 1
	const lastRowInPage = Math.min(firstRowInPage + pageSize - 1, data?.totalCount ?? 0)
	const { toast } = useToast()

	function getChosenRows(row: Row<M.Layer>) {
		if (Object.values(rowSelection).every((isSelected) => !isSelected)) {
			return [row.original]
		} else {
			return table
				.getRowModel()
				.rows.filter((r) => rowSelection[r.id])
				.map((r) => r.original)
		}
	}

	function onCopyLayerCommand(row: Row<M.Layer>) {
		const chosenRows = getChosenRows(row)
		let text = ''
		for (const row of chosenRows) {
			if (text !== '') text += '\n'
			text += M.getAdminSetNextLayerCommand(row)
		}
		navigator.clipboard.writeText(text)
		toast({ description: 'Command copied to clipboard' })
	}

	function onCopyVoteCommand(row: Row<M.Layer>) {
		const chosenRows = getChosenRows(row)
		const commandText = M.getSetNextVoteCommand(chosenRows.map((row) => row.Id))
		navigator.clipboard.writeText(commandText)
		toast({ description: 'Command copied to clipboard' })
	}

	return (
		<div>
			<div className="flex justify-between items-center mb-4">
				<span className="flex items-center space-x-2 h-10">
					{/*--------- toggle columns ---------*/}
					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<Button variant="outline">Toggle Columns</Button>
						</DropdownMenuTrigger>
						<DropdownMenuContent className="w-56">
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
				<span className="flex items-center space-x-2 h-10">
					<div className="flex items-center space-x-1">
						<Switch
							checked={showSelectedLayers}
							disabled={selectedLayerIds.length === 0}
							onCheckedChange={() => selectedLayerIds.length > 0 && setShowSelectedLayers((show) => !show)}
							id="toggle-show-selected"
						/>
						<Label htmlFor="toggle-show-selected">Show Selected</Label>
					</div>
					<div className="flex items-center space-x-1">
						<Switch checked={randomize} onCheckedChange={() => toggleRandomize()} id="toggle-randomize" />
						<Label htmlFor="toggle-randomize">Randomize</Label>
					</div>
					<Button variant="outline" size="icon" className={randomize ? '' : 'invisible'}>
						<Dices />
					</Button>

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
									<ContextMenuItem onClick={() => onCopyLayerCommand(row)}>
										Copy set next layer command {selectedLayerIds.length > 0 && 'for selected'}
									</ContextMenuItem>
									<ContextMenuItem onClick={() => onCopyVoteCommand(row)}>
										Copy generate vote command {selectedLayerIds.length > 0 && 'for selected'}
									</ContextMenuItem>
								</ContextMenuContent>
							</ContextMenu>
						))}
					</TableBody>
				</Table>
			</div>
			{/*--------- pagination controls ---------*/}
			<div className="flex items-center justify-between space-x-2 py-4">
				<div className="flex-1 text-sm text-muted-foreground">
					Showing {firstRowInPage} to {lastRowInPage} of {data?.totalCount} rows
				</div>
				<div className="space-x-2">
					<Button variant="outline" size="sm" onClick={() => table.previousPage()} disabled={!table.getCanPreviousPage()}>
						Previous
					</Button>
					<Button variant="outline" size="sm" onClick={() => table.nextPage()} disabled={!table.getCanNextPage()}>
						Next
					</Button>
				</div>
			</div>
		</div>
	)
}
