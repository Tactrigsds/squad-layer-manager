import type * as SchemaModels from '$root/drizzle/schema.models'
import * as CD from '@/lib/ctx-def'
import { createId } from '@/lib/id'
import * as Obj from '@/lib/object-utils'
import { assertNever } from '@/lib/type-guards'
import { z } from '@/lib/zod'
// Filter nodes form a small expression AST. Every node's `type` is an operator: block operators
// (and/or/nor/nand) take child nodes, comparison operators take argument terms (columns,
// constants, team-generic columns), and apply-filter operators (included-in/excluded-from) reference
// another filter entity.
import type * as AppEvents from '@/models/app-events.models'
import type * as CS from '@/models/context-shared'
import type * as Msgs from '@/models/messages.models'

import * as LC from './layer-columns'

// -------- values & argument terms --------

export const ValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()])
export type Value = z.infer<typeof ValueSchema>

// columns that exist as a _1/_2 pair. A 'team-column' arg references the pair team-generically; its
// `quantifier` expands the comparison over both teams: 'either' => team1-cond OR team2-cond,
// 'both' => team1-cond AND team2-cond
export const TEAM_COLUMN_PAIRS = {
	Alliance: ['Alliance_1', 'Alliance_2'],
	Faction: ['Faction_1', 'Faction_2'],
	Unit: ['Unit_1', 'Unit_2'],
	Vehicle: ['Vehicle_1', 'Vehicle_2'],
	VehicleType: ['VehicleType_1', 'VehicleType_2'],
} as const

export const TeamColumnSchema = z.enum(['Alliance', 'Faction', 'Unit', 'Vehicle', 'VehicleType'])
export type TeamColumn = z.infer<typeof TeamColumnSchema>
export const TEAM_COLUMNS = TeamColumnSchema.options

// team columns whose pair exists as physical artifact columns. The vehicle pairs are virtual (they lower
// into unit-record membership), so anything that queries a pair column directly, e.g. the possible-value
// menu items behind the backburner request dialog, is restricted to these.
export const PHYSICAL_TEAM_COLUMNS = ['Alliance', 'Faction', 'Unit'] as const satisfies TeamColumn[]
export type PhysicalTeamColumn = (typeof PHYSICAL_TEAM_COLUMNS)[number]

export const TeamQuantifierSchema = z.enum(['either', 'both'])
export type TeamQuantifier = z.infer<typeof TeamQuantifierSchema>

export function resolveTeamColumn(column: TeamColumn, team: 1 | 2): string {
	return TEAM_COLUMN_PAIRS[column][team - 1]
}

export const ColumnArgSchema = z.object({ type: z.literal('column'), column: z.string() })
export const TeamColumnArgSchema = z.object({ type: z.literal('team-column'), column: TeamColumnSchema, quantifier: TeamQuantifierSchema })
export const ValueArgSchema = z.object({ type: z.literal('value'), value: ValueSchema })

// an item in an `in` operator's list: a constant value or a reference to another column. bare
// primitives (the historical shape) stay valid, so existing `in` nodes need no migration.
export const InListItemSchema = z.union([ValueSchema, ColumnArgSchema])
export const ValuesArgSchema = z.object({ type: z.literal('values'), values: z.array(InListItemSchema) })

export const ScalarArgSchema = z.discriminatedUnion('type', [ColumnArgSchema, TeamColumnArgSchema, ValueArgSchema])

// the first operand of every comparison (the "subject") must be a column, never a bare constant: the
// builder models arg[0] as the subject column, so value-first or all-constant comparisons (e.g. two
// constants) are unrepresentable there. Constraining it structurally keeps both validation paths in sync
// and loses no expressiveness -- a value-first comparison always has a column-first equivalent (symmetric
// for eq/in; flip the operator for lt/gt).
export const SubjectArgSchema = z.discriminatedUnion('type', [ColumnArgSchema, TeamColumnArgSchema])

export type ColumnArg = z.infer<typeof ColumnArgSchema>
export type TeamColumnArg = z.infer<typeof TeamColumnArgSchema>
export type ValueArg = z.infer<typeof ValueArgSchema>
export type InListItem = z.infer<typeof InListItemSchema>
export type ValuesArg = z.infer<typeof ValuesArgSchema>
export type ScalarArg = z.infer<typeof ScalarArgSchema>
export type SubjectArg = z.infer<typeof SubjectArgSchema>
export type Arg = ScalarArg | ValuesArg

// distinguishes a column reference from a constant value within an `in` list
export function isColumnListItem(item: InListItem): item is ColumnArg {
	return typeof item === 'object' && item !== null && (item as ColumnArg).type === 'column'
}

// -------- operators --------

export const COMP_TYPES = ['eq', 'in', 'lt', 'gt', 'inrange'] as const
export type CompType = (typeof COMP_TYPES)[number]

export type CompTypeDef = {
	displayName: string
	negDisplayName: string
	// domain kind the anchor column must support
	domain: 'any' | 'number'
	argSlots: ('scalar' | 'values')[]
}

export const COMP_TYPE_DEFS: Record<CompType, CompTypeDef> = {
	eq: { displayName: '=', negDisplayName: '!=', domain: 'any', argSlots: ['scalar', 'scalar'] },
	in: { displayName: 'in', negDisplayName: 'not in', domain: 'any', argSlots: ['scalar', 'values'] },
	lt: { displayName: '<', negDisplayName: '>=', domain: 'number', argSlots: ['scalar', 'scalar'] },
	gt: { displayName: '>', negDisplayName: '<=', domain: 'number', argSlots: ['scalar', 'scalar'] },
	inrange: { displayName: '[..]', negDisplayName: '![..]', domain: 'number', argSlots: ['scalar', 'scalar', 'scalar'] },
}

