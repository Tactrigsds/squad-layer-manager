import * as Arr from '@/lib/array'
import { distinctDeepEquals, traceTag } from '@/lib/async'
import type * as FRM from '@/lib/frame'
import * as Obj from '@/lib/object'
import type * as ZusUtils from '@/lib/zustand'
import type * as F from '@/models/filter.models'
import type * as L from '@/models/layer'
import * as LQY from '@/models/layer-queries.models.ts'
import * as RPC from '@/orpc.client'
import * as LayerQueriesClient from '@/systems.client/layer-queries.client'
import type { OnChangeFn, PaginationState, RowSelectionState, VisibilityState } from '@tanstack/react-table'
import type * as Im from 'immer'
import React from 'react'
import * as Rx from 'rxjs'

export type { PostProcessedLayer } from '@/systems.shared/layer-queries.shared'

export type InputArgs = {
	pageSize?: number
	sort?: LQY.LayersQueryInput['sort']
	visibleColumns?: string[]
	maxSelected?: number
	minSelected?: number
	selected?: L.LayerId[]
	colConfig: LQY.EffectiveColumnAndTableConfig
}

export type Input = {
	pageSize: number
	sort: LQY.LayersQuerySort | null
	columnVisibility: Record<string, boolean>
	maxSelected: number | null
	minSelected: number | null
	selected: L.LayerId[]
	colConfig: LQY.EffectiveColumnAndTableConfig
}

export function getInputDefaults(args: InputArgs): Input {
	const sort = Obj.deepClone(args.sort ?? args.colConfig.defaultSortBy)
	if (sort.type === 'random' && !sort.seed) {
		// we want to ensure that there's always a seed here to ensure we don't run into non-deterministic cache issues with react query
		// note that we also always reseed after a reset
		sort.seed = LQY.getSeed()
	}

	const columnVisibility: Record<string, boolean> = {}
	for (const colName of Object.keys(args.colConfig.defs)) {
		columnVisibility[colName] = false
	}
	for (const col of args.colConfig.orderedColumns) {
		columnVisibility[col.name] = col.visible ?? true
	}

	if (args.visibleColumns) {
		for (const colName of args.visibleColumns) {
			columnVisibility[colName] = true
		}
	}
	const input: Input = {
		pageSize: args.pageSize ?? 10,
		sort,
		columnVisibility,
		maxSelected: args.maxSelected ?? null,
		minSelected: args.minSelected ?? null,
		selected: args.selected ?? [],
		colConfig: args.colConfig,
	}

	if (input.minSelected !== null && input.selected.length < input.minSelected) {
		input.selected = []
	}
	if (input.maxSelected !== null && input.selected.length > input.maxSelected) {
		input.selected = input.selected.slice(0, input.maxSelected)
	}

	return input
}

export function reset(input: Input, draft: Im.WritableDraft<LayerTable>) {
	draft.pageSize = input.pageSize
	draft.selected = input.selected
	draft.pageIndex = 0
	draft.sort = input.sort
	if (input.sort?.type == 'random') {
		// always reseed after reset
		input.sort.seed = LQY.getSeed()
	}
	draft.errors = []
	draft.columnVisibility = input.columnVisibility
}

export type ConstraintRowDetails = {
	values: boolean[]
	violationDescriptors: LQY.MatchDescriptor[]
	matchedConstraints: LQY.Constraint[]
	matchedConstraintDescriptors: LQY.MatchDescriptor[]
}
export type RowData = L.KnownLayer & Record<string, any> & { 'constraints': ConstraintRowDetails; 'isRowDisabled': boolean }

export type LayerTable = {
	colConfig: LQY.EffectiveColumnAndTableConfig
	// from props
	sort: ({} & LQY.LayersQuerySort) | null
	setSort: React.Dispatch<React.SetStateAction<LQY.LayersQuerySort | null>>
	randomize: () => void

	defaultSelected: L.LayerId[]
	selected: L.LayerId[]
	setSelected: React.Dispatch<React.SetStateAction<L.LayerId[]>>
	resetSelected: () => void

	// tanstack actions
	onSetRowSelection: OnChangeFn<RowSelectionState>
	onPaginationChange: OnChangeFn<PaginationState>

	pageIndex: number
	setPageIndex: (num: number) => void

	pageSize: number
	setPageSize: (num: number) => void

	maxSelected: number | null
	minSelected: number | null

	showSelectedLayers: boolean
	setShowSelectedLayers: React.Dispatch<React.SetStateAction<boolean>>

	columnVisibility: VisibilityState
	onColumnVisibilityChange: OnChangeFn<VisibilityState>

	isFetching: boolean
	pageData: LayerQueriesClient.QueryLayersPageData | null
} & F.NodeValidationErrorStore

