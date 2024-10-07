import * as M from '@/models'

export const and = (...children: M.FilterNode[]) => {
	return {
		type: 'and' as const,
		children,
	}
}

export const or = (...children: M.FilterNode[]) => {
	if (children.length === 0) return null
	return {
		type: 'or' as const,
		children,
	}
}

export const comp = (comparison: M.Comparison) => ({
	type: 'comp' as const,
	comp: comparison,
})

export const lt = (column: M.FloatColumn, value: number) =>
	comp({
		code: 'lt' as const,
		column,
		value,
	})

export const gt = (column: M.FloatColumn, value: number) =>
	comp({
		code: 'gt' as const,
		column,
		value,
	})

export const inrange = (column: M.FloatColumn, min: number, max: number) =>
	comp({
		code: 'inrange' as const,
		column,
		min,
		max,
	})

export const inValues = (column: M.StringColumn, values: (string | null)[]) =>
	comp({
		code: 'in' as const,
		column,
		values,
	})

export const eq = (column: M.StringColumn, value: string | null) =>
	comp({
		code: 'eq' as const,
		column,
		value,
	})

export const like = (column: M.StringColumn, value: string) =>
	comp({
		code: 'like' as const,
		column,
		value,
	})
