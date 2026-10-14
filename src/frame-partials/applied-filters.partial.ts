import type React from 'react'

import * as ListHostPrt from '@/frame-partials/list-host.partial'
import type * as FRM from '@/lib/frame'
import * as Gen from '@/lib/generator-utils'
import * as Obj from '@/lib/object-utils'
import * as Prom from '@/lib/promise-utils'
import * as RSel from '@/lib/reselect'
import * as Rx from '@/lib/rxjs'
import * as Zus from '@/lib/zustand'
import * as CB from '@/models/constraint-builders.models'
import type * as F from '@/models/filter.models'
import type * as LQY from '@/models/layer-queries.models'
import type * as L from '@/models/layer.models'
import * as SETTINGS from '@/models/settings.models'
import * as FilterEntityClient from '@/systems/filter-entity.client'
import * as LayerQueriesClient from '@/systems/layer-queries.client'

export type ApplyAs = SETTINGS.SelectableFilterApplyAs

export type AppliedFiltersSlice = {
	// how the pool constrains the query: 'regular' = pool layers only, 'inverted' = out-of-pool layers only,
	// 'disabled' = unconstrained. the pool filter itself comes from settings
	poolApplyAs: ApplyAs
	filterStates: Map<F.FilterEntityId, ApplyAs>
	// when set, extra filters are scoped to this instance instead of the global localStorage-backed set
	// (e.g. the backburner request dialog, where a one-off pick shouldn't edit the user's saved extras)
	localExtraFilters?: Set<F.FilterEntityId>
}

export type Store = {
	appliedFilters: AppliedFiltersSlice
} & Predicates

export type Predicates = Partial<ListHostPrt.KeyProp>

export type Key = FRM.InstanceKeyOfState<Store>
export type KeyProp = { appliedFilters: Key }

export type Context = 'add' | 'edit' | 'generate'

export type Args = FRM.SetupArgs<{ context: Context; editedLayerId?: L.LayerId; extraFiltersScope?: 'global' | 'local' }, Store>

// The applied filters shared by Explore Layers and the add and generate dialogs on rotations: the last state set in
// any of them is where the next one starts, and an open one follows changes made in another. A dialog on a server's
// queue stays out, since its filters start from that server's pool. Kept in memory: a reload starts from the
// defaults again.
type SharedFilters = Pick<AppliedFiltersSlice, 'poolApplyAs' | 'filterStates'>
const SharedFiltersStore = Zus.createStore<{ shared: SharedFilters | null }>(() => ({ shared: null }))

function sharesFilters(context: Context, listHost: ListHostPrt.Key | undefined, localScope: boolean) {
	if (context === 'edit' || localScope) return false
	return !listHost || Zus.getState(listHost).listHost.type === 'rotation'
}

// `own` with every filter it holds set as `shared` has it; filters `shared` does not know keep their state
function withShared(own: SharedFilters, shared: SharedFilters): SharedFilters {
	const filterStates: AppliedFiltersSlice['filterStates'] = new Map()
	for (const [id, applyAs] of own.filterStates) filterStates.set(id, shared.filterStates.get(id) ?? applyAs)
	return { poolApplyAs: shared.poolApplyAs, filterStates }
}

function sameFilters(a: SharedFilters, b: SharedFilters) {
	if (a.poolApplyAs !== b.poolApplyAs || a.filterStates.size !== b.filterStates.size) return false
	for (const [id, applyAs] of a.filterStates) if (b.filterStates.get(id) !== applyAs) return false
	return true
}