// Block operators are the four boolean operations over their children, named after the operation
// itself: and = every child matches, or = at least one matches, nor = none match, nand = not every
// child matches. They carry no separate `neg` flag, negation is intrinsic to the operator, and the
// set is closed under negation (and<->nand, or<->nor).
export const BLOCK_TYPES = ['and', 'or', 'nor', 'nand'] as const
export type BlockType = (typeof BLOCK_TYPES)[number]

// how each block operator compiles: `conjunction` picks AND (true) vs OR (false) over the child
// conditions, `negated` wraps the combined result in NOT.
export const BLOCK_TYPE_SEMANTICS: Record<BlockType, { conjunction: boolean; negated: boolean }> = {
	and: { conjunction: true, negated: false },
	nand: { conjunction: true, negated: true },
	or: { conjunction: false, negated: false },
	nor: { conjunction: false, negated: true },
}

// Apply-filter operators reference another filter entity, folding the old apply-filter `neg` flag into
// the operator: included-in = the layer matches the referenced filter, excluded-from = it does not.
export const APPLY_FILTER_TYPES = ['included-in', 'excluded-from'] as const
export type ApplyFilterType = (typeof APPLY_FILTER_TYPES)[number]

// 'excluded-from' compiles as the negation of the referenced filter's condition
export const APPLY_FILTER_TYPE_NEGATED: Record<ApplyFilterType, boolean> = {
	'included-in': false,
	'excluded-from': true,
}

// Matchup operators describe one matchup: two team specs, each a set of allowed values per team
// column. The plural is the set semantics -- {USA, CAF} vs {RGF} already denotes several concrete
// matchups -- not a list of matchups; several unrelated matchups are an `or` block over several
// nodes. Unlike a `team-column` comparison, whose quantifier expands one column over both teams
// independently, a matchup correlates the two sides: it pairs team spec 0 against team spec 1. By
// default either orientation matches; `locked` pins spec 0 to team 1 and spec 1 to team 2.
export const MATCHUP_TYPES = ['allow-matchups', 'disallow-matchups'] as const
export type MatchupType = (typeof MATCHUP_TYPES)[number]

// 'disallow-matchups' compiles as the negation of the allow condition
export const MATCHUP_TYPE_NEGATED: Record<MatchupType, boolean> = {
	'allow-matchups': false,
	'disallow-matchups': true,
}

// -------- nodes --------

// freeform prose attached to any node, carried through the tree and persisted with it. Absent rather
// than empty when unset, so a comment that is cleared leaves no trace in the stored filter.
export const NODE_COMMENT_MAX_LENGTH = 1200
export const NodeCommentSchema = z.string().trim().min(1).max(NODE_COMMENT_MAX_LENGTH)

export type CompNode =
	| { type: 'eq' | 'lt' | 'gt'; neg: boolean; args: [SubjectArg, ScalarArg]; comment?: string }
	| { type: 'in'; neg: boolean; args: [SubjectArg, ValuesArg]; comment?: string }
	// [subject, min, max] (inclusive)
	| { type: 'inrange'; neg: boolean; args: [SubjectArg, ScalarArg, ScalarArg]; comment?: string }

export type ApplyFilterNode = { type: ApplyFilterType; filterId: string; comment?: string }

// one side of a matchup. Dimensions are keyed by TeamColumn so resolveTeamColumn does the _1/_2
// resolution. A dimension that is absent or empty is unconstrained ("any"), so a spec ANDs only the
// dimensions that carry values -- this is what makes an alliance-only matchup expressible.
export type MatchupTeamSpec = Partial<Record<TeamColumn, Value[]>>

export type MatchupNode = { type: MatchupType; locked: boolean; teams: [MatchupTeamSpec, MatchupTeamSpec]; comment?: string }

export type FilterNode = { type: BlockType; children: FilterNode[]; comment?: string } | CompNode | ApplyFilterNode | MatchupNode

export type NodeType = FilterNode['type']

const NegSchema = z.boolean().prefault(false)
const CommentSchema = NodeCommentSchema.optional()

export const EqNodeSchema = z.object({
	type: z.literal('eq'),
	neg: NegSchema,
	args: z.tuple([SubjectArgSchema, ScalarArgSchema]),
	comment: CommentSchema,
})
export const LtNodeSchema = z.object({
	type: z.literal('lt'),
	neg: NegSchema,
	args: z.tuple([SubjectArgSchema, ScalarArgSchema]),
	comment: CommentSchema,
})
export const GtNodeSchema = z.object({
	type: z.literal('gt'),
	neg: NegSchema,
	args: z.tuple([SubjectArgSchema, ScalarArgSchema]),
	comment: CommentSchema,
})
export const InNodeSchema = z.object({
	type: z.literal('in'),
	neg: NegSchema,
	args: z.tuple([SubjectArgSchema, ValuesArgSchema]),
	comment: CommentSchema,
})
export const InRangeNodeSchema = z.object({
	type: z.literal('inrange'),
	neg: NegSchema,
	args: z.tuple([SubjectArgSchema, ScalarArgSchema, ScalarArgSchema]),
	comment: CommentSchema,
})

export const CompNodeSchema = z.discriminatedUnion('type', [EqNodeSchema, InNodeSchema, LtNodeSchema, GtNodeSchema, InRangeNodeSchema])

const applyFilterNodeSchema = <T extends ApplyFilterType>(type: T) =>
	z.object({ type: z.literal(type), filterId: z.lazy(() => FilterEntityIdSchema), comment: CommentSchema })
export const IncludedInNodeSchema = applyFilterNodeSchema('included-in')
export const ExcludedFromNodeSchema = applyFilterNodeSchema('excluded-from')

export const MatchupTeamSpecSchema = z.object(
	Object.fromEntries(TEAM_COLUMNS.map((col) => [col, z.array(ValueSchema).optional()])) as {
		[K in TeamColumn]: z.ZodOptional<z.ZodArray<typeof ValueSchema>>
	},
) satisfies z.ZodType<MatchupTeamSpec, unknown>

