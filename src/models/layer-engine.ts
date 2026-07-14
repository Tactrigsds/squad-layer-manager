import { assertNever } from '@/lib/type-guards'
import type * as CS from '@/models/context-shared'
import * as F from '@/models/filter.models'
import * as LC from '@/models/layer-columns'

// The request/response shapes of the layer query engine (layer-engine/), and the lowering from a filter tree into the IR it
// executes.
//
// Lowering stays here rather than in Rust on purpose: team columns, enum mapping, null-as-an-enum-index, and the
// forgiveness of reversed range bounds are all decisions the SQL backend already makes, and duplicating them in
// another language is how the two would drift apart. The engine only sees primitive comparisons over column indices
// and db-encoded values.

export type Ir =
	| { op: 'and' | 'or'; children: Ir[] }
	| { op: 'not'; child: Ir }
	| { op: 'true' | 'false' }
	| { op: 'is_null'; col: number }
	| { op: 'eq_val' | 'lt_val' | 'gt_val' | 'ge_val' | 'le_val'; col: number; val: number }
	| { op: 'in_vals'; col: number; vals: number[] }
	| { op: 'eq_col' | 'lt_col' | 'gt_col'; col: number; other: number }

// a pick step, with the packing spelled out in the request so the engine and LC.packStepKey can't drift
export type StepSpec = {
	cols1: number[]
	radices1: number[]
	cols2?: number[]
	radices2?: number[]
	weights: { key: number; weight: number }[]
}

export type GenSpec = {
	steps: StepSpec[]
	defaultWeight: number
	seed: number
	numLayers: number
}

export type Sort =
	| { column: { col: number; dir: 'ASC' | 'DESC' | 'ASC:ABS' | 'DESC:ABS' } }
	| { random: GenSpec & { excludeIds: number[] } }

export type Request =
	| { kind: 'select'; where: Ir | null; indicators: Ir[]; sort: Sort | null; pageIndex: number; pageSize: number; columns: number[] }
	| { kind: 'distinct'; where: Ir | null; col: number }
	| { kind: 'matches'; filters: Ir[]; ids: number[] }
	| { kind: 'info'; id: number; columns: number[] }
	| { kind: 'ranges'; columns: number[] }
	| { kind: 'groupCounts'; where: Ir | null; step: StepSpec }

export type SelectResponse = { totalCount: number; rows: (number | null)[][]; indicators: boolean[][] }
export type MatchesResponse = { exists: boolean[]; matches: boolean[][] }
export type RangeResponse = { col: number; min: number | null; max: number | null }
export type GroupCount = { key: number; count: number }

export type ColumnIndex = (name: string) => number

// what the query layer needs of an engine instance. The wasm host (systems/layer-engine.shared.ts) implements it; the
// context depends on this type rather than the class so models don't reach into systems.
export type EngineHandle = {
	readonly rowCount: number
	columnIndex: (name: string) => number
	query: <T>(request: Request) => T
}

export type LowerResult = { code: 'ok'; ir: Ir } | F.InvalidFilterNodeResult

// ---------------------------- filter -> IR ----------------------------

export type LowerCtx = CS.Filters & CS.EffectiveColumnConfig & { colIndex: ColumnIndex }

// Errors are collected against the node path rather than thrown, because the filter editor highlights the offending
// node from them. This mirrors getFilterNodeSQLConditions: same error types, same paths, so the UI behaves the same
// whichever backend produced them.
export function lowerFilterNode(ctx: LowerCtx, node: F.FilterNode, path: string[] = [], appliedFilters: string[] = []): LowerResult {
	const errors: F.NodeValidationError[] = []
	const ir = lowerNode(ctx, node, path, appliedFilters, errors)
	if (errors.length > 0) return { code: 'err:invalid-node', errors }
	return { code: 'ok', ir: ir! }
}

export function and(children: Ir[]): Ir {
	if (children.length === 0) return { op: 'true' }
	if (children.length === 1) return children[0]
	return { op: 'and', children }
}

export function not(child: Ir): Ir {
	return { op: 'not', child }
}

