import type * as F from './filter.models'

export const and = <T extends F.FilterNode>(children: T[], options: { neg?: boolean } = {}) => {
	return {
		type: 'and' as const,
		children,
		neg: options.neg ?? false,
	} satisfies F.FilterNode
}

export const or = <T extends F.FilterNode>(children: T[], options: { neg?: boolean } = {}) => {
	return {
		type: 'or' as const,
		children,
		neg: options.neg ?? false,
	} satisfies F.FilterNode
}

export const comp = <T extends F.Comparison>(comparison: T, options: { neg?: boolean } = {}) =>
	({
		type: 'comp' as const,
		comp: comparison,
		neg: options.neg ?? false,
	}) satisfies F.FilterNode

export const applyFilter = (filterId: string, options: { neg?: boolean } = {}) =>
	({
		type: 'apply-filter' as const,
		neg: options.neg ?? false,
		filterId,
	}) satisfies F.FilterNode

export const lt = (column: string, value: number) =>
	({
		code: 'lt' as const,
		column,
		value,
	}) satisfies F.Comparison

export const gt = (column: string, value: number) =>
	({
		code: 'gt' as const,
		column,
		value,
	}) satisfies F.Comparison

export const inrange = (column: string, first: number, second: number) =>
	({
		code: 'inrange' as const,
		column,
		range: [first, second],
	}) satisfies F.Comparison

export const inValues = (column: string, values: string[]) =>
	({
		code: 'in' as const,
		column,
		values,
	}) satisfies F.Comparison

export const eq = (column: string, value: string) =>
	({
		code: 'eq' as const,
		column,
		value,
	}) satisfies F.Comparison

export const isTrue = (column: string) =>
	({
		code: 'is-true' as const,
		column,
	}) satisfies F.Comparison

export function allowMatchups(mode: F.FactionMaskMode, allMasks: F.FactionMask[][], neg?: boolean): F.FilterNode {
	return {
		type: 'allow-matchups',
		allowMatchups: {
			mode,
			allMasks,
		},
		neg: neg ?? false,
	}
}