const LockedSchema = z.boolean().prefault(false)

const matchupNodeSchema = <T extends MatchupType>(type: T) =>
	z.object({
		type: z.literal(type),
		locked: LockedSchema,
		teams: z.tuple([MatchupTeamSpecSchema, MatchupTeamSpecSchema]),
		comment: CommentSchema,
	})
export const AllowMatchupsNodeSchema = matchupNodeSchema('allow-matchups')
export const DisallowMatchupsNodeSchema = matchupNodeSchema('disallow-matchups')

const ChildrenSchema = z.lazy(() => z.array(FilterNodeSchema))
const blockNodeSchema = <T extends BlockType>(type: T) =>
	z.object({ type: z.literal(type), children: ChildrenSchema, comment: CommentSchema })
export const AndNodeSchema = blockNodeSchema('and')
export const OrNodeSchema = blockNodeSchema('or')
export const NorNodeSchema = blockNodeSchema('nor')
export const NandNodeSchema = blockNodeSchema('nand')

export const FilterNodeSchema: z.ZodType<FilterNode> = z.lazy(() =>
	z.discriminatedUnion('type', [
		EqNodeSchema,
		InNodeSchema,
		LtNodeSchema,
		GtNodeSchema,
		InRangeNodeSchema,
		IncludedInNodeSchema,
		ExcludedFromNodeSchema,
		AllowMatchupsNodeSchema,
		DisallowMatchupsNodeSchema,
		AndNodeSchema,
		OrNodeSchema,
		NorNodeSchema,
		NandNodeSchema,
	]),
) as z.ZodType<FilterNode>

export const RootFilterNodeSchema = FilterNodeSchema.refine((root) => isBlockNode(root), { error: 'Root node must be a block type' })

// -------- editable (partial) nodes --------

export type EditableScalarArg =
	| { type: 'column'; column?: string }
	| { type: 'team-column'; column?: TeamColumn; quantifier?: TeamQuantifier }
	| { type: 'value'; value?: Value }
export type EditableValuesArg = { type: 'values'; values?: InListItem[] }
export type EditableArg = EditableScalarArg | EditableValuesArg

export const EditableArgSchema = z.discriminatedUnion('type', [
	z.object({ type: z.literal('column'), column: z.string().optional() }),
	z.object({ type: z.literal('team-column'), column: TeamColumnSchema.optional(), quantifier: TeamQuantifierSchema.optional() }),
	z.object({ type: z.literal('value'), value: ValueSchema.optional() }),
	z.object({ type: z.literal('values'), values: z.array(InListItemSchema).optional() }),
])

export type EditableCompNode = { type: CompType; neg: boolean; args: EditableArg[]; comment?: string }

export const EditableCompNodeSchema = z.object({
	type: z.enum(COMP_TYPES),
	neg: NegSchema,
	args: z.array(EditableArgSchema),
	comment: CommentSchema,
}) satisfies z.ZodType<EditableCompNode, unknown>

export type EditableApplyFilterNode = { type: ApplyFilterType; filterId?: string; comment?: string }

// a matchup node has no incomplete state to model: every dimension is optional and an empty one means
// "any", so a half-filled node is already a valid one. The editable form is the strict form.
export type EditableMatchupNode = MatchupNode

export type EditableFilterNodeCommon = EditableCompNode | EditableApplyFilterNode | EditableMatchupNode

export type EditableFilterNode =
	| EditableFilterNodeCommon
	| {
			type: BlockType
			children: EditableFilterNode[]
			comment?: string
	  }

export type ShallowEditableFilterNode = EditableFilterNodeCommon | { type: BlockType; comment?: string }

export const EditableApplyFilterNodeSchema = z.object({
	type: z.enum(APPLY_FILTER_TYPES),
	filterId: z.lazy(() => FilterEntityIdSchema).optional(),
	comment: CommentSchema,
}) satisfies z.ZodType<EditableApplyFilterNode, unknown>

export const EditableMatchupNodeSchema = z.discriminatedUnion('type', [AllowMatchupsNodeSchema, DisallowMatchupsNodeSchema])

// the editable tree crosses the wire as filter-edit ops, so the partial forms need schemas of their own:
// FilterNodeSchema rejects the half-filled nodes an editing session is mostly made of
export const ShallowEditableFilterNodeSchema = z.union([
	EditableCompNodeSchema,
	EditableApplyFilterNodeSchema,
	EditableMatchupNodeSchema,
	z.object({ type: z.enum(BLOCK_TYPES), comment: CommentSchema }),
]) satisfies z.ZodType<ShallowEditableFilterNode, unknown>

export const EditableFilterNodeSchema: z.ZodType<EditableFilterNode> = z.lazy(() =>
	z.union([
		EditableCompNodeSchema,
		EditableApplyFilterNodeSchema,
		EditableMatchupNodeSchema,
		z.object({ type: z.enum(BLOCK_TYPES), children: z.array(EditableFilterNodeSchema), comment: CommentSchema }),
	]),
) as z.ZodType<EditableFilterNode>

export type ShallowEditableFilterNodeOfType<T extends NodeType> = Extract<ShallowEditableFilterNode, { type: T }>
export type EditableFilterNodeOfType<T extends NodeType> = Extract<EditableFilterNode, { type: T }>
export type EditableBlockNode = Extract<EditableFilterNode, { type: BlockType }>

// -------- type guards --------

export function isBlockType(type: string): type is BlockType {
	return BLOCK_TYPES.includes(type as BlockType)
}
export function isBlockNode<T extends FilterNode>(node: T): node is Extract<T, { type: BlockType }> {
	return BLOCK_TYPES.includes(node.type as BlockType)
}
export function isEditableBlockNode<T extends { type: NodeType }>(node: T): node is Extract<T, { type: BlockType }> {
	return BLOCK_TYPES.includes(node.type as BlockType)
}

