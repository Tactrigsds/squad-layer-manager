// Builders for EditableFilterNodes (nodes with possibly-incomplete args), used by the editor UI.
import { assertNever } from '@/lib/type-guards'

import * as F from './filter.models'

export const createBlock = <T extends F.BlockType>(type: T) => {
	return (children?: F.EditableFilterNode[]) => {
		return {
			type: type,
			children: children ?? ([] as unknown as F.EditableFilterNode[]),
		} as Extract<F.EditableFilterNode, { type: T }>
	}
}

export const and = createBlock('and')
export const or = createBlock('or')
export const nor = createBlock('nor')
export const nand = createBlock('nand')

export const createApplyFilter = <T extends F.ApplyFilterType>(type: T) => {
	return (filterId?: F.FilterEntityId) => ({ type, filterId }) as Extract<F.EditableFilterNode, { type: T }>
}

export const includedIn = createApplyFilter('included-in')
export const excludedFrom = createApplyFilter('excluded-from')

export const createMatchup = <T extends F.MatchupType>(type: T) => {
	return (teams?: [F.MatchupTeamSpec, F.MatchupTeamSpec], locked = false) =>
		({
			type,
			locked,
			teams: teams ?? [{}, {}],
		}) as Extract<F.EditableFilterNode, { type: T }>
}

export const allowMatchups = createMatchup('allow-matchups')
export const disallowMatchups = createMatchup('disallow-matchups')

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

// a blank comparison on `subject`, using the operator its value domain defaults to
export function forSubject(subject: F.EditableScalarArg, domain: F.ValueDomain | undefined): F.EditableCompNode {
	const type = F.defaultCompType(domain)
	const args = F.COMP_TYPE_DEFS[type].argSlots.map((slot, i): F.EditableArg =>
		i === 0 ? subject : slot === 'values' ? { type: 'values' } : { type: 'value' },
	)
	return { type, neg: false, args }
}

export const inValuesForTeamColumn = (
	column: F.TeamColumn,
	quantifier: F.TeamQuantifier = 'either',
	values?: F.Value[],
): F.EditableCompNode => ({
	type: 'in',
	neg: false,
	args: [
		{ type: 'team-column', column, quantifier },
		{ type: 'values', values },
	],
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
	if (F.isApplyFilterType(type)) return createApplyFilter(type)()
	if (F.isMatchupType(type)) return createMatchup(type)()
	if (F.isBlockType(type)) return createBlock(type)()
	assertNever(type)
}

// Carries the values a comparison on a team dimension and a matchup can share across a change from one kind of node
// to the other, onto the fresh `to`. A comparison on Faction (Either) becomes "X vs any team", (Both) "X vs X", and a
// T1 or T2 column a locked matchup with X on that side. Going back, the comparison collects the dimension's values
// from the sides it reads. Any other pair of nodes shares nothing, and `to` is returned as it is.
export function carryOver(from: F.EditableFilterNode, to: F.EditableFilterNode): F.EditableFilterNode {
	if (F.isCompNode(from) && F.isMatchupNode(to)) {
		const comp = from as F.EditableCompNode
		const dimension = F.subjectTeamDimension(comp.args[0] as F.EditableScalarArg | undefined)
		const values = compValues(comp)
		if (!dimension || values.length === 0) return to
		const spec = { [dimension.column]: values }
		const teams: [F.MatchupTeamSpec, F.MatchupTeamSpec] =
			dimension.sides === 'second' ? [{}, spec] : dimension.sides === 'both' ? [spec, { ...spec }] : [spec, {}]
		return { ...(to as F.EditableMatchupNode), teams, locked: dimension.sides === 'first' || dimension.sides === 'second' }
	}
	if (F.isMatchupNode(from) && F.isCompNode(to)) {
		const comp = to as F.EditableCompNode
		const dimension = F.subjectTeamDimension(comp.args[0] as F.EditableScalarArg | undefined)
		if (!dimension || comp.type !== 'in') return to
		const [first, second] = (from as F.EditableMatchupNode).teams
		const sides = dimension.sides === 'first' ? [first] : dimension.sides === 'second' ? [second] : [first, second]
		const values = [...new Set(sides.flatMap((spec) => spec[dimension.column] ?? []))]
		if (values.length === 0) return to
		return { ...comp, args: [comp.args[0], { type: 'values', values }] }
	}
	return to
}

function compValues(comp: F.EditableCompNode): F.Value[] {
	const arg = comp.args[1]
	if (comp.type === 'in' && arg?.type === 'values') return (arg.values ?? []).filter((item) => !F.isColumnListItem(item)) as F.Value[]
	if (comp.type === 'eq' && arg?.type === 'value' && arg.value !== undefined && arg.value !== null) return [arg.value]
	return []
}
