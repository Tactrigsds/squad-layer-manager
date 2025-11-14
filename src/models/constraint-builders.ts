import * as F from '@/models/filter.models'
import * as LQY from '@/models/layer-queries.models'

export const filterAnon = (id: string, filter: F.FilterNode): LQY.Constraint => ({
	type: 'filter-anon',
	id,
	filter,
	filterResults: true,
	indicateMatches: false,
	invert: false,
})

export const filterEntity = (idPrefix: string, filterId: F.FilterEntityId, opts?: {
	indicateMatches?: boolean
	invert?: boolean
	filterResults?: boolean
}): LQY.Constraint => ({
	type: 'filter-entity',
	id: idPrefix + ':' + filterId,
	filterId,
	indicateMatches: opts?.indicateMatches ?? true,
	filterResults: opts?.filterResults ?? true,
	invert: opts?.invert ?? false,
})

export const repeatRule = (
	idPrefix: string,
	rule: LQY.RepeatRule,
	opts?: { filterResults?: boolean; invert?: boolean },
): LQY.Constraint => ({
	type: 'do-not-repeat',
	id: idPrefix + ':' + (rule.label ?? rule.field),
	rule,
	indicateMatches: true,
	filterResults: opts?.filterResults ?? true,
	invert: opts?.invert ?? true,
})