export type Predicates = {
	baseQueryInput: LQY.BaseQueryInput | undefined
	onLayerFocused?: (layerId: L.LayerId) => void
}

export type Store = {
	layerTable: LayerTable
}
export type Args = FRM.SetupArgs<Input, Store, Store & Predicates>

export function initLayerTable(
	args: Args,
) {
	const getStore = args.get
	const setStore = args.set
	const input = args.input

	const get: ZusUtils.Getter<LayerTable> = () => getStore().layerTable
	const set: ZusUtils.Setter<LayerTable> = (update) => {
		const current = getStore().layerTable
		const updatePartial = typeof update === 'function' ? update(current) : update
		setStore({ layerTable: { ...current, ...updatePartial } })
	}
	const initialLayerTable: LayerTable = {
		colConfig: input.colConfig,

		sort: input.sort,
		setSort(update) {
			const updated = typeof update === 'function' ? update(get().sort) : update
			set({ sort: updated, pageIndex: 0 })
		},
		randomize() {
			set({ sort: { type: 'random', seed: LQY.getSeed() } })
		},

		defaultSelected: input.selected,
		// should be run through setSelected
		selected: [],
		setSelected(update) {
			const state = get()
			const original = state.selected
			let updated = typeof update === 'function' ? update(original) : update
			updated = Arr.dedupe(updated)

			const numToTrim = Math.max(0, updated.length - (state.maxSelected ?? updated.length))
			const updatedByTimeTrimmed = updated.slice(numToTrim)
			const updatedTrimmed = updated.filter(id => updatedByTimeTrimmed.includes(id))
			if (state.minSelected && state.minSelected > updatedTrimmed.length) {
				return
			}

			let newPageIndex = state.pageIndex
			let showSelectedLayers = state.showSelectedLayers
			if (state.showSelectedLayers) {
				if (updatedTrimmed.length === 0) {
					newPageIndex = 0
					showSelectedLayers = false
				}
				if (state.showSelectedLayers && state.pageIndex * state.pageSize >= updatedTrimmed.length) {
					newPageIndex = Math.max(0, Math.ceil(updatedTrimmed.length / state.pageSize) - 1)
				}
			}

			set({ selected: updatedTrimmed, showSelectedLayers, pageIndex: newPageIndex })
		},
		resetSelected() {
			const reset = input.selected ?? []
			const { minSelected } = get()
			if (minSelected && reset.length > minSelected) return
			set({ selected: reset, showSelectedLayers: reset.length > 0, pageIndex: 0 })
		},

		onSetRowSelection: (rowSelectionUpdate) => {
			const updated = typeof rowSelectionUpdate === 'function'
				? rowSelectionUpdate(selectTanstackRowSelection(get()))
				: rowSelectionUpdate
			const selected: L.LayerId[] = Object.keys(updated).filter(id => updated[id])
			get().setSelected(selected)
		},
		onPaginationChange: (update) => {
			let newState: PaginationState
			const { pageIndex, pageSize } = get()
			if (typeof update === 'function') {
				newState = update({ pageIndex, pageSize })
			} else {
				newState = update
			}
			set({
				pageIndex: newState.pageIndex,
				pageSize: newState.pageSize,
			})
		},
		onColumnVisibilityChange: update => {
			const updated = typeof update === 'function' ? update(get().columnVisibility) : update
			let { sort, pageIndex } = get()
			if (sort?.type === 'column' && !updated[sort.sortBy]) {
				pageIndex = 0
				sort = null
			}

			set({ columnVisibility: updated, sort, pageIndex })
		},

		pageIndex: 0,
		setPageIndex: (pageIndex) => {
			set({ pageIndex })
		},

		pageSize: input.pageSize,
		setPageSize: (pageSize) => {
			set({ pageSize, pageIndex: 0 })
		},

		maxSelected: input.maxSelected,
		minSelected: input.minSelected,

		errors: [],
		setErrors: (errors) => {
			set({ errors })
		},

		showSelectedLayers: false,
		setShowSelectedLayers(update) {
			const updated = typeof update === 'function' ? update(get().showSelectedLayers) : update
			set({ showSelectedLayers: updated, sort: null, pageIndex: 0 })
		},

		columnVisibility: input.columnVisibility,

		pageData: null,
		isFetching: false,
	}

	setStore({ layerTable: initialLayerTable })
	initialLayerTable.setSelected(input.selected)

	// -------- schedule queries --------
	args.sub.add(
		args.update$.pipe(
			traceTag('QUERY_LAYERS'),
			Rx.startWith([args.get(), null] as const),
			Rx.filter(([store]) => !!store.baseQueryInput),
			Rx.map(([store]) => selectQueryInput(store)),
			distinctDeepEquals(),
			// Rx.auditTime(250),
			Rx.switchMap(async (queryInput) => {
				const base = LayerQueriesClient.getQueryLayersOptions(queryInput)

				const data = await (async () => {
					try {
						set({ isFetching: true })
						const data = await RPC.queryClient.fetchQuery(base)
						return data
					} finally {
						set({ isFetching: false })
					}
				})()
				if (!data || data.code !== 'ok') return null
				return data
			}),
			Rx.retry({
				delay: (error, count) => {
					console.error('error during query setup', error)
					return Rx.timer(Math.min(Math.pow(2, count) * 250, 10_000))
				},
			}),
		).subscribe((data) => {
			set({ pageData: data })
		}),
	)

	// -------- updates from query results --------
	args.sub.add(
		args.update$.subscribe(([state, prev]) => {
			;(() => {
				const table = state.layerTable
				if (table.pageData === prev.layerTable.pageData || table.pageIndex === 0 || !table.pageData) return
				const pageCount = table.pageData.pageCount
				const newPageIndex = Math.max(Math.min(pageCount - 1, table.pageIndex), 0)
				set({ pageIndex: newPageIndex })
			})()
			;(() => {
				const table = state.layerTable
				if (!table.pageData || table.pageData !== prev.layerTable.pageData) return
				if (!table.minSelected || !table.maxSelected || table.minSelected > 1 || table.maxSelected !== 1) return
				if (table.pageData.layers.length !== 1) return
				if (table.pageData.layers[0].id === table.selected[0]) return
				// we're in edit mode and we're editing a single layer, so let's just select the layer we just queried
				table.setSelected([table.pageData.layers[0].id])
			})()
		}),
	)
}

