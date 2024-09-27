import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { trpc } from '@/lib/trpc'
import { ProcessedLayer } from '@/scripts/preprocess'
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
import React, { useState } from 'react'

export type Layer = ProcessedLayer
const columnHelper = createColumnHelper<Layer>()

const formatNumber = (value: number | null | undefined) => {
	if (value == null) return 'N/A'
	const formatted = value.toFixed(2)
	const numeric = parseFloat(formatted)
	if (numeric > 0) return `+${formatted}`
	return formatted
}

const columns: ColumnDef<Layer, any>[] = [
	columnHelper.accessor('Level', {
		header: 'Level',
		cell: (info) => info.getValue() || 'N/A',
	}),
	columnHelper.accessor('Layer', {
		header: 'Layer',
		cell: (info) => info.getValue() || 'N/A',
	}),
	columnHelper.accessor('Size', {
		header: 'Size',
		cell: (info) => info.getValue() || 'N/A',
	}),
	columnHelper.accessor('Gamemode', {
		header: 'Gamemode',
		cell: (info) => info.getValue() || 'N/A',
	}),
	columnHelper.accessor('LayerVersion', {
		header: 'Version',
		cell: (info) => info.getValue() || 'N/A',
	}),
	columnHelper.accessor('Faction_1', {
		header: 'Faction 1',
		cell: (info) => info.getValue() || 'N/A',
	}),
	columnHelper.accessor('SubFac_1', {
		header: 'Sub-Faction 1',
		cell: (info) => info.getValue() || 'N/A',
	}),
	columnHelper.accessor('Faction_2', {
		header: 'Faction 2',
		cell: (info) => info.getValue() || 'N/A',
	}),
	columnHelper.accessor('SubFac_2', {
		header: 'Sub-Faction 2',
		cell: (info) => info.getValue() || 'N/A',
	}),
	columnHelper.accessor('Logistics_Diff', {
		header: 'Logistics Diff',
		cell: (info) => formatNumber(info.getValue()),
	}),
	columnHelper.accessor('Transportation_Diff', {
		header: 'Transportation Diff',
		cell: (info) => formatNumber(info.getValue()),
	}),
	columnHelper.accessor('Anti-Infantry_Diff', {
		header: 'Anti-Infantry Diff',
		cell: (info) => formatNumber(info.getValue()),
	}),
	columnHelper.accessor('Armor_Diff', {
		header: 'Armor Diff',
		cell: (info) => formatNumber(info.getValue()),
	}),
	columnHelper.accessor('ZERO_Score_Diff', {
		header: 'ZERO Score Diff',
		cell: (info) => formatNumber(info.getValue()),
	}),
	columnHelper.accessor('Balance_Differential', {
		header: 'Balance Differential',
		cell: (info) => formatNumber(info.getValue()),
	}),
]

export default function LayerTable() {
	const [sorting, setSorting] = useState<SortingState>([])
	const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({})
	const [{ pageIndex, pageSize }, setPagination] = useState<PaginationState>({
		pageIndex: 0,
		pageSize: 10,
	})

	const { data, isLoading, isFetching } = trpc.getLayersPaginated.useQuery({
		pageIndex,
		pageSize,
		sortBy: sorting.length > 0 ? sorting[0].id : undefined,
		sortDesc: sorting.length > 0 ? sorting[0].desc : undefined,
	})

	const table = useReactTable({
		data: data?.layers ?? ([] as Layer[]),
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