function lowerNode(
	ctx: LowerCtx,
	node: F.FilterNode,
	path: string[],
	appliedFilters: string[],
	errors: F.NodeValidationError[],
): Ir | undefined {
	if (F.isCompNode(node)) {
		const ir = lowerComp(ctx, node, path, errors)
		// only comp nodes carry a `neg` flag; blocks and apply-filters fold negation into their type
		if (ir && node.neg) return not(ir)
		return ir
	}

	if (F.isApplyFilterNode(node)) {
		const filterPath = [...path, 'filterId']
		if (appliedFilters.includes(node.filterId)) {
			errors.push({
				path: filterPath,
				filterId: node.filterId,
				type: 'recursive-filter',
				msg: 'Filter is mutually recursive via filter: ' + node.filterId,
			})
			return undefined
		}
		const entity = ctx.filters.get(node.filterId)
		if (!entity) {
			errors.push({
				path: filterPath,
				filterId: node.filterId,
				type: 'unknown-filter',
				msg: `Filter ${node.filterId} doesn't exist`,
			})
			return undefined
		}
		// referenced filters are inlined, so the engine only ever sees one self-contained tree
		const inner = lowerNode(ctx, entity.filter as F.FilterNode, filterPath, [...appliedFilters, node.filterId], errors)
		if (!inner) return undefined
		return F.APPLY_FILTER_TYPE_NEGATED[node.type] ? not(inner) : inner
	}

	if (F.isBlockNode(node)) {
		const childrenPath = [...path, 'children']
		const children: Ir[] = []
		for (let i = 0; i < node.children.length; i++) {
			const child = lowerNode(ctx, node.children[i], [...childrenPath, i.toString()], appliedFilters, errors)
			if (child) children.push(child)
		}
		const semantics = F.BLOCK_TYPE_SEMANTICS[node.type]
		const base: Ir = children.length === 0
			? (semantics.conjunction ? { op: 'true' } : { op: 'false' })
			: { op: semantics.conjunction ? 'and' : 'or', children }
		return semantics.negated ? not(base) : base
	}

	errors.push({ type: 'invalid-node', path, msg: `Unhandled filter node type` })
	return undefined
}

function lowerComp(ctx: LowerCtx, node: F.CompNode, path: string[], errors: F.NodeValidationError[]): Ir | undefined {
	const subject = node.args[0] as F.Arg | undefined
	if (subject?.type !== 'column' && subject?.type !== 'team-column') {
		errors.push({ type: 'invalid-node', path, msg: "A comparison's first operand must be a column" })
		return undefined
	}
	// a comparison referencing a team-generic column expands over both teams, combined per the column's quantifier
	const teamArg = (node.args as F.Arg[]).find((arg) => arg.type === 'team-column') as F.TeamColumnArg | undefined
	if (!teamArg) return lowerCompForTeam(ctx, node, path, undefined, errors)
	const team1 = lowerCompForTeam(ctx, node, path, 1, errors)
	// both teams resolve to columns of the same enum mapping, so team 2 reports the same errors; drop them rather
	// than listing every problem twice
	const team2 = lowerCompForTeam(ctx, node, path, 2, [])
	if (!team1 || !team2) return undefined
	return { op: teamArg.quantifier === 'both' ? 'and' : 'or', children: [team1, team2] }
}

