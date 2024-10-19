import * as M from '@/models'

// claude likes curry I guess
export const createBlock = <T extends M.BlockType>(type: T) => {
	return <C extends M.EditableFilterNode[]>(children?: C, options: { neg?: boolean } = {}) => {
		return {
			type: type,
			children: children ?? ([] as unknown as C),
			neg: options.neg ?? false,
		} as Extract<M.EditableFilterNode, { type: T }>
	}
}

// beta type assertions, weird issues with EditableFilterNode type and generics
export const and = createBlock('and')
export const or = createBlock('or')

export const comp = <T extends M.EditableComparison>(comparison?: T, options: { neg?: boolean } = {}) =>
	({
		type: 'comp' as const,
		comp: comparison ?? ({} as T),
		neg: options.neg ?? false,
	}) satisfies M.EditableFilterNode

export const applyFilter = (filterId?: string, options: { neg?: boolean } = {}) =>
	({
		type: 'apply-filter' as const,
		neg: options.neg ?? false,
		filterId,
	}) satisfies M.EditableFilterNode

export const lt = (column?: M.FloatColumn, value?: number) =>
	({
		code: 'lt' as const,
		column,
		value,
	}) satisfies M.EditableComparison

export const gt = (column?: M.FloatColumn, value?: number) =>
	({
		code: 'gt' as const,
		column,
		value,
	}) satisfies M.EditableComparison

export const inrange = (column?: M.FloatColumn, min?: number, max?: number) =>
	({
		code: 'inrange' as const,
		column,
		min,
		max,
	}) satisfies M.EditableComparison

export const inValues = <T extends M.StringColumn>(column?: T, values?: M.Layer[T][]) =>
	({
		code: 'in' as const,
		column,
		values,
	}) satisfies M.EditableComparison

export const eq = <T extends M.StringColumn>(column?: T, value?: M.Layer[T]) =>
	({
		code: 'eq' as const,
		column,
		value,
	}) satisfies M.EditableComparison

export const like = <T extends M.StringColumn>(column?: T, value?: M.Layer[T]) =>
	({
		code: 'like' as const,
		column,
		value,
	}) satisfies M.EditableComparison
