import type * as LayerFilterMenuPrt from '@/frame-partials/layer-filter-menu.partial.ts'
import * as Arr from '@/lib/array'
import { distinctDeepEquals, toCold, traceTag } from '@/lib/async'
import type * as FRM from '@/lib/frame'
import * as Obj from '@/lib/object'
import * as RSel from '@/lib/reselect'
import * as ZusUtils from '@/lib/zustand'
import type * as F from '@/models/filter.models'
import type * as L from '@/models/layer'
import * as LQY from '@/models/layer-queries.models.ts'
import * as RPC from '@/orpc.client'
import * as LayerQueriesClient from '@/systems/layer-queries.client'
import type { OnChangeFn, PaginationState, RowSelectionState, VisibilityState } from '@tanstack/react-table'
import type * as Im from 'immer'
import React from 'react'
import * as Rx from 'rxjs'

export type { PostProcessedLayer } from '@/systems/layer-queries.shared'

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

export type LayerTable = {
	colConfig: LQY.EffectiveColumnAndTableConfig
	// from props
	sort: ({} & LQY.LayersQuerySort) | null

	defaultSelected: L.LayerId[]
	selected: L.LayerId[]

	pageIndex: number

	pageSize: number

	maxSelected: number | null
	minSelected: number | null

	showSelectedLayers: boolean

	columnVisibility: VisibilityState

	isFetching: boolean
	pageData: LayerQueriesClient.QueryLayersPageData | null
} & F.NodeValidationErrorStore

export type Predicates = {
	baseQueryInput: LQY.BaseQueryInput | undefined
	onLayerFocused?: (layerId: L.LayerId) => void
}

export type Store = {
	layerTable: LayerTable
} & LayerFilterMenuPrt.Predicates

export type Args = FRM.SetupArgs<Input, Store, Store & Predicates>

export function initLayerTable(
	args: Args,
) {
	const getStore = args.get
	const setStore = args.set
	const input = args.input

	const get = ZusUtils.toPartialGetter(args.get, 'layerTable')
	const set = ZusUtils.toPartialSetter(args.set, 'layerTable')
	const initialLayerTable: LayerTable = {
		colConfig: input.colConfig,
		sort: input.sort,

		defaultSelected: input.selected,
		// should be run through Actions.setSelected
		selected: [],

		pageIndex: 0,

		pageSize: input.pageSize,

		maxSelected: input.maxSelected,
		minSelected: input.minSelected,

		errors: [],
		setErrors: (errors) => {
			set({ errors })
		},

		showSelectedLayers: false,

		columnVisibility: input.columnVisibility,

		pageData: null,
		isFetching: false,
	}

	set(initialLayerTable)
	Actions.setSelected({ layerTable: args.key }, input.selected)

	// -------- schedule queries (poor man's useQuery) --------
	args.sub.add(
		args.update$.pipe(
			traceTag('QUERY_LAYERS'),
			Rx.map(([store]) => {
				const input = LayerQueriesClient.getQueryLayersInput(store.baseQueryInput ?? {}, {
					cfg: store.layerTable.colConfig,
					selectedLayers: store.layerTable.showSelectedLayers ? store.layerTable.selected : undefined,
					pageIndex: store.layerTable.pageIndex,
					pageSize: store.layerTable.pageSize,
					sort: store.layerTable.sort,
				})

				return input
			}),
			distinctDeepEquals(),
			Rx.throttleTime(500, Rx.asyncScheduler, { leading: true, trailing: true }),
			Rx.switchMap((input) => {
				const packet$ = new Rx.Subject<LayerQueriesClient.QueryLayersPacket>()
				const options = LayerQueriesClient.getQueryLayersOptions(input, packet$)
				let o: Rx.Observable<LayerQueriesClient.QueryLayersPacket>

				const data = RPC.queryClient.getQueryData(options.queryKey)
				if (data) o = Rx.from(data)
				else if (RPC.queryClient.isFetching(options)) {
					o = toCold(() => RPC.queryClient.fetchQuery(options)).pipe(Rx.concatAll())
				} else {
					void RPC.queryClient.fetchQuery(options)
					o = packet$
				}

				return o.pipe(
					Rx.tap({
						subscribe: () => {
							set({ isFetching: true })
						},
						complete: () => {
							set({ isFetching: false })
						},
						unsubscribe: () => {
							set({ isFetching: false })
						},
					}),
				)
			}),
			Rx.retry({
				delay: (error, count) => {
					console.error('error during query:', error)
					return Rx.timer(Math.min(Math.pow(2, count) * 250, 10_000))
				},
			}),
		).subscribe((packet) => {
			if (packet.code === 'layers-page' && get().pageData !== packet) {
				set({ pageData: packet })
				return
			}

			if (packet.code === 'menu-item-possible-values' && getStore().filterMenuItemPossibleValues !== packet.values) {
				setStore({ filterMenuItemPossibleValues: packet.values })
				return
			}
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
				Actions.setSelected({ layerTable: args.key }, [table.pageData.layers[0].id])
			})()
		}),
	)
}

export type Types = FRM.FrameTypes & { state: Store & Predicates }
export type Key = FRM.InstanceKey<Types>
export type KeyProp = { layerTable: Key }

type TanstackSortingStateCol = { id: string; desc: boolean }
type TanstackSortingState = Array<TanstackSortingStateCol>

