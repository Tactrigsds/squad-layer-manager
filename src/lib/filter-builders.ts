import * as M from '@/models'

export const and = (children: M.FilterNode[], neg = false) => {
	return {
		type: 'and' as const,
		children,
		neg,
	}
}

export const or = (children: M.FilterNode[], neg = false) => {
	if (children.length === 0) return null
	return {
		type: 'or' as const,
		children,
		neg,
	}
}

export const comp = (comparison: M.Comparison, neg = false) => ({
	type: 'comp' as const,
	comp: comparison,
	neg,
})

export const lt = (column: M.FloatColumn, value: number, neg = false) =>
	comp(
		{
			code: 'lt' as const,
			column,
			value,
		},
		neg
	)

export const gt = (column: M.FloatColumn, value: number, neg = false) =>
	comp(
		{
			code: 'gt' as const,
			column,
			value,
		},
		neg
	)

export const inrange = (column: M.FloatColumn, min: number, max: number, neg = false) =>
	comp(
		{
			code: 'inrange' as const,
			column,
			min,
			max,
		},
		neg
	)

export const inValues = (column: M.StringColumn, values: (string | null)[], neg = false) =>
	comp(
		{
			code: 'in' as const,
			column,
			values,
		},
		neg
	)

export const eq = (column: M.StringColumn, value: string | null, neg = false) =>
	comp(
		{
			code: 'eq' as const,
			column,
			value,
		},
		neg
	)

export const like = (column: M.StringColumn, value: string, neg = false) =>
	comp(
		{
			code: 'like' as const,
			column,
			value,
		},
		neg
	)