export type Types = FRM.FrameTypes & { state: Store & Predicates }
export type Key = FRM.InstanceKey<Types>

type TanstackSortingStateCol = { id: string; desc: boolean }
type TanstackSortingState = Array<TanstackSortingStateCol>
export function selectTanstackSortingState(table: LayerTable): TanstackSortingState {
	if (!table.sort) return []
	if (table.sort.type === 'random') return []

	return [{
		id: table.sort.sortBy,
		desc: table.sort.direction === 'ASC' || table.sort.direction === 'ASC:ABS',
	}]
}

export function selectTanstackRowSelection(table: LayerTable): RowSelectionState {
	const state: RowSelectionState = {}
	for (const id of table.selected) {
		state[id] = true
	}
	return state
}

export function getTanstackActions(table: LayerTable) {
	const setSorting: React.Dispatch<React.SetStateAction<TanstackSortingState>> = (sortingUpdate) => {
		const current = selectTanstackSortingState(table)
		const updated = typeof sortingUpdate === 'function'
			? sortingUpdate(current)
			: current

		if (updated.length === 0) {
			table.setSort(null)
		}
		table.setSort({ type: 'column', sortBy: updated[0]?.id ?? '', direction: updated[0]?.desc ? 'ASC' : 'DESC' })
	}

	const onSetRowSelection: OnChangeFn<RowSelectionState> = (rowSelectionUpdate) => {
		const updated = typeof rowSelectionUpdate === 'function'
			? rowSelectionUpdate(selectTanstackRowSelection(table))
			: rowSelectionUpdate
		const selected: L.LayerId[] = Object.keys(updated).filter(id => updated[id])
		table.setSelected(selected)
	}

	return { setSorting, setRowSelection: onSetRowSelection }
}

export function selectQueryInput(store: Store & Predicates): LQY.LayersQueryInput {
	return LayerQueriesClient.getQueryLayersInput(store.baseQueryInput ?? {}, {
		cfg: store.layerTable.colConfig,
		selectedLayers: store.layerTable.showSelectedLayers ? store.layerTable.selected : undefined,
		pageIndex: store.layerTable.pageIndex,
		pageSize: store.layerTable.pageSize,
		sort: store.layerTable.sort,
	})
}

export function selectEditingSingleValue(state: LayerTable) {
	return state.maxSelected === 1 && state.minSelected === 1
}
