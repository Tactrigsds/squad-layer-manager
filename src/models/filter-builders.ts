// Builders for validated FilterNodes. Comparison builders accept either raw values (coerced to
// value args) or explicit Arg objects, so `eq('Map', 'Narva')` and `eq(col('Faction_1'), col('Faction_2'))`
// both work.
import type * as F from './filter.models'

// -------- arg helpers --------

export const col = (column: string): F.ColumnArg => ({ type: 'column', column })
export const teamCol = (column: F.TeamColumn, quantifier: F.TeamQuantifier = 'either'): F.TeamColumnArg => ({
	type: 'team-column',
	column,
	quantifier,
})
export const val = (value: F.Value): F.ValueArg => ({ type: 'value', value })
export const vals = (values: F.Value[]): F.ValuesArg => ({ type: 'values', values })

type ScalarInput = F.ScalarArg | F.Value
type ColumnInput = F.ColumnArg | F.TeamColumnArg | string

function toScalarArg(input: ScalarInput): F.ScalarArg {
	if (input !== null && typeof input === 'object' && 'type' in input) return input
	return { type: 'value', value: input }
}
function toColumnArg(input: ColumnInput): F.ColumnArg | F.TeamColumnArg {
	if (typeof input === 'string') return { type: 'column', column: input }
	return input
}

// -------- block builders --------

export const and = (children: F.FilterNode[], options: { neg?: boolean } = {}): F.FilterNode => ({
	type: 'and',
	children,
	neg: options.neg ?? false,
})

export const or = (children: F.FilterNode[], options: { neg?: boolean } = {}): F.FilterNode => ({
	type: 'or',
	children,
	neg: options.neg ?? false,
})

export const applyFilter = (filterId: string, options: { neg?: boolean } = {}): F.FilterNode => ({
	type: 'apply-filter',
	neg: options.neg ?? false,
	filterId,
})

// -------- comparison builders --------

export const eq = (column: ColumnInput, value: ScalarInput, options: { neg?: boolean } = {}): F.FilterNode => ({
	type: 'eq',
	neg: options.neg ?? false,
	args: [toColumnArg(column), toScalarArg(value)],
})

export const neq = (column: ColumnInput, value: ScalarInput): F.FilterNode => eq(column, value, { neg: true })

export const inValues = (column: ColumnInput, values: F.Value[], options: { neg?: boolean } = {}): F.FilterNode => ({
	type: 'in',
	neg: options.neg ?? false,
	args: [toColumnArg(column), { type: 'values', values }],
})

export const notInValues = (column: ColumnInput, values: F.Value[]): F.FilterNode => inValues(column, values, { neg: true })

export const lt = (column: ColumnInput, value: ScalarInput, options: { neg?: boolean } = {}): F.FilterNode => ({
	type: 'lt',
	neg: options.neg ?? false,
	args: [toColumnArg(column), toScalarArg(value)],
})

export const gt = (column: ColumnInput, value: ScalarInput, options: { neg?: boolean } = {}): F.FilterNode => ({
	type: 'gt',
	neg: options.neg ?? false,
	args: [toColumnArg(column), toScalarArg(value)],
})

export const inrange = (column: ColumnInput, min: ScalarInput, max: ScalarInput, options: { neg?: boolean } = {}): F.FilterNode => ({
	type: 'inrange',
	neg: options.neg ?? false,
	args: [toColumnArg(column), toScalarArg(min), toScalarArg(max)],
})

export const isNull = (column: ColumnInput, options: { neg?: boolean } = {}): F.FilterNode => eq(column, null, options)

export const isTrue = (column: ColumnInput): F.FilterNode => eq(column, true)