export namespace Sel {
	export function tanstackSortingState(store: Store): TanstackSortingState {
		const table = store.layerTable
		if (!table.sort) return []
		if (table.sort.type === 'random') return []

		return [{
			id: table.sort.sortBy,
			desc: table.sort.direction === 'ASC' || table.sort.direction === 'ASC:ABS',
		}]
	}

	export function tanstackRowSelection(store: Store): RowSelectionState {
		const state: RowSelectionState = {}
		for (const id of store.layerTable.selected) {
			state[id] = true
		}
		return state
	}

	export function editingSingleValue(store: Store) {
		return store.layerTable.maxSelected === 1 && store.layerTable.minSelected === 1
	}

	export const rowSelectionStatus = RSel.memoizeFactory((rowId: L.LayerId) =>
		RSel.createDeepSelector(
			[
				(store: Store) => store.layerTable.pageData,
				(store: Store) => store.layerTable.selected,
				(store: Store) => store.layerTable.minSelected,
			],
			(pageData, selected, minSelected) => {
				const row = pageData?.layers.find(r => r.id === rowId)
				if (!row) return [false, false] as const
				const isSelected = selected.includes(rowId)

				// If row is already disabled, it's disabled
				if (row.isRowDisabled) return [true, isSelected] as const

				// Check if unchecking would violate minSelected
				if (isSelected) {
					const wouldBeUnderMin = (minSelected ?? 0) > (selected.length - 1)
					if (wouldBeUnderMin) return [true, isSelected] as const
				}

				return [false, isSelected] as const
			},
		)
	)
}

export namespace Actions {
	function slice(stores: KeyProp) {
		return ZusUtils.toPartialStore(stores.layerTable, 'layerTable')
	}

	export function setSort(stores: KeyProp, update: React.SetStateAction<LQY.LayersQuerySort | null>) {
		const table = slice(stores)
		const updated = typeof update === 'function' ? update(table.getState().sort) : update
		table.setState({ sort: updated, pageIndex: 0 })
	}

	export function randomize(stores: KeyProp) {
		slice(stores).setState({ sort: { type: 'random', seed: LQY.getSeed() } })
	}

	export function setSelected(stores: KeyProp, update: React.SetStateAction<L.LayerId[]>) {
		const table = slice(stores)
		const state = table.getState()
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

		table.setState({ selected: updatedTrimmed, showSelectedLayers, pageIndex: newPageIndex })
	}

	export function resetSelected(stores: KeyProp) {
		const table = slice(stores)
		const { minSelected, defaultSelected } = table.getState()
		const reset = defaultSelected ?? []
		if (minSelected && reset.length > minSelected) return
		table.setState({ selected: reset, showSelectedLayers: reset.length > 0, pageIndex: 0 })
	}

	export const onSetRowSelection = (stores: KeyProp): OnChangeFn<RowSelectionState> => (rowSelectionUpdate) => {
		const updated = typeof rowSelectionUpdate === 'function'
			? rowSelectionUpdate(Sel.tanstackRowSelection(ZusUtils.getState(stores.layerTable)))
			: rowSelectionUpdate
		const selected: L.LayerId[] = Object.keys(updated).filter(id => updated[id])
		setSelected(stores, selected)
	}

	export const onPaginationChange = (stores: KeyProp): OnChangeFn<PaginationState> => (update) => {
		const table = slice(stores)
		let newState: PaginationState
		const { pageIndex, pageSize } = table.getState()
		if (typeof update === 'function') {
			newState = update({ pageIndex, pageSize })
		} else {
			newState = update
		}
		table.setState({
			pageIndex: newState.pageIndex,
			pageSize: newState.pageSize,
		})
	}

	export const onColumnVisibilityChange = (stores: KeyProp): OnChangeFn<VisibilityState> => (update) => {
		const table = slice(stores)
		const updated = typeof update === 'function' ? update(table.getState().columnVisibility) : update
		let { sort, pageIndex } = table.getState()
		if (sort?.type === 'column' && !updated[sort.sortBy]) {
			pageIndex = 0
			sort = null
		}

		table.setState({ columnVisibility: updated, sort, pageIndex })
	}

	export function setPageIndex(stores: KeyProp, pageIndex: number) {
		slice(stores).setState({ pageIndex })
	}

	export function setPageSize(stores: KeyProp, pageSize: number) {
		slice(stores).setState({ pageSize, pageIndex: 0 })
	}

	export function setShowSelectedLayers(stores: KeyProp, update: React.SetStateAction<boolean>) {
		const table = slice(stores)
		const updated = typeof update === 'function' ? update(table.getState().showSelectedLayers) : update
		table.setState({ showSelectedLayers: updated, sort: null, pageIndex: 0 })
	}

	export function getTanstackActions(stores: KeyProp) {
		const setSorting: React.Dispatch<React.SetStateAction<TanstackSortingState>> = (sortingUpdate) => {
			const current = Sel.tanstackSortingState(ZusUtils.getState(stores.layerTable))
			const updated = typeof sortingUpdate === 'function'
				? sortingUpdate(current)
				: current

			if (updated.length === 0) {
				setSort(stores, null)
			}
			setSort(stores, { type: 'column', sortBy: updated[0]?.id ?? '', direction: updated[0]?.desc ? 'ASC' : 'DESC' })
		}

		return { setSorting, setRowSelection: onSetRowSelection(stores) }
	}
}
