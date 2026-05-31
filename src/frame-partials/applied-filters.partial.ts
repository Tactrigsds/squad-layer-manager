import type * as FRM from '@/lib/frame'
import * as Gen from '@/lib/generator'
import * as ZusUtils from '@/lib/zustand'
import * as CB from '@/models/constraint-builders'
import type * as F from '@/models/filter.models'
import type * as LQY from '@/models/layer-queries.models'
import * as FilterEntityClient from '@/systems/filter-entity.client'
import * as QD from '@/systems/queue-dashboard.client'
import * as ServerSettingsClient from '@/systems/server-settings.client'
import * as Im from 'immer'

export type ApplyAs = 'regular' | 'inverted' | 'disabled'

export type Store = {
	appliedFilters: Map<F.FilterEntityId, ApplyAs>
	setAppliedFilterState: (filterId: F.FilterEntityId, active: ApplyAs) => void
	indicatedFilters: Map<F.FilterEntityId, LQY.IndicatorState>
	disableAllAppliedFilters: () => void
}

export type Args = FRM.SetupArgs<{ poolDefaultDisabled: boolean }, Store>
export type Key = FRM.InstanceKey<FRM.FrameTypes & { state: Store }>
export function initAppliedFiltersStore(
	args: Args,
) {
	const set = args.set
	const setFilterState = (filterId: F.FilterEntityId, newState: 'regular' | 'inverted' | 'disabled') => {
		set(
			storeState =>
				Im.produce(storeState, draft => {
					const activated = draft.appliedFilters
					activated.set(filterId, newState)
				}),
		)
	}
	const disableAll = () => {
		set(
			storeState =>
				Im.produce(storeState, draft => {
					for (const filterId of draft.appliedFilters.keys()) {
						draft.appliedFilters.set(filterId, 'disabled')
					}
				}),
		)
	}
	const { appliedFilters, indicatedFilters } = getInitialFilterStates(args.input.poolDefaultDisabled)
	if (args.sub.closed) return
	set({
		appliedFilters,
		indicatedFilters,
		setAppliedFilterState: setFilterState,
		disableAllAppliedFilters: disableAll,
	})

	const unsub = QD.ExtraFiltersStore.subscribe(extraFiltersState => {
		set(state => ({
			appliedFilters: new Map(Gen.filter(state.appliedFilters, ([id]) => extraFiltersState.extraFilters.has(id))),
		}))
	})

	args.sub.add(ZusUtils.toRxSub(unsub))
}

function getInitialFilterStates(poolDefaultDisabled: boolean) {
	const appliedFilters: Store['appliedFilters'] = new Map()
	const indicatedFilters: Store['indicatedFilters'] = new Map()
	const extraFilters = QD.ExtraFiltersStore.getState().extraFilters
	for (const filterid of extraFilters) {
		appliedFilters.set(filterid, 'disabled')
	}
	if (!poolDefaultDisabled) {
		const poolSettings = ServerSettingsClient.Store.getState().saved.queue.mainPool.filters
		for (const { filterId, defaultApplyDuringLayerSelection: applyAs, showIndicator } of poolSettings) {
			if (applyAs === 'hidden') continue
			appliedFilters.set(filterId, applyAs ?? 'disabled')
			indicatedFilters.set(filterId, showIndicator ?? 'disabled')
		}
	}

	const filterEntities = FilterEntityClient.filterEntities
	for (const filterId of [...appliedFilters.keys()]) {
		const filterEntity = filterEntities.get(filterId)
		if (!filterEntity) {
			appliedFilters.delete(filterId)
		}
	}
	for (const filterId of [...indicatedFilters.keys()]) {
		const filterEntity = filterEntities.get(filterId)
		if (!filterEntity) {
			indicatedFilters.delete(filterId)
		}
	}

	return { appliedFilters, indicatedFilters }
}

export function getAppliedFiltersConstraints(state: Store) {
	const constraints: LQY.Constraint[] = []
	for (const [filterId, applState] of state.appliedFilters.entries()) {
		constraints.push(CB.filterEntity('applied-filter:' + filterId, filterId, {
			filterApplState: applState,
			showIndicator: state.indicatedFilters.get(filterId) ?? 'both',
		}))
	}

	return constraints
}