export function isCompType(type: string): type is CompType {
	return COMP_TYPES.includes(type as CompType)
}
export function isCompNode(node: FilterNode): node is CompNode
export function isCompNode(node: EditableFilterNode | ShallowEditableFilterNode): node is EditableCompNode
export function isCompNode(node: { type: string }): boolean {
	return isCompType(node.type)
}

export function isApplyFilterType(type: string): type is ApplyFilterType {
	return APPLY_FILTER_TYPES.includes(type as ApplyFilterType)
}
export function isApplyFilterNode(node: FilterNode): node is ApplyFilterNode
export function isApplyFilterNode(node: EditableFilterNode | ShallowEditableFilterNode): node is EditableApplyFilterNode
export function isApplyFilterNode(node: { type: string }): boolean {
	return isApplyFilterType(node.type)
}

export function isMatchupType(type: string): type is MatchupType {
	return MATCHUP_TYPES.includes(type as MatchupType)
}
export function isMatchupNode(node: FilterNode): node is MatchupNode
export function isMatchupNode(node: EditableFilterNode | ShallowEditableFilterNode): node is EditableMatchupNode
export function isMatchupNode(node: { type: string }): boolean {
	return isMatchupType(node.type)
}

// -------- value domains --------
// the "data type" of an argument. enum-mapped columns are stored as int codes per mapping, so two
// columns are only comparable when their domains are equal (same mapping / same primitive kind)

export type ValueDomain =
	| { kind: 'enum'; mapping: string }
	// `integral` distinguishes integer columns (exact) from float columns (stored as IEEE-754 REAL).
	// Exact-equality operators (eq/neq/in) are unreliable on floats, so they're not offered for them.
	| { kind: 'number'; integral: boolean }
	| { kind: 'string' }
	| { kind: 'boolean' }
	| { kind: 'layer-id' }

export function columnValueDomain(column: string, cfg = LC.BASE_COLUMN_CONFIG): ValueDomain | undefined {
	if (column === 'id') return { kind: 'layer-id' }
	const def = LC.getColumnDef(column, cfg)
	if (!def) return undefined
	switch (def.type) {
		case 'string':
			return def.enumMapping ? { kind: 'enum', mapping: def.enumMapping } : { kind: 'string' }
		case 'integer':
			return { kind: 'number', integral: true }
		case 'float':
			return { kind: 'number', integral: false }
		case 'boolean':
			return { kind: 'boolean' }
		default:
			assertNever(def)
	}
}

export function teamColumnValueDomain(column: TeamColumn, cfg = LC.BASE_COLUMN_CONFIG): ValueDomain | undefined {
	return columnValueDomain(TEAM_COLUMN_PAIRS[column][0], cfg)
}

export function argValueDomain(arg: EditableArg | Arg, cfg = LC.BASE_COLUMN_CONFIG): ValueDomain | undefined {
	if (arg.type === 'column' && arg.column) return columnValueDomain(arg.column, cfg)
	if (arg.type === 'team-column' && arg.column) return teamColumnValueDomain(arg.column, cfg)
	return undefined
}

export function domainsCompatible(a: ValueDomain, b: ValueDomain): boolean {
	// all numbers are mutually comparable (SQLite compares int/float numerically); integral only
	// gates which operators are offered, not comparability
	if (a.kind === 'number' && b.kind === 'number') return true
	return Obj.deepEqual(a, b)
}

export function isFloatDomain(domain: ValueDomain | undefined): boolean {
	return domain?.kind === 'number' && !domain.integral
}

export function domainSupportsCompType(domain: ValueDomain, type: CompType): boolean {
	// floats support ordering plus eq (which, for floats, only tests against null) — but not `in`
	if (isFloatDomain(domain)) return type === 'eq' || type === 'lt' || type === 'gt' || type === 'inrange'
	if (COMP_TYPE_DEFS[type].domain === 'any') return true
	return domain.kind === 'number'
}

// the operator a fresh comparison should default to for a given subject domain. enum/string subjects
// prefer `in` (picking a set of allowed values is the common case); floats default to a range.
export function defaultCompType(domain: ValueDomain | undefined): CompType {
	if (isFloatDomain(domain)) return 'inrange'
	if (domain?.kind === 'enum' || domain?.kind === 'string') return 'in'
	return 'eq'
}

// -------- subject column groups --------
// the filter editor's categorized add menu scopes a comparison's subject dropdown to one group. the
// group is re-derived from the current subject column so the restriction persists without touching the AST.

export type SubjectColumnGroup = 'layer-identity' | 'team' | 'extra'

const TEAM_BASE_COLUMNS: ReadonlySet<string> = new Set(Object.values(TEAM_COLUMN_PAIRS).flat())

export function subjectColumnGroup(column: string, cfg = LC.BASE_COLUMN_CONFIG): SubjectColumnGroup | undefined {
	if ((LC.LAYER_IDENTITY_COLUMNS as readonly string[]).includes(column)) return 'layer-identity'
	if (TEAM_BASE_COLUMNS.has(column)) return 'team'
	if (LC.getColumnDef(column, cfg)?.table === 'extra-cols') return 'extra'
	return undefined
}

export function columnsInGroup(group: SubjectColumnGroup, cfg = LC.BASE_COLUMN_CONFIG): string[] {
	switch (group) {
		case 'layer-identity':
			return [...LC.LAYER_IDENTITY_COLUMNS]
		case 'team':
			return Object.values(TEAM_COLUMN_PAIRS).flat()
		case 'extra':
			return Object.keys(cfg.defs).filter((c) => cfg.defs[c].table === 'extra-cols')
		default:
			assertNever(group)
	}
}

// -------- operator selection --------
// what the operator dropdown offers: each entry maps to a (comp type, neg) pair, so negated forms
// (!=, not in, >=, ...) and null tests (eq against the constant null) need no operators of their own