function lowerCompForTeam(
	ctx: LowerCtx,
	node: F.CompNode,
	path: string[],
	team: 1 | 2 | undefined,
	errors: F.NodeValidationError[],
): Ir | undefined {
	const subject = resolveColumn(ctx, node.args[0] as F.Arg, team, path, errors)
	if (subject === undefined) return undefined
	const col = columnIndex(ctx, subject, path, errors)
	if (col === undefined) return undefined
	const subjectDomain = F.columnValueDomain(subject, ctx.effectiveColsConfig)

	// the other operand of a comparison: another column, or a value encoded against the subject's mapping
	const operand = (arg: F.ScalarArg): { col: number } | { val: number | null } | undefined => {
		if (arg.type === 'column' || arg.type === 'team-column') {
			const name = resolveColumn(ctx, arg, team, path, errors)
			if (name === undefined) return undefined
			const other = columnIndex(ctx, name, path, errors)
			if (other === undefined) return undefined
			const domain = F.columnValueDomain(name, ctx.effectiveColsConfig)
			if (subjectDomain && domain && !F.domainsCompatible(subjectDomain, domain)) {
				errors.push({
					type: 'invalid-node',
					path,
					msg: `Columns ${subject} and ${name} are not comparable (different data types)`,
				})
				return undefined
			}
			return { col: other }
		}
		return { val: scalarValue(ctx, subject, arg.value, path, errors) }
	}

	switch (node.type) {
		case 'eq': {
			const other = operand(node.args[1])
			if (!other) return undefined
			if ('col' in other) return { op: 'eq_col', col, other: other.col }
			// a null value is an IS NULL test, except on an enum column that maps null to a concrete index
			return other.val === null ? { op: 'is_null', col } : { op: 'eq_val', col, val: other.val }
		}
		case 'in': {
			// constants collapse into one membership pass; column items and null stay separate disjuncts
			const constants: number[] = []
			const children: Ir[] = []
			for (const item of node.args[1].values) {
				if (item === null) {
					const nullIndex = enumNullIndex(ctx, subject)
					if (nullIndex === null) children.push({ op: 'is_null', col })
					else constants.push(nullIndex)
					continue
				}
				if (F.isColumnListItem(item)) {
					const other = columnIndex(ctx, item.column, path, errors)
					if (other === undefined) continue
					const domain = F.columnValueDomain(item.column, ctx.effectiveColsConfig)
					if (subjectDomain && domain && !F.domainsCompatible(subjectDomain, domain)) {
						errors.push({
							type: 'invalid-node',
							path,
							msg: `Columns ${subject} and ${item.column} are not comparable (different data types)`,
						})
						continue
					}
					children.push({ op: 'eq_col', col, other })
					continue
				}
				const value = encodeValue(ctx, subject, item, path, errors)
				if (value !== undefined) constants.push(value)
			}
			if (constants.length > 0) children.unshift({ op: 'in_vals', col, vals: constants })
			if (children.length === 0) return { op: 'false' }
			return children.length === 1 ? children[0] : { op: 'or', children }
		}
		case 'lt':
		case 'gt': {
			const other = operand(node.args[1])
			if (!other) return undefined
			if ('col' in other) return { op: node.type === 'lt' ? 'lt_col' : 'gt_col', col, other: other.col }
			if (other.val === null) {
				errors.push({ type: 'invalid-node', path, msg: 'Ordered comparison cannot use null' })
				return { op: 'false' }
			}
			return { op: node.type === 'lt' ? 'lt_val' : 'gt_val', col, val: other.val }
		}
		case 'inrange': {
			const lo = operand(node.args[1])
			const hi = operand(node.args[2])
			if (!lo || !hi) return undefined
			if (!('val' in lo) || !('val' in hi) || lo.val === null || hi.val === null) {
				errors.push({ type: 'invalid-node', path, msg: 'Range comparison cannot use null' })
				return { op: 'false' }
			}
			// reversed constant bounds are forgiven, matching the SQL backend; prod filters rely on it
			const [low, high] = lo.val > hi.val ? [hi.val, lo.val] : [lo.val, hi.val]
			return { op: 'and', children: [{ op: 'ge_val', col, val: low }, { op: 'le_val', col, val: high }] }
		}
		default:
			assertNever(node)
	}
}

function resolveColumn(
	ctx: LowerCtx,
	arg: F.Arg,
	team: 1 | 2 | undefined,
	path: string[],
	errors: F.NodeValidationError[],
): string | undefined {
	if (arg.type === 'team-column') {
		if (team === undefined) {
			errors.push({ type: 'invalid-node', path, msg: `Team column "${arg.column}" could not be resolved to a team` })
			return undefined
		}
		return F.resolveTeamColumn(arg.column, team)
	}
	if (arg.type === 'column') return arg.column
	errors.push({ type: 'invalid-node', path, msg: 'Comparison requires at least one column operand' })
	return undefined
}

function columnIndex(ctx: LowerCtx, column: string, path: string[], errors: F.NodeValidationError[]): number | undefined {
	if (!LC.getColumnDef(column, ctx.effectiveColsConfig)) {
		errors.push({ type: 'unmapped-column', column, path, msg: `Column ${column} is not mapped` })
		return undefined
	}
	return ctx.colIndex(column)
}

// null on an enum column that carries null as a mapped value (e.g. LayerVersion's "no version") is a real index, not
// SQL NULL
function enumNullIndex(ctx: LowerCtx, column: string): number | null {
	const def = LC.getColumnDef(column, ctx.effectiveColsConfig)
	if (def?.type !== 'string' || !def.enumMapping) return null
	const mapped = LC.dbValue(column, null, ctx)
	return LC.isUnmappedDbValue(mapped) || mapped === null ? null : Number(mapped)
}

function scalarValue(
	ctx: LowerCtx,
	column: string,
	value: F.Value,
	path: string[],
	errors: F.NodeValidationError[],
): number | null {
	if (value === null) return enumNullIndex(ctx, column)
	const encoded = encodeValue(ctx, column, value, path, errors)
	return encoded ?? null
}

function encodeValue(
	ctx: LowerCtx,
	column: string,
	value: NonNullable<F.Value>,
	path: string[],
	errors: F.NodeValidationError[],
): number | undefined {
	const encoded = LC.dbValue(column, value, ctx)
	if (LC.isUnmappedDbValue(encoded) || encoded === null || encoded === undefined) {
		errors.push({ type: 'unmapped-value', path, column, value, msg: `Value ${value} is not mapped for column ${column}` })
		return undefined
	}
	if (typeof encoded === 'boolean') return encoded ? 1 : 0
	return Number(encoded)
}