export function initAppliedFiltersStore(args: Args) {
	const set = Zus.toPartialSetter(args.set, 'appliedFilters')
	const localScope = args.input.extraFiltersScope === 'local'
	set({
		poolApplyAs: 'regular',
		filterStates: new Map(),
		localExtraFilters: localScope ? new Set<F.FilterEntityId>() : undefined,
	} satisfies AppliedFiltersSlice)

	// filter entities stream in over the websocket after boot, so a frame can be set up before they land (the
	// explore-layers frame is built in the /_app loader). seeding synchronously would drop every configured pool filter.
	// the signal is what bounds the wait: entities that never arrive would otherwise leave this promise pending for the
	// life of the page, holding the frame state it captured
	void (async () => {
		await Rx.Ext.firstValueFrom(FilterEntityClient.initializedFilterEntities$(), args.signal)
		const listHost = args.get().listHost
		const initial = getInitialFilterStates(args.input.context, listHost, localScope)
		if (!sharesFilters(args.input.context, listHost, localScope)) {
			set(initial)
		} else {
			const shared = SharedFiltersStore.getState().shared
			set(shared ? withShared(initial, shared) : initial)
			// subscribed only once seeded, so the empty initial state never overwrites what is shared
			if (!args.signal.aborted) {
				args.cleanup.push(
					args.update$.pipe(Rx.map(([state]) => state.appliedFilters)).subscribe(({ poolApplyAs, filterStates }) => {
						const own = { poolApplyAs, filterStates }
						const current = SharedFiltersStore.getState().shared
						if (!current || !sameFilters(current, own)) SharedFiltersStore.setState({ shared: own })
					}),
				)
				args.cleanup.push(
					SharedFiltersStore.subscribe(({ shared }) => {
						if (!shared) return
						const own = args.get().appliedFilters
						const next = withShared(own, shared)
						if (!sameFilters(own, next)) set(next)
					}),
				)
			}
		}

		if (args.input.context !== 'edit' || !args.input.editedLayerId || !listHost) return
		const settings = ListHostPrt.Sel.settings(Zus.getState(listHost))
		const membershipConstraints = SETTINGS.getPoolMembershipConstraints(settings)
		if (membershipConstraints.length === 0) return
		// only apply the pool filter once we know the edited layer is in the pool; otherwise the layer being edited
		// would be filtered out of its own dialog
		const outOfPool = await LayerQueriesClient.fetchLayersOutOfPool(
			{
				layerIds: [args.input.editedLayerId],
				constraints: membershipConstraints,
			},
			args.signal,
		)
		if (args.signal.aborted) return
		set({ poolApplyAs: outOfPool !== null && outOfPool.length === 0 ? 'regular' : 'disabled' })
	})().catch(Prom.rethrowUnlessAborted)

	if (!localScope) {
		const unsub = ExtraFiltersStore.subscribe((extraFiltersState) => {
			// only extra filters are owned by this store -- the pool's configured filters keep their state
			const poolFilterIds = getDefaultSelectableIds(args.get().listHost)
			set((state) => ({
				filterStates: new Map(
					Gen.filter(state.filterStates, ([id]) => extraFiltersState.extraFilters.has(id) || poolFilterIds.has(id)),
				),
			}))
		})

		args.cleanup.push(unsub)
	}
}

function getDefaultSelectableIds(listHost: ListHostPrt.Key | undefined) {
	if (!listHost) return new Set<F.FilterEntityId>()
	const pool = ListHostPrt.Sel.settings(Zus.getState(listHost)).queue.mainPool
	return new Set(pool.defaultSelectable.map((c) => c.filterId))
}

function getInitialFilterStates(context: Context, listHost: ListHostPrt.Key | undefined, localScope = false) {
	const filterStates: AppliedFiltersSlice['filterStates'] = new Map()
	// a locally-scoped instance starts with no extras rather than pulling in the user's saved set
	const extraFilters = localScope ? new Set<F.FilterEntityId>() : ExtraFiltersStore.getState().extraFilters
	for (const filterid of extraFilters) {
		filterStates.set(filterid, 'disabled')
	}
	let poolApplyAs: ApplyAs = 'regular'
	if (listHost) {
		const pool = ListHostPrt.Sel.settings(Zus.getState(listHost)).queue.mainPool
		// an extra naming the pool filter is hidden here, and must not constrain the query behind the pool's own toggle
		if (pool.poolFilter) filterStates.delete(pool.poolFilter.filterId)
		for (const { filterId, applyAs } of pool.defaultSelectable) {
			// when editing an already saved layer, secondary filters start off so the current layer stays visible
			filterStates.set(filterId, context === 'edit' ? 'disabled' : applyAs)
		}
		if (context === 'generate') {
			// generation is constrained by these server-side regardless; reflecting them here keeps the dialog honest
			for (const { filterId, applyAs } of pool.constrainGeneration) {
				filterStates.set(filterId, applyAs)
			}
		}
		// 'edit' resolves pool membership asynchronously (see initAppliedFiltersStore); until then leave the pool off
		if (context === 'edit' && pool.poolFilter) poolApplyAs = 'disabled'
	}

	const filterEntities = FilterEntityClient.filterEntities
	for (const filterId of [...filterStates.keys()]) {
		if (!filterEntities.get(filterId)) {
			filterStates.delete(filterId)
		}
	}

	return { filterStates, poolApplyAs }
}