export type CompOpKey = 'eq' | 'neq' | 'in' | 'notin' | 'lt' | 'gt' | 'lte' | 'gte' | 'inrange' | 'outrange'

export type CompOpSelectOption = {
	key: CompOpKey
	type: CompType
	neg: boolean
	// eq/neq on a float column, which only test against null
	nullTest: boolean
}

export function compOpSelectOptions(domain: ValueDomain | undefined): CompOpSelectOption[] {
	const floatDomain = isFloatDomain(domain)
	// eq/neq are always available; on floats they only compare against null (IS [NOT] NULL), since
	// exact equality against a numeric constant is unreliable. There are no dedicated null-test
	// operators — null is selected as a value.
	const options: CompOpSelectOption[] = [
		{ key: 'eq', type: 'eq', neg: false, nullTest: floatDomain },
		{ key: 'neq', type: 'eq', neg: true, nullTest: floatDomain },
	]
	// `in` uses exact equality, so skip it for floats (and it's redundant for booleans)
	if (!floatDomain && (!domain || domain.kind !== 'boolean')) {
		options.push({ key: 'in', type: 'in', neg: false, nullTest: false }, { key: 'notin', type: 'in', neg: true, nullTest: false })
	}
	if (!domain || domain.kind === 'number') {
		options.push(
			{ key: 'lt', type: 'lt', neg: false, nullTest: false },
			{ key: 'gt', type: 'gt', neg: false, nullTest: false },
			{ key: 'lte', type: 'gt', neg: true, nullTest: false },
			{ key: 'gte', type: 'lt', neg: true, nullTest: false },
			{ key: 'inrange', type: 'inrange', neg: false, nullTest: false },
			{ key: 'outrange', type: 'inrange', neg: true, nullTest: false },
		)
	}
	return options
}

// true when a float column's eq should be constrained to null-only (numeric equality is unreliable).
// For floats this eq is a null test, and NaN (a missing/invalid float) counts as null (see the SQL
// compilation, which matches NaN alongside SQL NULL).
export function isFloatEqNullOnly(domain: ValueDomain | undefined, type: CompType): boolean {
	return type === 'eq' && isFloatDomain(domain)
}

export function compOpSelectionKey(node: EditableCompNode): CompOpKey {
	switch (node.type) {
		case 'eq':
			return node.neg ? 'neq' : 'eq'
		case 'in':
			return node.neg ? 'notin' : 'in'
		case 'lt':
			return node.neg ? 'gte' : 'lt'
		case 'gt':
			return node.neg ? 'lte' : 'gt'
		case 'inrange':
			return node.neg ? 'outrange' : 'inrange'
		default:
			assertNever(node.type)
	}
}

// reshapes args to the selected operator's slots, carrying compatible args over
export function applyCompOpSelection(node: EditableCompNode, option: Pick<CompOpSelectOption, 'type' | 'neg'>): EditableCompNode {
	const def = COMP_TYPE_DEFS[option.type]
	const prevArgs = node.args
	const args = def.argSlots.map((slot, i): EditableArg => {
		if (i === 0) return prevArgs[0] ?? { type: 'column' }
		const prev = prevArgs[i] as EditableArg | undefined
		if (slot === 'values') {
			if (prev?.type === 'values') return prev
			if (prev?.type === 'value' && prev.value !== undefined && prev.value !== null) return { type: 'values', values: [prev.value] }
			return { type: 'values' }
		}
		if (prev?.type === 'column' || prev?.type === 'team-column') return prev
		if (prev?.type === 'value' && prev.value !== null) return prev
		if (prev?.type === 'values' && prev.values?.length === 1) {
			const only = prev.values[0]
			if (isColumnListItem(only)) return { type: 'column', column: only.column }
			if (only !== null) return { type: 'value', value: only }
		}
		return { type: 'value' }
	})
	return { type: option.type, neg: option.neg, args }
}

// -------- comp node accessors --------
// these read across both editable and validated nodes, so treat args structurally

type AnyArg = { type: string; column?: string; value?: Value; values?: InListItem[] }
function anyArgs(node: EditableCompNode | CompNode): AnyArg[] {
	return node.args as AnyArg[]
}

export function compAnchorArg(node: EditableCompNode | CompNode): AnyArg | undefined {
	return anyArgs(node).find((arg) => arg.type === 'column' || arg.type === 'team-column')
}

export function compAnchorColumn(node: EditableCompNode | CompNode): string | undefined {
	const arg = compAnchorArg(node)
	return arg?.type === 'column' ? (arg.column as string | undefined) : undefined
}

// the constant on the value side of a simple comparison (used by locked-column UIs like the filter menu)
export function compValue(node: EditableCompNode | CompNode): Value | undefined {
	return anyArgs(node).find((arg) => arg.type === 'value')?.value
}

export function setCompValue(node: EditableCompNode, value: Value | undefined) {
	node.args[1] = { type: 'value', value }
}

export function compValues(node: EditableCompNode | CompNode): InListItem[] | undefined {
	return anyArgs(node).find((arg) => arg.type === 'values')?.values
}

export function editableCompHasValue(node: EditableCompNode): boolean {
	return anyArgs(node).some((arg, i) => {
		if (i === 0) return false
		if (arg.type === 'value') return arg.value !== undefined
		if (arg.type === 'values') return (arg.values?.length ?? 0) > 0
		// a column on the value side counts as configured
		return arg.column !== undefined
	})
}

// -------- legacy compatibility --------
// The pre-rearchitecture "comparison" shape ({ column, code, value, values, range }). Still appears in
// operators' config files (extraLayerSelectMenuItems), so we upgrade it to an EditableCompNode on read.
// Persisted filter *entities* are upgraded separately by a data migration.
export type LegacyEditableComparison = {
	column?: string
	code?: string
	value?: string | number | boolean | null
	values?: (string | null)[]
	range?: [number?, number?]
}

