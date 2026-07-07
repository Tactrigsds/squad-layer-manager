// Builders for EditableFilterNodes (nodes with possibly-incomplete args), used by the editor UI.
import { assertNever } from '@/lib/type-guards'
import * as F from './filter.models'

export const createBlock = <T extends F.BlockType>(type: T) => {
	return (children?: F.EditableFilterNode[], options: { neg?: boolean } = {}) => {
		return {
			type: type,
			children: children ?? ([] as unknown as F.EditableFilterNode[]),
			neg: options.neg ?? false,
		} as Extract<F.EditableFilterNode, { type: T }>
	}
}

export const and = createBlock('and')
export const or = createBlock('or')

export const applyFilter = (filterId?: F.FilterEntityId, options: { neg?: boolean } = {}) =>
	({
		type: 'apply-filter' as const,
		neg: options.neg ?? false,
		filterId,
	}) satisfies F.EditableFilterNode

// -------- comparison builders --------

const colArg = (column?: string): F.EditableScalarArg => ({ type: 'column', column })

export const eq = (column?: string, value?: F.Value): F.EditableCompNode => ({
	type: 'eq',
	neg: false,
	args: [colArg(column), { type: 'value', value }],
})

export const neq = (column?: string, value?: F.Value): F.EditableCompNode => ({
	type: 'eq',
	neg: true,
	args: [colArg(column), { type: 'value', value }],
})

export const inValues = (column?: string, values?: F.Value[]): F.EditableCompNode => ({
	type: 'in',
	neg: false,
	args: [colArg(column), { type: 'values', values }],
})

export const lt = (column?: string, value?: F.Value): F.EditableCompNode => ({
	type: 'lt',
	neg: false,
	args: [colArg(column), { type: 'value', value }],
})

export const gt = (column?: string, value?: F.Value): F.EditableCompNode => ({
	type: 'gt',
	neg: false,
	args: [colArg(column), { type: 'value', value }],
})

export const inrange = (column?: string, min?: F.Value, max?: F.Value): F.EditableCompNode => ({
	type: 'inrange',
	neg: false,
	args: [colArg(column), { type: 'value', value: min }, { type: 'value', value: max }],
})

// a bare comparison node, seeded to `eq` on the given column (used when adding a comparison in the UI)
export const comp = (column?: string): F.EditableCompNode => eq(column)

export function nodeOfType(type: F.NodeType): F.EditableFilterNode {
	if (F.isCompType(type)) return { type, neg: false, args: [colArg(), { type: 'value' }] } as F.EditableCompNode
	if (type === 'apply-filter') return applyFilter()
	if (F.isBlockType(type)) return createBlock(type)()
	assertNever(type)
}