// global, localStorage-backed set of extra filters the user has pulled into the applied-filters panel. A deleted
// filter is dropped from it rather than keeping the filter alive: extras are a view preference, so they are not
// counted as references (see models/filter-references.models.ts).
export const ExtraFiltersStore = Zus.createStore<LQY.ExtraQueryFiltersStore>((set, _get, store) => {
	const extraFilters = new Set(localStorage.getItem('extraQueryFilters:v2')?.split(',') ?? [])
	void (async () => {
		await Prom.sleep(0)
		// the entities arrive over the websocket after boot, and pruning against an empty map would wipe the
		// stored set; every prune waits for the first real one
		const filterEntities = await Rx.firstValueFrom(FilterEntityClient.initializedFilterEntities$())
		const prune = () =>
			set((state) => ({
				...state,
				extraFilters: new Set(Gen.filter(state.extraFilters.values(), (f) => filterEntities.has(f))),
			}))
		prune()
		FilterEntityClient.filterMutation$.subscribe((mutation) => {
			if (mutation.type === 'delete') prune()
		})
	})()

	store.subscribe((state, prev) => {
		const extraFilters = Array.from(state.extraFilters)
		const prevExtraFilters = Array.from(prev.extraFilters)
		if (!Obj.deepEqual(extraFilters, prevExtraFilters)) {
			localStorage.setItem('extraQueryFilters:v2', extraFilters.join(','))
		}
	})

	return { extraFilters }
})

type FilterEntities = ReadonlyMap<F.FilterEntityId, F.FilterEntity>

function mainPool(listHost: ListHostPrt.Store | undefined) {
	return listHost ? ListHostPrt.Sel.settings(listHost).queue.mainPool : undefined
}

export namespace Sel {
	// the extras set this instance renders and indicates: its own when locally scoped, else the global one
	export function extraFilters(store: Store, extras: LQY.ExtraQueryFiltersStore): Set<F.FilterEntityId> {
		return store.appliedFilters.localExtraFilters ?? extras.extraFilters
	}

	export const poolFilter = RSel.createSelector([mainPool], (pool) => pool?.poolFilter ?? null)

	export const selectableFilterIds = RSel.createSelector([mainPool], (pool) => pool?.defaultSelectable.map((c) => c.filterId) ?? [])

	// the pool filter and the pool's secondary filters. they render pinned, so an extra naming one is not also drawn as an extra
	export const pinnedFilterIds = RSel.createSelector([poolFilter, selectableFilterIds], (poolFilter, selectable) => {
		const pinned = new Set<F.FilterEntityId>(selectable)
		if (poolFilter) pinned.add(poolFilter.filterId)
		return pinned
	})

	export const extraFilterIds = RSel.createSelector(
		[
			(store: Store, _listHost: ListHostPrt.Store | undefined, extras: LQY.ExtraQueryFiltersStore) => extraFilters(store, extras),
			(_store: Store, listHost: ListHostPrt.Store | undefined) => pinnedFilterIds(listHost),
		],
		(extras, pinned) => Array.from(Gen.filter(extras, (id) => !pinned.has(id))),
	)

	// filters the user can still pull in as an extra: everything the pool does not already pin
	export const addableFilters = RSel.createSelector(
		[
			(listHost: ListHostPrt.Store | undefined, _filterEntities: FilterEntities) => pinnedFilterIds(listHost),
			(_listHost: ListHostPrt.Store | undefined, filterEntities: FilterEntities) => filterEntities,
		],
		(pinned, filterEntities) => Array.from(Gen.filter(filterEntities.values(), (filter) => !pinned.has(filter.id))),
	)