export function isLegacyEditableComparison(obj: unknown): obj is LegacyEditableComparison {
	return typeof obj === 'object' && obj !== null && !('args' in obj) && !('type' in obj) && ('code' in obj || 'column' in obj)
}

export function upgradeLegacyEditableComparison(legacy: LegacyEditableComparison): EditableCompNode {
	const column = legacy.column
	const colArg: EditableScalarArg = { type: 'column', column }
	const value = (v: Value | undefined): EditableCompNode => ({
		type: 'eq',
		neg: false,
		args: [colArg, { type: 'value', value: v ?? undefined }],
	})
	switch (legacy.code) {
		case 'eq':
			return value(legacy.value)
		case 'neq':
			return { type: 'eq', neg: true, args: [colArg, { type: 'value', value: legacy.value ?? undefined }] }
		case 'in':
			return { type: 'in', neg: false, args: [colArg, { type: 'values', values: legacy.values ?? undefined }] }
		case 'notin':
			return { type: 'in', neg: true, args: [colArg, { type: 'values', values: legacy.values ?? undefined }] }
		case 'lt':
			return { type: 'lt', neg: false, args: [colArg, { type: 'value', value: legacy.value ?? undefined }] }
		case 'gt':
			return { type: 'gt', neg: false, args: [colArg, { type: 'value', value: legacy.value ?? undefined }] }
		case 'inrange': {
			const [lo, hi] = legacy.range ?? []
			if (lo !== undefined && hi !== undefined) {
				return { type: 'inrange', neg: false, args: [colArg, { type: 'value', value: lo }, { type: 'value', value: hi }] }
			}
			if (lo !== undefined) return { type: 'lt', neg: true, args: [colArg, { type: 'value', value: lo }] } // >= lo
			if (hi !== undefined) return { type: 'gt', neg: true, args: [colArg, { type: 'value', value: hi }] } // <= hi
			return { type: 'inrange', neg: false, args: [colArg, { type: 'value' }, { type: 'value' }] }
		}
		case 'isnull':
			return { type: 'eq', neg: false, args: [colArg, { type: 'value', value: null }] }
		case 'notnull':
			return { type: 'eq', neg: true, args: [colArg, { type: 'value', value: null }] }
		case 'is-true':
			return { type: 'eq', neg: false, args: [colArg, { type: 'value', value: true }] }
		default:
			return value(legacy.value)
	}
}

// z.preprocess input: upgrades a legacy comparison to the new node shape, passes new-shape items through
export function coerceEditableCompNode(input: unknown): unknown {
	if (isLegacyEditableComparison(input)) return upgradeLegacyEditableComparison(input)
	return input
}

// -------- validity --------

export function isValidCompNode(node: EditableCompNode): node is CompNode {
	return CompNodeSchema.safeParse(node).success
}

export function isValidApplyFilterNode(node: EditableApplyFilterNode): node is ApplyFilterNode {
	return !!node.filterId
}

export function isValidFilterNode(node: EditableFilterNode): node is FilterNode {
	return FilterNodeSchema.safeParse(node).success
}

// excludes children
export function isLocallyValidFilterNode(node: EditableFilterNode) {
	if (isEditableBlockNode(node)) return true
	if (isCompNode(node)) return isValidCompNode(node)
	if (isApplyFilterNode(node)) return isValidApplyFilterNode(node)
	// every dimension is optional, so there is no locally-invalid matchup node. Unmapped values are
	// still reported at lowering time.
	if (isMatchupNode(node)) return true
	assertNever(node)
}

// -------- filter entities --------

export const FilterEntityIdSchema = z
	.string()
	.trim()
	.regex(/^[a-z0-9-_]+$/, {
		error: '"Must contain only lowercase letters, numbers, hyphens, and underscores"',
	})
	.min(3)
	.max(64)
	.refine((id) => id !== '_id' && id !== 'new', {
		error: 'These particular magic strings are not allowed',
	})

export const DescriptionSchema = z.string().trim().min(3).max(2048)
export const AlertMessageSchema = z.string().trim().min(3).max(280)
export type FilterEntityId = z.infer<typeof FilterEntityIdSchema>

// Who manages a filter and answers for it. The tags match the corresponding members of AppEvents.Actor, so an owner
// can be labelled the way an actor is. A user owner holds the filter-owner role over it; a plugin or the system
// holds none, so only contributors and holders of filters:write-all can edit such a filter.
export const FilterOwnerSchema = z.discriminatedUnion('type', [
	z.object({ type: z.literal('slm-user'), userId: z.bigint() }),
	z.object({ type: z.literal('plugin'), pluginId: z.string() }),
	z.object({ type: z.literal('system') }),
])
export type FilterOwner = z.infer<typeof FilterOwnerSchema>

export const SYSTEM_OWNER: FilterOwner = { type: 'system' }

export function ownerUserId(owner: FilterOwner): bigint | null {
	return owner.type === 'slm-user' ? owner.userId : null
}

export function ownersEqual(a: FilterOwner, b: FilterOwner): boolean {
	switch (a.type) {
		case 'slm-user':
			return b.type === 'slm-user' && a.userId === b.userId
		case 'plugin':
			return b.type === 'plugin' && a.pluginId === b.pluginId
		case 'system':
			return b.type === 'system'
		default:
			assertNever(a)
	}
}

export const BaseFilterEntitySchema = z.object({
	id: FilterEntityIdSchema,
	name: z.string().trim().min(3).max(128),
	description: DescriptionSchema.nullable(),
	filter: FilterNodeSchema,
	owner: FilterOwnerSchema,

	alertMessage: AlertMessageSchema.nullable(),
	emoji: z.string().nullable(),

	invertedAlertMessage: AlertMessageSchema.nullable(),
	invertedEmoji: z.string().nullable(),
})

