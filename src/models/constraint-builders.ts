import type * as F from '@/models/filter.models'
import type * as LQY from '@/models/layer-queries.models'

export const filterAnon = (id: string, filter: F.FilterNode): LQY.Constraint => ({
	type: 'filter-anon',
	id,
	filter,
	filterApplState: 'regular',
	showIndicator: 'disabled',
})

export const filterEntity = (id: string, filterId: F.FilterEntityId, opts?: {
	showIndicator?: LQY.IndicatorState
	filterApplState?: LQY.FilterApplicationState
	warn?: LQY.FilterApplicationState
}): LQY.Constraint => ({
	type: 'filter-entity',
	id,
	filterId,
	showIndicator: opts?.showIndicator ?? 'disabled',
	filterApplState: opts?.filterApplState ?? 'regular',
	warn: opts?.warn ?? 'disabled',
})

// the single pool-membership constraint. showIndicator stays 'both' even when not applied so queries always
// return per-row membership (row disabling, indicators). opts.applyAs is relative to the POOL, not the filter:
// 'regular' narrows to pool layers, 'inverted' to out-of-pool layers, 'disabled' leaves the pool unapplied.
// warn fires on out-of-pool: a miss for 'include', a match for 'exclude'.
export const poolFilter = (
	filterId: F.FilterEntityId,
	mode: 'include' | 'exclude',
	opts?: { applyAs?: LQY.FilterApplicationState; warn?: boolean },
): Extract<LQY.Constraint, { type: 'filter-entity' }> => {
	const applyAs = opts?.applyAs ?? 'regular'
	const toPool = mode === 'include' ? 'regular' : 'inverted'
	const toOutside = mode === 'include' ? 'inverted' : 'regular'
	return {
		type: 'filter-entity',
		id: 'pool-filter',
		filterId,
		poolFilterMode: mode,
		filterApplState: applyAs === 'disabled' ? 'disabled' : applyAs === 'regular' ? toPool : toOutside,
		showIndicator: 'both',
		warn: opts?.warn ? toOutside : 'disabled',
	}
}

export const repeatRule = (
	id: string,
	rule: LQY.RepeatRule,
	opts?: { filterApplState?: LQY.FilterApplicationState; warn?: boolean },
): LQY.Constraint => ({
	type: 'do-not-repeat',
	id,
	rule,
	showIndicator: 'regular',
	filterApplState: opts?.filterApplState ?? 'inverted',
	warn: opts?.warn ?? true,
})

export const filterMenuItems = (id: string, items: LQY.FilterMenuItem[]): Extract<LQY.Constraint, { type: 'filter-menu-items' }> => ({
	type: 'filter-menu-items',
	id,
	items,
	filterApplState: 'regular',
	showIndicator: 'disabled',
})
