import * as SquadServerFrame from '@/frames/squad-server.frame'
import { sleep } from '@/lib/async'
import type * as FRM from '@/lib/frame'
import * as Gen from '@/lib/generator'
import * as Obj from '@/lib/object'
import * as ZusUtils from '@/lib/zustand'
import * as CB from '@/models/constraint-builders'
import type * as F from '@/models/filter.models'
import type * as L from '@/models/layer'
import type * as LQY from '@/models/layer-queries.models'
import * as SETTINGS from '@/models/settings.models'
import * as FilterEntityClient from '@/systems/filter-entity.client'
import * as LayerQueriesClient from '@/systems/layer-queries.client'
import type React from 'react'
import * as Rx from 'rxjs'
import * as Zus from 'zustand'

export type ApplyAs = 'regular' | 'inverted' | 'disabled'

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

export type Predicates = Partial<SquadServerFrame.KeyProp>

export type Key = FRM.InstanceKeyOfState<Store>
export type KeyProp = { appliedFilters: Key }

export type Context = 'add' | 'edit' | 'generate'

export type Args = FRM.SetupArgs<{ context: Context; editedLayerId?: L.LayerId; extraFiltersScope?: 'global' | 'local' }, Store>

export function initAppliedFiltersStore(
	args: Args,
) {
	const set = ZusUtils.toPartialSetter(args.set, 'appliedFilters')
	const localScope = args.input.extraFiltersScope === 'local'
	set(
		{
			poolApplyAs: 'regular',
			filterStates: new Map(),
			localExtraFilters: localScope ? new Set<F.FilterEntityId>() : undefined,
		} satisfies AppliedFiltersSlice,
	)

	// filter entities stream in over the websocket after boot, so a frame can be set up before they land (the
	// explore-layers frame is built in the /_app loader). seeding synchronously would drop every configured pool filter
	void (async () => {
		await Rx.firstValueFrom(FilterEntityClient.initializedFilterEntities$())
		if (args.sub.closed) return
		const squadServer = args.get().squadServer
		set(getInitialFilterStates(args.input.context, squadServer, localScope))

		if (args.input.context !== 'edit' || !args.input.editedLayerId || !squadServer) return
		const settings = SquadServerFrame.Sel.settings(ZusUtils.getState(squadServer))
		const membershipConstraints = SETTINGS.getPoolMembershipConstraints(settings)
		if (membershipConstraints.length === 0) return
		// only apply the pool filter once we know the edited layer is in the pool; otherwise the layer being edited
		// would be filtered out of its own dialog
		const outOfPool = await LayerQueriesClient.fetchLayersOutOfPool({
			layerIds: [args.input.editedLayerId],
			constraints: membershipConstraints,
		})
		if (args.sub.closed) return
		set({ poolApplyAs: outOfPool !== null && outOfPool.length === 0 ? 'regular' : 'disabled' })
	})()

	if (!localScope) {
		const unsub = ExtraFiltersStore.subscribe(extraFiltersState => {
			// only extra filters are owned by this store -- the pool's configured filters keep their state
			const poolFilterIds = getDefaultSelectableIds(args.get().squadServer)
			set(state => ({
				filterStates: new Map(
					Gen.filter(state.filterStates, ([id]) => extraFiltersState.extraFilters.has(id) || poolFilterIds.has(id)),
				),
			}))
		})

		args.sub.add(ZusUtils.toRxSub(unsub))
	}
}

function getDefaultSelectableIds(squadServer: SquadServerFrame.Key | undefined) {
	if (!squadServer) return new Set<F.FilterEntityId>()
	const pool = SquadServerFrame.Sel.settings(ZusUtils.getState(squadServer)).queue.mainPool
	return new Set(pool.defaultSelectable.map(c => c.filterId))
}