// the filter entities this tree applies directly, via its apply-filter operators. Not transitive: a referenced
// filter's own references are found by walking the entities (see filter-references.models.ts).
export function appliedFilterIds(node: FilterNode | EditableFilterNode, ids = new Set<FilterEntityId>()): Set<FilterEntityId> {
	if (isEditableBlockNode(node)) {
		for (const child of node.children) appliedFilterIds(child, ids)
	} else if (isApplyFilterNode(node) && node.filterId) {
		ids.add(node.filterId)
	}
	return ids
}

export const FilterEntitySchema = BaseFilterEntitySchema
	// direct self-reference only. A loop through other filters is caught where the whole set is known, on the
	// write path (see filter-references.models.ts, findCycle)
	.refine((e) => !appliedFilterIds(e.filter).has(e.id), {
		error: 'filter cannot be recursive',
	})

export const UpdateFilterEntitySchema = BaseFilterEntitySchema.omit({
	id: true,
	owner: true,
})
export const NewFilterEntitySchema = BaseFilterEntitySchema.omit({
	owner: true,
})

export type FilterEntityUpdate = z.infer<typeof UpdateFilterEntitySchema>
export type FilterEntity = z.infer<typeof FilterEntitySchema>

export type FilterEntityMutation = {
	type: 'add' | 'update' | 'delete'
	key: FilterEntityId
	value: FilterEntity
	// who made the change, which is not necessarily the owner
	actor: AppEvents.Actor
}

export function fromRow(row: SchemaModels.Filter): FilterEntity {
	const owner: FilterOwner =
		row.ownerUserId !== null
			? { type: 'slm-user', userId: row.ownerUserId }
			: row.ownerPluginId !== null
				? { type: 'plugin', pluginId: row.ownerPluginId }
				: SYSTEM_OWNER
	return FilterEntitySchema.parse({ ...row, owner })
}

export function ownerColumns(owner: FilterOwner): Pick<SchemaModels.NewFilter, 'ownerUserId' | 'ownerPluginId'> {
	return { ownerUserId: ownerUserId(owner), ownerPluginId: owner.type === 'plugin' ? owner.pluginId : null }
}

export function toRow({ owner, ...rest }: FilterEntity): SchemaModels.NewFilter {
	return { ...rest, ...ownerColumns(owner) }
}

// -------- validation errors --------

export type InvalidFilterNodeResult = { code: 'err:invalid-node'; errors: NodeValidationError[] }

type ErrorBase = {
	path: string[]
	// deferred: validation runs on both sides, and only the side displaying an error knows who is reading it
	msg: Msgs.TString
}

export type NodeValidationError =
	| (ErrorBase & { type: 'unmapped-column'; column: string })
	| (ErrorBase & {
			type: 'unmapped-value'
			column: string
			value: LC.InputValue
	  })
	| (ErrorBase & {
			type: 'recursive-filter' | 'unknown-filter'
			filterId: string
	  })
	// semantic problems: incompatible arg domains, a comparison whose subject isn't a column, null on an
	// ordered comparison, ...
	| (ErrorBase & { type: 'invalid-node' })

export type NodeValidationErrorStore = {
	errors?: NodeValidationError[]
	setErrors: (errors: NodeValidationError[] | undefined) => void
}

// -------- editor tree --------

/**
 * The filter editor's working form of a filter: every node stored flat by id, with the structure held as links.
 * `children` has an entry for every block node, holding its children's ids in order, and none for a leaf.
 * `parents` is the inverse, with an entry for every node except the root.
 */
export type FilterNodeTree = {
	rootId: string
	nodes: Map<string, ShallowEditableFilterNode>
	children: Map<string, readonly string[]>
	parents: Map<string, string>
}

export const FilterNodeTreeSchema = z.object({
	rootId: z.string(),
	nodes: z.map(z.string(), ShallowEditableFilterNodeSchema),
	children: z.map(z.string(), z.array(z.string()).readonly()),
	parents: z.map(z.string(), z.string()),
}) satisfies z.ZodType<FilterNodeTree, unknown>

export function toShallowNode(node: EditableFilterNode): ShallowEditableFilterNode {
	if (isEditableBlockNode(node)) {
		const { children: _c, ...shallowNode } = node
		return shallowNode
	}
	return node
}

/**
 * The id a node gets when a tree is built from a bare filter, derived from its position rather than minted
 * at random, so every replica building a tree from the same filter agrees on it.
 *
 * The editor seeds a placeholder tree from the saved filter and then swaps in the server's snapshot, which
 * is built from that same filter. With random ids those are two disjoint sets: every NodePortal key changes
 * and the whole tree remounts under the user, taking component state with it -- an add strip opened in that
 * window dies with the click still pending, and nothing reports an error.
 *
 * The dot keeps these clear of createId's alphabet, so a path id can never collide with one minted for a
 * node added later.
 */
function pathNodeId(path: number[]): string {
	return path.length === 0 ? 'n' : `n.${path.join('.')}`
}

export function toFilterNodeTree(filter: EditableFilterNode): FilterNodeTree {
	const tree: FilterNodeTree = { rootId: pathNodeId([]), nodes: new Map(), children: new Map(), parents: new Map() }
	const visit = (node: EditableFilterNode, path: number[]): string => {
		const id = pathNodeId(path)
		tree.nodes.set(id, toShallowNode(node))
		if (isEditableBlockNode(node)) {
			const childIds = node.children.map((child, index) => {
				const childId = visit(child, [...path, index])
				tree.parents.set(childId, id)
				return childId
			})
			tree.children.set(id, childIds)
		}
		return id
	}
	visit(filter, [])
	return tree
}

export function treeToFilterNode(tree: FilterNodeTree, id = tree.rootId): EditableFilterNode {
	const node = tree.nodes.get(id)!
	if (!isEditableBlockNode(node)) return { ...node }
	return { ...node, children: tree.children.get(id)!.map((child) => treeToFilterNode(tree, child)) }
}