	export function constraints(store: Store): LQY.Constraint[] {
		const constraints: LQY.Constraint[] = []
		const filterEntities = FilterEntityClient.filterEntities
		const settings = store.listHost ? ListHostPrt.Sel.settings(Zus.getState(store.listHost)) : undefined

		if (settings) {
			const poolFilter = settings.queue.mainPool.poolFilter
			if (poolFilter && filterEntities.has(poolFilter.filterId)) {
				constraints.push(CB.poolFilter(poolFilter.filterId, poolFilter.mode, { applyAs: store.appliedFilters.poolApplyAs }))
			}
			// selection contexts indicate but never warn
			for (const constraint of SETTINGS.getIndicationAndWarnConstraints(settings, { includeWarns: false })) {
				if (constraint.type === 'filter-entity' && !filterEntities.has(constraint.filterId)) continue
				constraints.push(constraint)
			}
		}

		const extras = extraFilters(store, ExtraFiltersStore.getState())
		for (const [filterId, applState] of store.appliedFilters.filterStates.entries()) {
			if (!filterEntities.has(filterId)) continue
			constraints.push(
				CB.filterEntity('applied-filter:' + filterId, filterId, {
					filterApplState: applState,
					// configured filters get their indication from the indicate lists; extras always indicate
					showIndicator: extras.has(filterId) ? 'both' : 'disabled',
				}),
			)
		}

		return constraints
	}
}

export namespace Actions {
	export function setPoolApplyAs(stores: KeyProp, poolApplyAs: ApplyAs) {
		Zus.toPartialStore(stores.appliedFilters, 'appliedFilters').setState({ poolApplyAs })
	}

	export function setAppliedFilterState(stores: KeyProp, filterId: F.FilterEntityId, applyAs: ApplyAs) {
		Zus.toPartialStore(stores.appliedFilters, 'appliedFilters').setState((state) => {
			const filterStates = new Map(state.filterStates)
			filterStates.set(filterId, applyAs)
			return { filterStates }
		})
	}

	export function disableAllAppliedFilters(stores: KeyProp) {
		Zus.toPartialStore(stores.appliedFilters, 'appliedFilters').setState((state) => {
			const filterStates = new Map(state.filterStates)
			for (const filterId of filterStates.keys()) {
				filterStates.set(filterId, 'disabled')
			}
			return { filterStates, poolApplyAs: 'disabled' as const }
		})
	}

	export function selectExtraFilters(stores: KeyProp, update: React.SetStateAction<F.FilterEntityId[]>) {
		const state = Zus.getState(stores.appliedFilters)
		const current = state.appliedFilters.localExtraFilters ?? ExtraFiltersStore.getState().extraFilters
		const listHost = state.listHost
		// `update` sees only the extras this instance draws. pinned ones are hidden from it and kept, so they still
		// show where this pool does not pin them
		const pinned = listHost ? Sel.pinnedFilterIds(Zus.getState(listHost)) : new Set<F.FilterEntityId>()
		const hidden: F.FilterEntityId[] = []
		const visible: F.FilterEntityId[] = []
		for (const id of current) (pinned.has(id) ? hidden : visible).push(id)
		const updated = typeof update === 'function' ? update(visible) : update
		const filterIds = [...updated.filter((id) => !pinned.has(id)), ...hidden]
		if (state.appliedFilters.localExtraFilters) {
			const localExtraFilters = new Set(filterIds)
			// mirror the global-scope subscription: dropping an extra drops its applied state too
			const poolFilterIds = getDefaultSelectableIds(listHost)
			Zus.toPartialStore(stores.appliedFilters, 'appliedFilters').setState((slice) => ({
				localExtraFilters,
				filterStates: new Map(Gen.filter(slice.filterStates, ([id]) => localExtraFilters.has(id) || poolFilterIds.has(id))),
			}))
			return
		}
		ExtraFiltersStore.setState({
			extraFilters: new Set(filterIds),
		})
	}
}
