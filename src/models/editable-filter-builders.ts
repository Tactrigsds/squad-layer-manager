import * as F from './filter.models'
import * as LC from './layer-columns'

// claude likes curry I guess
export const createBlock = <T extends F.BlockType>(type: T) => {
	return <C extends F.EditableFilterNode[]>(children?: C, options: { neg?: boolean } = {}) => {
		return {
			type: type,
			children: children ?? ([] as unknown as C),
			neg: options.neg ?? false,
		} as Extract<F.EditableFilterNode, { type: T }>
	}
}

// beta type assertions, weird issues with EditableFilterNode type and generics
export const and = createBlock('and')
export const or = createBlock('or')

export const comp = <T extends F.EditableComparison>(comparison?: T, options: { neg?: boolean } = {}) =>
	({
		type: 'comp' as const,
		comp: comparison ?? ({} as T),
		neg: options.neg ?? false,
	}) satisfies F.EditableFilterNode

export const applyFilter = (filterId?: F.FilterEntityId, options: { neg?: boolean } = {}) =>
	({
		type: 'apply-filter' as const,
		neg: options.neg ?? false,
		filterId,
	}) satisfies F.EditableFilterNode

export const lt = (column?: string, value?: number) =>
	({
		code: 'lt' as const,
		column,
		value,
	}) satisfies F.EditableComparison

export const gt = (column?: string, value?: number) =>
	({
		code: 'gt' as const,
		column,
		value,
	}) satisfies F.EditableComparison

export const inrange = (column?: string, first?: number, second?: number) =>
	({
		code: 'inrange' as const,
		column,
		range: [first, second],
	}) satisfies F.EditableComparison

export const inValues = (column?: string, values?: string[]) =>
	({
		code: 'in' as const,
		column,
		values,
	}) satisfies F.EditableComparison

export const eq = (column?: string, value?: string) =>
	({
		code: 'eq' as const,
		column,
		value,
	}) satisfies F.EditableComparison

export const neq = (column?: string, value?: string) =>
	({
		code: 'neq' as const,
		column,
		value,
	}) satisfies F.EditableComparison

export const factionsAllowMatchups = (column?: string, allMasks?: F.FactionMask[][]) =>
	({
		code: 'factions:allow-matchups' as const,
		column,
		allMasks,
	}) satisfies F.EditableComparison

export const CODE_TO_EFB = {
	lt,
	gt,
	inrange,
	inValues,
	eq,
	neq,
	in: inValues,
	'factions:allow-matchups': factionsAllowMatchups,
}
