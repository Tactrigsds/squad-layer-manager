import type * as FRM from '@/lib/frame'
import * as Gen from '@/lib/generator'
import * as ZusUtils from '@/lib/zustand'
import * as CB from '@/models/constraint-builders'
import type * as F from '@/models/filter.models'
import type * as LQY from '@/models/layer-queries.models'
import * as FilterEntityClient from '@/systems.client/filter-entity.client'
import * as QD from '@/systems.client/queue-dashboard'
import * as ServerSettingsClient from '@/systems.client/server-settings.client'
import * as Im from 'immer'

export type ApplyAs = 'regular' | 'inverted' | 'disabled'

export type State = {
	appliedFilters: Map<F.FilterEntityId, ApplyAs>
	setAppliedFilterState: (filterId: F.FilterEntityId, active: ApplyAs) => void
	disableAllAppliedFilters: () => void
}

export type Args = FRM.SetupArgs<{ poolDefaultDisabled: boolean }, State>
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
	const states = getInitialFilterStates(args.input.poolDefaultDisabled)
	if (args.sub.closed) return
	set({ appliedFilters: states, setAppliedFilterState: setFilterState, disableAllAppliedFilters: disableAll })

	const unsub = QD.ExtraFiltersStore.subscribe(extraFiltersState => {
		set(state => ({
			appliedFilters: new Map(Gen.filter(state.appliedFilters, ([id]) => extraFiltersState.extraFilters.has(id))),
		}))
	})

	args.sub.add(ZusUtils.toRxSub(unsub))
}

function getInitialFilterStates(poolDefaultDisabled: boolean) {
	const initialState: State['appliedFilters'] = new Map()
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

	const filterEntities = FilterEntityClient.filterEntities
	for (const filterId of initialState.keys()) {
		const filterEntity = filterEntities.get(filterId)
		if (!filterEntity) {
			initialState.delete(filterId)
		}
	}

	return initialState
}

export function getAppliedFiltersConstraints(state: State) {
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
