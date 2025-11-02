import * as FRM from '@/lib/frame'
import * as Obj from '@/lib/object'
import * as ZusUtils from '@/lib/zustand'
import * as CB from '@/models/constraint-builders'
import * as FB from '@/models/filter-builders'
import * as F from '@/models/filter.models'
import * as L from '@/models/layer'
import * as LC from '@/models/layer-columns'
import * as LQY from '@/models/layer-queries.models.ts'
import { queryClient } from '@/orpc.client'
import * as LayerQueriesClient from '@/systems.client/layer-queries.client'
import { OnChangeFn, PaginationState, RowSelectionState, VisibilityState } from '@tanstack/react-table'
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

	if (input.sort?.type === 'random' && !input.sort.seed) {
		// we want to ensure that there's always a seed here to ensure we don't run into non-deterministic cache issues with react query
		input.sort = { type: 'random', seed: LQY.getSeed() }
	}

	return input
}

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
			const updated = typeof update === 'function' ? update(original) : update

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
	}

	setStore({ layerTable: initialLayerTable })
	initialLayerTable.setSelected(input.selected)

	// set page
	args.sub.add(
		args.update$.pipe(
			Rx.startWith([args.get(), null]),
			Rx.switchMap(async ([state]) => {
				const queryInput = selectQueryInput(state)
				// we always want to fetch to keep the cache fresh
				const base = LayerQueriesClient.getQueryLayersOptions(queryInput, LayerQueriesClient.Store.getState().counters)
				const dataPromise = queryClient.fetchQuery(base)
				if (state.layerTable.pageIndex === 0 || state.layerTable.showSelectedLayers) return null
				const data = await dataPromise
				return data?.code === 'ok' ? data.pageCount : null
			}),
			Rx.distinctUntilChanged(),
			// Rx.retry(),
		).subscribe(pageCount => {
			const table = get()
			if (pageCount === null) return
			const newPageIndex = Math.max(Math.min(pageCount - 1, table.pageIndex), 0)
			set({ pageIndex: newPageIndex })
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
	let queryInput: LQY.BaseQueryInput = store.baseQueryInput ?? {}
	const selectedLayers = store.layerTable.selected
	if (store.layerTable.showSelectedLayers) {
		const filter = FB.comp(
			FB.inValues('id', selectedLayers.filter(layer => LC.isKnownAndValidLayer(layer, store.layerTable.colConfig))),
		)
		queryInput = {
			...queryInput,
			constraints: [
				...(queryInput.constraints?.flatMap(c => c.type !== 'filter-anon' ? [{ ...c, filterResults: false }] : []) ?? []),
				CB.filterAnon('show-selected', filter),
			],
		}
	}

	return {
		...queryInput,
		pageIndex: store.layerTable.pageIndex,
		pageSize: store.layerTable.pageSize,
		sort: store.layerTable.sort,
	}
}

export function selectEditingSingleValue(state: LayerTable) {
	return state.maxSelected === 1 && state.minSelected === 1
}