function getInitialFilterStates(context: Context, squadServer: SquadServerFrame.Key | undefined, localScope = false) {
	const filterStates: AppliedFiltersSlice['filterStates'] = new Map()
	// a locally-scoped instance starts with no extras rather than pulling in the user's saved set
	const extraFilters = localScope ? new Set<F.FilterEntityId>() : ExtraFiltersStore.getState().extraFilters
	for (const filterid of extraFilters) {
		filterStates.set(filterid, 'disabled')
	}
	let poolApplyAs: ApplyAs = 'regular'
	if (squadServer) {
		const pool = SquadServerFrame.Sel.settings(ZusUtils.getState(squadServer)).queue.mainPool
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

// global, localStorage-backed set of extra filters the user has pulled into the applied-filters panel
export const ExtraFiltersStore = Zus.createStore<LQY.ExtraQueryFiltersStore>((set, _get, store) => {
	const extraFilters = new Set(localStorage.getItem('extraQueryFilters:v2')?.split(',') ?? [])
	void (async () => {
		await sleep(0)
		const filterEntities = await Rx.firstValueFrom(FilterEntityClient.initializedFilterEntities$())
		set(state => ({
			...state,
			extraFilters: new Set(Gen.filter(state.extraFilters.values(), f => filterEntities.has(f))),
		}))
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

export namespace Sel {
	export function poolFilterSetting(store: Store): SETTINGS.PoolFilterSetting | null {
		if (!store.squadServer) return null
		return SquadServerFrame.Sel.settings(ZusUtils.getState(store.squadServer)).queue.mainPool.poolFilter
	}

	// the extras set this instance renders and indicates: its own when locally scoped, else the global one
	export function extraFilters(store: Store): Set<F.FilterEntityId> {
		return store.appliedFilters.localExtraFilters ?? ExtraFiltersStore.getState().extraFilters
	}

	export function constraints(store: Store): LQY.Constraint[] {
		const constraints: LQY.Constraint[] = []
		const filterEntities = FilterEntityClient.filterEntities
		const settings = store.squadServer ? SquadServerFrame.Sel.settings(ZusUtils.getState(store.squadServer)) : undefined

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

		const extras = extraFilters(store)
		for (const [filterId, applState] of store.appliedFilters.filterStates.entries()) {
			if (!filterEntities.has(filterId)) continue
			constraints.push(CB.filterEntity('applied-filter:' + filterId, filterId, {
				filterApplState: applState,
				// configured filters get their indication from the indicate lists; extras always indicate
				showIndicator: extras.has(filterId) ? 'both' : 'disabled',
			}))
		}

		return constraints
	}
}

export namespace Actions {
	export function setPoolApplyAs(stores: KeyProp, poolApplyAs: ApplyAs) {
		ZusUtils.toPartialStore(stores.appliedFilters, 'appliedFilters').setState({ poolApplyAs })
	}

	export function setAppliedFilterState(stores: KeyProp, filterId: F.FilterEntityId, applyAs: ApplyAs) {
		ZusUtils.toPartialStore(stores.appliedFilters, 'appliedFilters').setState(state => {
			const filterStates = new Map(state.filterStates)
			filterStates.set(filterId, applyAs)
			return { filterStates }
		})
	}

	export function disableAllAppliedFilters(stores: KeyProp) {
		ZusUtils.toPartialStore(stores.appliedFilters, 'appliedFilters').setState(state => {
			const filterStates = new Map(state.filterStates)
			for (const filterId of filterStates.keys()) {
				filterStates.set(filterId, 'disabled')
			}
			return { filterStates, poolApplyAs: 'disabled' as const }
		})
	}

	export function selectExtraFilters(stores: KeyProp, update: React.SetStateAction<F.FilterEntityId[]>) {
		const state = ZusUtils.getState(stores.appliedFilters)
		const current = state.appliedFilters.localExtraFilters ?? ExtraFiltersStore.getState().extraFilters
		let filterIds = typeof update === 'function' ? update(Array.from(current)) : update
		const squadServer = state.squadServer
		if (squadServer) {
			const pool = SquadServerFrame.Sel.settings(ZusUtils.getState(squadServer)).queue.mainPool
			const configuredIds = new Set([
				...(pool.poolFilter ? [pool.poolFilter.filterId] : []),
				...pool.defaultSelectable.map(c => c.filterId),
			])
			filterIds = filterIds.filter(id => !configuredIds.has(id))
		}
		if (state.appliedFilters.localExtraFilters) {
			const localExtraFilters = new Set(filterIds)
			// mirror the global-scope subscription: dropping an extra drops its applied state too
			const poolFilterIds = getDefaultSelectableIds(squadServer)
			ZusUtils.toPartialStore(stores.appliedFilters, 'appliedFilters').setState(slice => ({
				localExtraFilters,
				filterStates: new Map(
					Gen.filter(slice.filterStates, ([id]) => localExtraFilters.has(id) || poolFilterIds.has(id)),
				),
			}))
			return
		}
		ExtraFiltersStore.setState({
			extraFilters: new Set(filterIds),
		})
	}

	export function removeExtraFilter(filterId: F.FilterEntityId) {
		ExtraFiltersStore.setState(state => ({
			extraFilters: new Set(Gen.filter(state.extraFilters, id => id !== filterId)),
		}))
	}
}
