import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { trpc } from '@/lib/trpc'
import * as M from '@/models'
import {
	ColumnDef,
	PaginationState,
	SortingState,
	VisibilityState,
	createColumnHelper,
	flexRender,
	getCoreRowModel,
	getSortedRowModel,
	useReactTable,
} from '@tanstack/react-table'
import { useState } from 'react'

const columnHelper = createColumnHelper<M.Layer>()

const formatNumber = (value: number | null | undefined) => {
	if (value == null) return '<missing>'
	const formatted = value.toFixed(2)
	const numeric = parseFloat(formatted)
	if (numeric > 0) return `+${formatted}`
	return formatted
}

function getColumn(key: M.LayerKey) {
	return columnHelper.accessor(key, {
		header: key,
		cell: (info) => (M.COLUMN_KEY_TO_TYPE[key] === 'numeric' ? formatNumber(info.getValue() as number) : info.getValue() || '<missing>'),
	})
}

const columns: ColumnDef<M.Layer, any>[] = [
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
] as M.LayerKey[]

const DEFAULT_VISIBILITY_STATE = Object.fromEntries(M.COLUMN_KEYS.map((key) => [key, DEFAULT_VISIBLE_COLUMNS.includes(key)]))

export default function LayerTable({ filter }: { filter: M.FilterNode | null }) {
	const [sorting, setSorting] = useState<SortingState>([])
	const [columnVisibility, setColumnVisibility] = useState<VisibilityState>(DEFAULT_VISIBILITY_STATE)
	console.log('columnVisibility', columnVisibility)
	const [{ pageIndex, pageSize }, setPagination] = useState<PaginationState>({
		pageIndex: 0,
		pageSize: 10,
	})

	const { data } = trpc.getLayers.useQuery({
		pageIndex,
		pageSize,
		sortBy: sorting.length > 0 ? sorting[0].id : undefined,
		sortDesc: sorting.length > 0 ? sorting[0].desc : undefined,
		filter: filter ?? undefined,
	})

	const table = useReactTable({
		data: data?.layers ?? ([] as M.Layer[]),
		columns,
		pageCount: data?.pageCount ?? -1,
		state: {
			sorting,
			columnVisibility,
			pagination: {
				pageIndex,
				pageSize,
			},
		},
		onSortingChange: setSorting,
		onColumnVisibilityChange: setColumnVisibility,
		onPaginationChange: setPagination,
		getCoreRowModel: getCoreRowModel(),
		getSortedRowModel: getSortedRowModel(),
		manualPagination: true,
	})
	const firstRowInPage = pageIndex * pageSize + 1
	const lastRowInPage = Math.min(firstRowInPage + pageSize - 1, data?.totalCount ?? 0)

	return (
		<div>
			<div className="flex justify-between items-center mb-4">
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
			</div>
			<div className="rounded-md border">
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
							<TableRow key={row.id}>
								{row.getVisibleCells().map((cell) => (
									<TableCell key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</TableCell>
								))}
							</TableRow>
						))}
					</TableBody>
				</Table>
			</div>
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
