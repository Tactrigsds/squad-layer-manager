import { Button } from '@/components/ui/button'
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from '@/components/ui/context-menu'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Toggle } from '@/components/ui/toggle'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useDebouncedState } from '@/hooks/use-debounce'
import * as DH from '@/lib/display-helpers'
import { Focusable } from '@/lib/react'
import * as ReactRxHelpers from '@/lib/react-rxjs-helpers'
import { assertNever } from '@/lib/type-guards'
import * as Typo from '@/lib/typography'
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
import { Checkbox } from './ui/checkbox'
import { Input } from './ui/input'
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

// Extended sorting state that includes absolute value flag
type ExtendedSortingState = Array<{ id: string; desc: boolean; abs?: boolean }>

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
	sortingState: ExtendedSortingState,
	setSorting: React.Dispatch<React.SetStateAction<ExtendedSortingState>>,
) {
	return columnHelper.accessor(colDef.name, {
		enableHiding: true,
		enableSorting: false, // Disable default sorting, we'll handle it manually
		header: () => {
			const currentSort = sortingState.find(s => s.id === colDef.name)
			const isAbs = currentSort?.abs ?? false
			const sort: SortDirection | false = currentSort ? (currentSort.desc ? 'desc' : 'asc') : false

			const handleClick = () => {
				setSorting((old) => {
					const existing = old.find(s => s.id === colDef.name)

					if (!existing) {
						// No sort -> ASC
						return [{ id: colDef.name, desc: false, abs: false }]
					} else if (!existing.desc && !existing.abs) {
						// ASC -> DESC
						return [{ id: colDef.name, desc: true, abs: false }]
					} else if (existing.desc && !existing.abs) {
						// DESC -> ASC:ABS (for numeric) or back to no sort (for non-numeric)
						if (isNumeric) {
							return [{ id: colDef.name, desc: false, abs: true }]
						} else {
							return []
						}
					} else if (!existing.desc && existing.abs) {
						// ASC:ABS -> DESC:ABS
						return [{ id: colDef.name, desc: true, abs: true }]
					} else {
						// DESC:ABS -> no sort
						return []
					}
				})
			}

			return (
				<Button
					className="data-[sort=true]:text-accent-foreground w-full justify-between"
					size="sm"
					data-sort={!!sort}
					variant="ghost"
					title={colDef.displayName}
					onClick={handleClick}
				>
					{colDef.shortName ?? colDef.displayName}
					{!sort && <ArrowUpDown className="ml-2 h-4 w-4" />}
					{sort === 'asc' && !isAbs && <ArrowUp className="ml-2 h-4 w-4" />}
					{sort === 'desc' && !isAbs && <ArrowDown className="ml-2 h-4 w-4" />}
					{sort === 'asc' && isAbs && (
						<span className="ml-2 flex items-center">
							<ArrowUp className="h-4 w-4" />
							<span className="text-xs">|x|</span>
						</span>
					)}
					{sort === 'desc' && isAbs && (
						<span className="ml-2 flex items-center">
							<ArrowDown className="h-4 w-4" />
							<span className="text-xs">|x|</span>
						</span>
					)}
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
	constraints?: LQY.Constraint[],
	sortingState?: ExtendedSortingState,
	setSorting?: React.Dispatch<React.SetStateAction<ExtendedSortingState>>,
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
			tableColDefs.push(buildColumn(colDef, teamParity, displayLayersNormalized, isNumeric, sortingState ?? [], setSorting ?? (() => {})))
		}

		// then add the rest
		for (const key of Object.keys(cfg.defs)) {
			if (sortedColKeys.some(c => c.name === key)) continue
			const colDef = LC.getColumnDef(key, cfg)!
			const isNumeric = LC.isNumericColumn(key, ctx)
			tableColDefs.push(buildColumn(colDef, teamParity, displayLayersNormalized, isNumeric, sortingState ?? [], setSorting ?? (() => {})))
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
					<div className="w-[100px]">
						<ConstraintDisplay
							side="right"
							padEmpty={true}
							matchingConstraints={matchingConstraints}
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
	// make sure this reference is stable
	baseInput?: LQY.BaseQueryInput

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

	const [showSelectedLayers, _setShowSelectedLayers] = useState(false)
	const setShowSelectedLayers: React.Dispatch<React.SetStateAction<boolean>> = (value) => {
		_setShowSelectedLayers(value)
		props.setPageIndex(0)
		if (sortingState.length > 0) {
			setSorting([])
		}
	}

	let defaultSortingState: ExtendedSortingState = []
	const defaultSort = props.defaultSort ?? cfg?.defaultSortBy
	if (defaultSort && defaultSort.type === 'column') {
		const isAbs = defaultSort.sortDirection === 'ASC:ABS' || defaultSort.sortDirection === 'DESC:ABS'
		const isDesc = defaultSort.sortDirection === 'DESC' || defaultSort.sortDirection === 'DESC:ABS'
		defaultSortingState = [{
			id: defaultSort.sortBy,
			desc: isDesc,
			abs: isAbs,
		}]
	}

	const [sortingState, _setSortingState] = useState<ExtendedSortingState>(defaultSortingState)
	const setSorting = React.useCallback<React.Dispatch<React.SetStateAction<ExtendedSortingState>>>((sortingUpdate) => {
		_setSortingState((sortingState) => {
			if (typeof sortingUpdate === 'function') {
				return sortingUpdate(sortingState)
			} else return sortingState
		})
		setRandomize(false)
		props.setPageIndex(0)
	}, [props])
	const [_randomize, setRandomize] = useState<boolean>(defaultSort?.type === 'random')
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

	const defaultVisibility = React.useMemo(() => cfg ? LQY.getDefaultColVisibilityState(cfg) : undefined, [cfg])
	const [_columnVisibility, setColumnVisibility] = useState<VisibilityState>(defaultVisibility!)
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
	const [seed, setSeed] = useState(defaultSort?.type === 'random' ? defaultSort.seed : LQY.getSeed())
	function refreshSeed() {
		setSeed(LQY.getSeed())
	}

	let sort: LQY.LayersQueryInput['sort'] = LQY.DEFAULT_SORT
	if (randomize) {
		sort = { type: 'random', seed }
	} else if (sortingState.length > 0) {
		const { id, desc, abs } = sortingState[0]
		let sortDirection: 'ASC' | 'DESC' | 'ASC:ABS' | 'DESC:ABS' = 'ASC'
		if (abs && desc) {
			sortDirection = 'DESC:ABS'
		} else if (abs && !desc) {
			sortDirection = 'ASC:ABS'
		} else if (!abs && desc) {
			sortDirection = 'DESC'
		} else {
			sortDirection = 'ASC'
		}
		sort = {
			type: 'column',
			sortBy: id,
			sortDirection,
		}
	}

	const queryInput = React.useMemo(() =>
		LayerQueriesClient.getQueryLayersInput(props.baseInput ?? {}, {
			cfg,
			pageIndex,
			selectedLayers: showSelectedLayers ? props.selected : undefined,
			pageSize,
			sort,
		}), [props.baseInput, cfg, pageIndex, showSelectedLayers, props.selected, pageSize, sort])

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
			() => cfg ? buildColDefs(cfg, teamParity ?? 0, displayTeamsNormalized, queryInput.constraints, sortingState, setSorting) : [],
			[
				cfg,
				teamParity,
				displayTeamsNormalized,
				queryInput.constraints,
				sortingState,
				setSorting,
			],
		),
		pageCount: page?.pageCount ?? -1,
		state: {
			sorting: sortingState.map(s => ({ id: s.id, desc: s.desc })),
			columnVisibility,
			rowSelection,
			pagination: {
				pageIndex: pageIndex,
				pageSize,
			},
		},
		getRowId: (row) => row.id,
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
			return [row.original.id]
		} else {
			return table
				.getRowModel()
				.rows.filter((r) => rowSelection[r.id])
				.map((r) => r.original.id)
		}
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
								<Button variant="outline">
									Toggle Columns
								</Button>
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
					<Tooltip>
						<TooltipTrigger asChild>
							<div className="flex items-center space-x-1">
								<Switch
									disabled={showSelectedLayers}
									checked={randomize}
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
						? L.getLayerCommand(props.selected[0], 'set-next')
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
							const selectedForCopy = getChosenRows(row)

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
												<TableCell className={cell.column.id !== 'constraints' ? 'pl-4' : undefined} key={cell.id}>
													{flexRender(cell.column.columnDef.cell, cell.getContext())}
												</TableCell>
											))}
										</TableRow>
									</ContextMenuTrigger>
									<ContextMenuContent>
										{<LayerContextMenuItems selectedLayerIds={selectedForCopy} />}
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
function getIsLayerDisabled(layerData: RowData, canForceSelect: boolean, constraints: LQY.Constraint[]) {
	return !canForceSelect && layerData.constraints.values?.some((v, i) => !v && constraints[i].type !== 'do-not-repeat')
}

function getIsRowDisabled(row: Row<RowData>, canForceSelect: boolean, constraints: LQY.Constraint[]) {
	return !row.getIsSelected() && getIsLayerDisabled(row.original, canForceSelect, constraints)
}
