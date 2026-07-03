import * as ServerSettingsPartial from '@/frame-partials/server-settings.partial'
import * as SquadServerFrame from '@/frames/squad-server.frame'
import { sleep } from '@/lib/async'
import type * as FRM from '@/lib/frame'
import * as Gen from '@/lib/generator'
import * as Obj from '@/lib/object'
import * as ZusUtils from '@/lib/zustand'
import * as CB from '@/models/constraint-builders'
import type * as F from '@/models/filter.models'
import type * as LQY from '@/models/layer-queries.models'
import * as FilterEntityClient from '@/systems/filter-entity.client'
import type React from 'react'
import * as Rx from 'rxjs'
import * as Zus from 'zustand'

export type ApplyAs = 'regular' | 'inverted' | 'disabled'

export type AppliedFiltersSlice = {
	filterStates: Map<F.FilterEntityId, ApplyAs>
	indicatedFilters: Map<F.FilterEntityId, LQY.IndicatorState>
}

export type Store = {
	appliedFilters: AppliedFiltersSlice
} & Predicates

export type Predicates = Partial<SquadServerFrame.KeyProp>

export type Key = FRM.InstanceKeyOfState<Store>
export type KeyProp = { appliedFilters: Key }

export type Args = FRM.SetupArgs<{ poolDefaultDisabled: boolean }, Store>

export function initAppliedFiltersStore(
	args: Args,
) {
	const set = ZusUtils.toPartialSetter(args.set, 'appliedFilters')
	const { filterStates, indicatedFilters } = getInitialFilterStates(args.input.poolDefaultDisabled, args.get().squadServer)
	if (args.sub.closed) return
	set(
		{
			filterStates,
			indicatedFilters,
		} satisfies AppliedFiltersSlice,
	)

	const unsub = ExtraFiltersStore.subscribe(extraFiltersState => {
		set(state => ({
			filterStates: new Map(Gen.filter(state.filterStates, ([id]) => extraFiltersState.extraFilters.has(id))),
		}))
	})

	args.sub.add(ZusUtils.toRxSub(unsub))
}

function getInitialFilterStates(poolDefaultDisabled: boolean, squadServer: SquadServerFrame.Key | undefined) {
	const filterStates: AppliedFiltersSlice['filterStates'] = new Map()
	const indicatedFilters: AppliedFiltersSlice['indicatedFilters'] = new Map()
	const extraFilters = ExtraFiltersStore.getState().extraFilters
	for (const filterid of extraFilters) {
		filterStates.set(filterid, 'disabled')
	}
	if (!poolDefaultDisabled && squadServer) {
		const poolSettings = SquadServerFrame.Sel.settings(ZusUtils.getState(squadServer)).queue.mainPool.filters
		for (const { filterId, defaultApplyDuringLayerSelection: applyAs, showIndicator } of poolSettings) {
			if (applyAs === 'hidden') continue
			filterStates.set(filterId, applyAs ?? 'disabled')
			indicatedFilters.set(filterId, showIndicator ?? 'disabled')
		}
	}

	const filterEntities = FilterEntityClient.filterEntities
	for (const filterId of [...filterStates.keys()]) {
		const filterEntity = filterEntities.get(filterId)
		if (!filterEntity) {
			filterStates.delete(filterId)
		}
	}
	for (const filterId of [...indicatedFilters.keys()]) {
		const filterEntity = filterEntities.get(filterId)
		if (!filterEntity) {
			indicatedFilters.delete(filterId)
		}
	}

	return { filterStates, indicatedFilters }
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
	export function constraints(store: Store): LQY.Constraint[] {
		const constraints: LQY.Constraint[] = []
		for (const [filterId, applState] of store.appliedFilters.filterStates.entries()) {
			constraints.push(CB.filterEntity('applied-filter:' + filterId, filterId, {
				filterApplState: applState,
				showIndicator: store.appliedFilters.indicatedFilters.get(filterId) ?? 'both',
			}))
		}

		return constraints
	}
}

export namespace Actions {
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
			return { filterStates }
		})
	}

	export function selectExtraFilters(stores: KeyProp, update: React.SetStateAction<F.FilterEntityId[]>) {
		let filterIds = typeof update === 'function' ? update(Array.from(ExtraFiltersStore.getState().extraFilters)) : update
		const filterConfig = ZusUtils.getState(ZusUtils.getState(stores.appliedFilters).squadServer)?.settings.saved.queue.mainPool.filters
		if (filterConfig) {
			filterIds = filterIds.filter(id => !filterConfig.some(filterConfig => filterConfig.filterId === id))
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
