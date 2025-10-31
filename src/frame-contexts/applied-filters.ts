import * as Gen from '@/lib/generator'
import * as ZusUtils from '@/lib/zustand'
import * as CB from '@/models/constraint-builders'
import * as F from '@/models/filter.models'
import * as LQY from '@/models/layer-queries.models'
import * as QD from '@/systems.client/queue-dashboard'
import * as ServerSettingsClient from '@/systems.client/server-settings.client'
import * as Im from 'immer'
import * as Rx from 'rxjs'

export type ApplyAs = 'regular' | 'inverted' | 'disabled'

export type Predicates = { sub: Rx.Subscription }

export type Store = {
	appliedFilters: Map<F.FilterEntityId, ApplyAs>
	setAppliedFilterState: (filterId: F.FilterEntityId, active: ApplyAs) => void
}

export function initAppliedFiltersStore(
	get: ZusUtils.Getter<Store & Predicates>,
	set: ZusUtils.Setter<Store>,
	poolDefaultDisabled: boolean,
) {
	const setFilterState = (filterId: F.FilterEntityId, newState: 'regular' | 'inverted' | 'disabled') => {
		set(
			storeState =>
				Im.produce(storeState, draft => {
					const activated = draft.appliedFilters
					activated.set(filterId, newState)
				}),
		)
	}
	const initialState: Store['appliedFilters'] = new Map()
	const extraFilters = QD.ExtraFiltersStore.getState().extraFilters
	for (const filterid of extraFilters) {
		initialState.set(filterid, 'disabled')
	}
	if (!poolDefaultDisabled) {
		const poolSettings = ServerSettingsClient.Store.getState().saved.queue.mainPool.filters
		for (const { filterId, applyAs } of poolSettings) {
			initialState.set(filterId, applyAs)
		}
	}

	set({ appliedFilters: initialState, setAppliedFilterState: setFilterState })

	const unsub = QD.ExtraFiltersStore.subscribe(extraFiltersState => {
		set(state => ({
			appliedFilters: new Map(Gen.filter(state.appliedFilters, ([id]) => extraFiltersState.extraFilters.has(id))),
		}))
	})

	get().sub.add(ZusUtils.toRxSub(unsub))
}

export function getAppliedFiltersConstraints(state: Store) {
	const constraints: LQY.Constraint[] = []
	for (const [filterId, applyAs] of state.appliedFilters.entries()) {
		constraints.push(CB.filterEntity('selected-filter', filterId, {
			invert: applyAs === 'inverted',
			filterResults: applyAs !== 'disabled',
			indicateMatches: true,
		}))
	}

	return constraints
}
