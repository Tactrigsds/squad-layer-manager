import type { OnChangeFn, PaginationState, VisibilityState } from '@tanstack/react-table'
import type * as Im from 'immer'
import React from 'react'

import type * as LayerFilterMenuPrt from '@/frame-partials/layer-filter-menu.partial.ts'
import type * as SquadServerFrame from '@/frames/squad-server.frame'
import * as Arr from '@/lib/array-utils'
import type * as FRM from '@/lib/frame'
import * as Obj from '@/lib/object-utils'
import * as RSel from '@/lib/reselect'
import * as Rx from '@/lib/rxjs'
import * as SetUtils from '@/lib/set-utils'
import * as Zus from '@/lib/zustand'
import * as CS from '@/models/context-shared'
import type * as F from '@/models/filter.models'
import type * as L from '@/models/layer'
import * as LC from '@/models/layer-columns'
import * as LQY from '@/models/layer-queries.models.ts'
import * as RBAC from '@/rbac.models'
import * as LayerQueriesClient from '@/systems/layer-queries.client'
import type * as RbacClient from '@/systems/rbac.client'
import * as UsersClient from '@/systems/users.client'

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

export function initLayerTable(args: Args) {
	const getStore = args.get
	const setStore = args.set
	const input = args.input

	const get = Zus.toPartialGetter(args.get, 'layerTable')
	const set = Zus.toPartialSetter(args.set, 'layerTable')
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
	args.cleanup.push(
		args.update$
			.pipe(
				Rx.Ext.traceTag('QUERY_LAYERS'),
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
				Rx.Ext.distinctDeepEquals(),
				Rx.throttleTime(500, Rx.asyncScheduler, { leading: true, trailing: true }),
				Rx.switchMap((input) =>
					LayerQueriesClient.queryLayers$(input).pipe(
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
					),
				),
				Rx.retry({
					delay: (error, count) => {
						console.error('error during query:', error)
						return Rx.timer(Math.min(Math.pow(2, count) * 250, 10_000))
					},
				}),
			)
			.subscribe((packet) => {
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
	args.cleanup.push(
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

const DEFAULT_COLUMN_SIZE = 150
export const SELECT_COLUMN_SIZE = 40
export const CONSTRAINTS_COLUMN_SIZE = 80

export function getColumnSize(name: string, isNumeric: boolean): number {
	return ({ Size: 100, Faction_1: 40, Faction_2: 40 } as Record<string, number>)[name] ?? (isNumeric ? 50 : DEFAULT_COLUMN_SIZE)
}

// columns that stay visible in compact mode. the select and constraints(flag) columns aren't part
// of columnVisibility state and always render
export const COMPACT_VISIBLE_COLUMNS: string[] = ['Layer', 'Faction_1', 'Faction_2', 'Unit_1', 'Unit_2']

// width the table wants when rendered with the given column visibility, derived from the same
// size hints the column defs use. lets callers compute a compact-mode breakpoint parametrically
export function getFullTableWidth(cfg: LQY.EffectiveColumnAndTableConfig, columnVisibility: VisibilityState): number {
	const ctx: LC.Ctx = { ...CS.init(), effectiveColsConfig: cfg }
	let width = SELECT_COLUMN_SIZE + CONSTRAINTS_COLUMN_SIZE
	for (const name of Object.keys(cfg.defs)) {
		if (!columnVisibility[name]) continue
		width += getColumnSize(name, LC.isNumericColumn(name, ctx))
	}
	return width
}

export namespace Sel {
	export function editingSingleValue(store: Store) {
		return store.layerTable.maxSelected === 1 && store.layerTable.minSelected === 1
	}

	// the sources every pool-gated selector below takes, in order. The user and the rbac store arrive separately so
	// simulation is folded in here rather than read once when the page was queried
	type PoolArgs = [store: Store, user: RBAC.UserWithRbac | undefined, rbacStore: RbacClient.RbacStore]

	// an unresolved user is treated as holding nothing, which disables out-of-pool rows until it loads. The server
	// gates the write regardless, so the only cost of being wrong for a frame is an affordance that appears late
	const canForceSelect = (...[, user, rbacStore]: PoolArgs) => {
		const simulated = UsersClient.Sel.maybeLoggedInUser(user, rbacStore)
		return !!simulated && RBAC.hasPermOnAnyServer(RBAC.fromTracedPermissions(simulated.perms), 'queue:force-write')
	}

	export const rowSelectionStatus = RSel.memoizeFactory((rowId: L.LayerId) =>
		RSel.createDeepSelector(
			[
				(...[store]: PoolArgs) => store.layerTable.pageData,
				(...[store]: PoolArgs) => store.layerTable.selected,
				(...[store]: PoolArgs) => store.layerTable.minSelected,
				canForceSelect,
			],
			(pageData, selected, minSelected, canForceSelect) => {
				const row = pageData?.layers.find((r) => r.id === rowId)
				if (!row) return { isUnselectable: false, isSelected: false, blockedByPool: false }
				const isSelected = selected.includes(rowId)

				const blockedByPool = row.isOutOfPool && !canForceSelect
				if (blockedByPool) return { isUnselectable: true, isSelected, blockedByPool }

				// Check if unchecking would violate minSelected
				if (isSelected) {
					const wouldBeUnderMin = (minSelected ?? 0) > selected.length - 1
					if (wouldBeUnderMin) return { isUnselectable: true, isSelected, blockedByPool }
				}

				return { isUnselectable: false, isSelected, blockedByPool }
			},
		),
	)

	export const selectAllStatus = RSel.createDeepSelector(
		[
			(...[store]: PoolArgs) => store.layerTable.pageData,
			(...[store]: PoolArgs) => store.layerTable.selected,
			(...[store]: PoolArgs) => store.layerTable.minSelected,
			(...[store]: PoolArgs) => store.layerTable.maxSelected,
			canForceSelect,
		],
		(pageData, selected, minSelected, maxSelected, canForceSelect) => {
			if (pageData === null) return { selectState: null, disabled: true }
			const selectedSet = new Set(selected)
			const pageIds = new Set(pageData.layers.map((l) => l.id))
			const intersect = SetUtils.intersection(selectedSet, pageIds)
			const selectState: 'all' | 'some' | null = intersect.size === pageIds.size ? 'all' : intersect.size > 0 ? 'some' : null

			const ifAllSelected = SetUtils.union(selectedSet, pageIds)
			const ifAllUnselected = SetUtils.difference(selectedSet, pageIds)
			const disabled =
				(maxSelected ?? Infinity) < ifAllSelected.size ||
				(minSelected ?? 0) > ifAllUnselected.size ||
				(!canForceSelect && pageData.layers.some((l) => l.isOutOfPool))
			return { selectState, disabled }
		},
	)

	// compact mode hides all but COMPACT_VISIBLE_COLUMNS without touching the stored visibility prefs
	export const columnVisibility = RSel.memoizeFactory((compact: boolean) =>
		RSel.createSelector([(store: Store) => store.layerTable.columnVisibility], (visibility) => {
			if (!compact) return visibility
			const compacted: VisibilityState = { ...visibility }
			for (const name of Object.keys(compacted)) {
				if (!COMPACT_VISIBLE_COLUMNS.includes(name)) compacted[name] = false
			}
			return compacted
		}),
	)

	export const defaultVisibleColumns = RSel.createSelector(
		[(store: Store) => store.layerTable.colConfig],
		(cfg) => cfg?.orderedColumns.filter((col) => col.visible ?? true).map((col) => col.name) ?? [],
	)

	// parity of the team the queried page sits at, for the display-normalization the cells apply. read off the server
	// frame state passed in rather than layerItemsState$, which throws when no frame is hot; 0 outside a server context
	export const teamParity = RSel.createSelector(
		[
			(store: Store) => store.layerTable.pageData?.input.cursor,
			(_store: Store, squadServer: SquadServerFrame.State | undefined) => squadServer?.layerItemsState,
		],
		(cursor, layerItemsState) => {
			if (!cursor || !layerItemsState) return 0
			return LQY.resolveTeamParityForCursor(layerItemsState, LQY.fromLayerListCursor(layerItemsState, cursor))
		},
	)
}

export namespace Actions {
	function slice(stores: KeyProp) {
		return Zus.toPartialStore(stores.layerTable, 'layerTable')
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
		const updatedTrimmed = updated.filter((id) => updatedByTimeTrimmed.includes(id))
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

	export const onPaginationChange =
		(stores: KeyProp): OnChangeFn<PaginationState> =>
		(update) => {
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

	export const onColumnVisibilityChange =
		(stores: KeyProp): OnChangeFn<VisibilityState> =>
		(update) => {
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
}
