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
