import * as M from '@/models'

export const and = <T extends M.FilterNode>(children: T[], options: { neg?: boolean } = {}) => {
	return {
		type: 'and' as const,
		children,
		neg: options.neg ?? false,
	} satisfies M.FilterNode
}

export const or = <T extends M.FilterNode>(children: T[], options: { neg?: boolean } = {}) => {
	if (children.length === 0) return null
	return {
		type: 'or' as const,
		children,
		neg: options.neg ?? false,
	} satisfies M.FilterNode
}

export const comp = <T extends M.Comparison>(comparison: T, options: { neg?: boolean } = {}) =>
	({
		type: 'comp' as const,
		comp: comparison,
		neg: options.neg ?? false,
	}) satisfies M.FilterNode

export const applyFilter = (filterId: string, options: { neg?: boolean } = {}) =>
	({
		type: 'apply-filter' as const,
		neg: options.neg ?? false,
		filterId,
	}) satisfies M.FilterNode

export const lt = <T extends M.FloatColumn>(column: T, value: number) =>
	({
		code: 'lt' as const,
		column,
		value,
	}) satisfies M.Comparison

export const gt = <T extends M.FloatColumn>(column: T, value: number) =>
	({
		code: 'gt' as const,
		column,
		value,
	}) satisfies M.Comparison

export const inrange = <T extends M.FloatColumn>(column: T, first: number, second: number) =>
	({
		code: 'inrange' as const,
		column,
		range: [first, second],
	}) satisfies M.Comparison

export const inValues = <T extends M.StringColumn>(column: T, values: M.Layer[T][]) =>
	({
		code: 'in' as const,
		column,
		values,
	}) satisfies M.Comparison

export const eq = <T extends M.StringColumn>(column: T, value: M.Layer[T]) =>
	({
		code: 'eq' as const,
		column,
		value,
	}) satisfies M.Comparison

export const like = <T extends M.StringColumn>(column: T, value: string) =>
	({
		code: 'like' as const,
		column,
		value,
	}) satisfies M.Comparison

export const hasAll = <T extends M.CollectionColumn>(column: T, values: string[]) =>
	({
		code: 'has' as const,
		column,
		values,
	}) satisfies M.Comparison

export const isTrue = <T extends M.BooleanColumn>(column: T, options: { neg?: boolean } = {}) =>
	({
		code: 'is-true' as const,
		column,
		neg: options.neg ?? false,
	}) satisfies M.Comparison