// whether the links describe exactly one tree over exactly the nodes in `nodes`. The schema cannot check this,
// and every function below assumes it of the trees it is given.
export function isWellFormedTree(tree: FilterNodeTree): boolean {
	if (tree.parents.has(tree.rootId)) return false
	const seen = new Set<string>()
	const stack = [tree.rootId]
	let blocks = 0
	while (stack.length > 0) {
		const id = stack.pop()!
		// a second visit means a cycle, or a node listed under two parents
		if (seen.has(id)) return false
		seen.add(id)
		const node = tree.nodes.get(id)
		if (!node) return false
		const children = tree.children.get(id)
		if (!isEditableBlockNode(node)) {
			if (children) return false
			continue
		}
		if (!children) return false
		blocks++
		for (const child of children) {
			if (tree.parents.get(child) !== id) return false
			stack.push(child)
		}
	}
	return seen.size === tree.nodes.size && tree.children.size === blocks && tree.parents.size === seen.size - 1
}

// undefined for an id the tree does not hold
export function nodeDepth(tree: FilterNodeTree, id: string): number | undefined {
	if (!tree.nodes.has(id)) return undefined
	let depth = 0
	for (let parent = tree.parents.get(id); parent !== undefined; parent = tree.parents.get(parent)) depth++
	return depth
}

// whether `id` is `ancestorId` or one of its descendants
export function isWithin(tree: FilterNodeTree, id: string, ancestorId: string): boolean {
	for (let current: string | undefined = id; current !== undefined; current = tree.parents.get(current)) {
		if (current === ancestorId) return true
	}
	return false
}

function subtreeIds(tree: FilterNodeTree, id: string): string[] {
	const ids = [id]
	for (let i = 0; i < ids.length; i++) {
		const children = tree.children.get(ids[i])
		if (children) ids.push(...children)
	}
	return ids
}

export function singleNodeTree(id: string, node: ShallowEditableFilterNode): FilterNodeTree {
	return {
		rootId: id,
		nodes: new Map([[id, node]]),
		children: isEditableBlockNode(node) ? new Map([[id, []]]) : new Map(),
		parents: new Map(),
	}
}

// The functions below are copy-on-write: each returns a new tree and shares every map it did not change, and
// every node object, with the tree it was given.

// grafts `subtree` in as a child of the block `parentId`, at `index` clamped to the end of its child list. The
// two trees must not share an id.
export function insertSubtree(tree: FilterNodeTree, parentId: string, index: number, subtree: FilterNodeTree): FilterNodeTree {
	const nodes = new Map(tree.nodes)
	const children = new Map(tree.children)
	const parents = new Map(tree.parents)
	for (const [id, node] of subtree.nodes) nodes.set(id, node)
	for (const [id, ids] of subtree.children) children.set(id, ids)
	for (const [id, parent] of subtree.parents) parents.set(id, parent)
	parents.set(subtree.rootId, parentId)
	const siblings = tree.children.get(parentId)!
	children.set(parentId, siblings.toSpliced(Math.min(index, siblings.length), 0, subtree.rootId))
	return { rootId: tree.rootId, nodes, children, parents }
}

// removes `id` and everything below it. `id` must not be the root.
export function removeSubtree(tree: FilterNodeTree, id: string): FilterNodeTree {
	const parentId = tree.parents.get(id)!
	const nodes = new Map(tree.nodes)
	const children = new Map(tree.children)
	const parents = new Map(tree.parents)
	for (const removed of subtreeIds(tree, id)) {
		nodes.delete(removed)
		children.delete(removed)
		parents.delete(removed)
	}
	children.set(
		parentId,
		tree.children.get(parentId)!.filter((child) => child !== id),
	)
	return { rootId: tree.rootId, nodes, children, parents }
}

// `index` counts positions in the destination's child list as it stands before the move, the way the drop slot
// between two rows names them. `id` must not be the root, and `parentId` must not be within `id`. Returns `tree`
// itself when the node is already where it would land.
export function moveNode(tree: FilterNodeTree, id: string, parentId: string, index: number): FilterNodeTree {
	const fromId = tree.parents.get(id)!
	const from = tree.children.get(fromId)!
	const children = new Map(tree.children)
	let to = tree.children.get(parentId)!
	let at = Math.min(index, to.length)
	if (fromId === parentId) {
		const fromIndex = from.indexOf(id)
		if (fromIndex < at) at--
		if (at === fromIndex) return tree
		to = from.toSpliced(fromIndex, 1)
	} else {
		children.set(
			fromId,
			from.filter((child) => child !== id),
		)
	}
	children.set(parentId, to.toSpliced(at, 0, id))
	const parents = fromId === parentId ? tree.parents : new Map(tree.parents).set(id, parentId)
	return { rootId: tree.rootId, nodes: tree.nodes, children, parents }
}

// The subtree at `targetId` as a standalone tree, with a fresh id for every node. Callers mint the copy so that
// every replica applies the same one: a reducer that called this would give each replica different ids. Node
// objects are shared, never mutated.
export function copySubtree(tree: FilterNodeTree, targetId: string): FilterNodeTree | null {
	if (!tree.nodes.has(targetId)) return null
	const copy: FilterNodeTree = { rootId: '', nodes: new Map(), children: new Map(), parents: new Map() }
	const visit = (id: string): string => {
		const copiedId = createId(4)
		copy.nodes.set(copiedId, tree.nodes.get(id)!)
		const children = tree.children.get(id)
		if (children) {
			const copiedChildren = children.map((child) => {
				const copiedChild = visit(child)
				copy.parents.set(copiedChild, copiedId)
				return copiedChild
			})
			copy.children.set(copiedId, copiedChildren)
		}
		return copiedId
	}
	copy.rootId = visit(targetId)
	return copy
}

export type Ctx = CS.Ctx & {
	filters: Map<string, FilterEntity>
}
export const CtxDef = CD.defCtx<Ctx>()(['filters'], { name: 'filters' })
