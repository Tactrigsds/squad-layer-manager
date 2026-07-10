// Filter nodes form a small expression AST. Every node's `type` is an operator: block operators
// (all/some/none/notall) take child nodes, comparison operators take argument terms (columns,
// constants, team-generic columns), and apply-filter operators (included-in/excluded-from) reference
// another filter entity.
import type * as SchemaModels from '$root/drizzle/schema.models'
import { createId } from '@/lib/id'
import * as Obj from '@/lib/object'
import * as Sparse from '@/lib/sparse-tree'
import { assertNever } from '@/lib/type-guards'
import type { SQL } from 'drizzle-orm'
import { z } from 'zod'
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
} as const

export const TeamColumnSchema = z.enum(['Alliance', 'Faction', 'Unit'])
export type TeamColumn = z.infer<typeof TeamColumnSchema>
export const TEAM_COLUMNS = TeamColumnSchema.options

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

// Block operators fold the old (and/or) x negation matrix into four named quantifiers over their
// children: all = every child matches (AND), some = at least one matches (OR), none = no child
// matches (NOT OR), notall = not every child matches (NOT AND). They carry no separate `neg` flag,
// negation is intrinsic to the operator, and the set is closed under negation (all<->notall,
// some<->none).
export const BLOCK_TYPES = ['all', 'some', 'none', 'notall'] as const
export type BlockType = (typeof BLOCK_TYPES)[number]

export const BLOCK_TYPE_DISPLAY_NAMES: Record<BlockType, string> = {
	all: 'all',
	some: 'some',
	none: 'none',
	notall: 'not all',
}

// how each block operator compiles: `conjunction` picks AND (true) vs OR (false) over the child
// conditions, `negated` wraps the combined result in NOT.
export const BLOCK_TYPE_SEMANTICS: Record<BlockType, { conjunction: boolean; negated: boolean }> = {
	all: { conjunction: true, negated: false },
	notall: { conjunction: true, negated: true },
	some: { conjunction: false, negated: false },
	none: { conjunction: false, negated: true },
}

// Apply-filter operators reference another filter entity, folding the old apply-filter `neg` flag into
// the operator: included-in = the layer matches the referenced filter, excluded-from = it does not.
export const APPLY_FILTER_TYPES = ['included-in', 'excluded-from'] as const
export type ApplyFilterType = (typeof APPLY_FILTER_TYPES)[number]

export const APPLY_FILTER_TYPE_DISPLAY_NAMES: Record<ApplyFilterType, string> = {
	'included-in': 'included in',
	'excluded-from': 'excluded from',
}

// 'excluded-from' compiles as the negation of the referenced filter's condition
export const APPLY_FILTER_TYPE_NEGATED: Record<ApplyFilterType, boolean> = {
	'included-in': false,
	'excluded-from': true,
}

// -------- nodes --------

export type CompNode =
	| { type: 'eq' | 'lt' | 'gt'; neg: boolean; args: [SubjectArg, ScalarArg] }
	| { type: 'in'; neg: boolean; args: [SubjectArg, ValuesArg] }
	// [subject, min, max] (inclusive)
	| { type: 'inrange'; neg: boolean; args: [SubjectArg, ScalarArg, ScalarArg] }

export type ApplyFilterNode = { type: ApplyFilterType; filterId: string }

export type FilterNode =
	| { type: BlockType; children: FilterNode[] }
	| CompNode
	| ApplyFilterNode

export type NodeType = FilterNode['type']

const NegSchema = z.boolean().prefault(false)

export const EqNodeSchema = z.object({ type: z.literal('eq'), neg: NegSchema, args: z.tuple([SubjectArgSchema, ScalarArgSchema]) })
export const LtNodeSchema = z.object({ type: z.literal('lt'), neg: NegSchema, args: z.tuple([SubjectArgSchema, ScalarArgSchema]) })
export const GtNodeSchema = z.object({ type: z.literal('gt'), neg: NegSchema, args: z.tuple([SubjectArgSchema, ScalarArgSchema]) })
export const InNodeSchema = z.object({ type: z.literal('in'), neg: NegSchema, args: z.tuple([SubjectArgSchema, ValuesArgSchema]) })
export const InRangeNodeSchema = z.object({
	type: z.literal('inrange'),
	neg: NegSchema,
	args: z.tuple([SubjectArgSchema, ScalarArgSchema, ScalarArgSchema]),
})

export const CompNodeSchema = z.discriminatedUnion('type', [
	EqNodeSchema,
	InNodeSchema,
	LtNodeSchema,
	GtNodeSchema,
	InRangeNodeSchema,
])

const applyFilterNodeSchema = <T extends ApplyFilterType>(type: T) =>
	z.object({ type: z.literal(type), filterId: z.lazy(() => FilterEntityIdSchema) })
export const IncludedInNodeSchema = applyFilterNodeSchema('included-in')
export const ExcludedFromNodeSchema = applyFilterNodeSchema('excluded-from')

const ChildrenSchema = z.lazy(() => z.array(FilterNodeSchema))
const blockNodeSchema = <T extends BlockType>(type: T) => z.object({ type: z.literal(type), children: ChildrenSchema })
export const AllNodeSchema = blockNodeSchema('all')
export const SomeNodeSchema = blockNodeSchema('some')
export const NoneNodeSchema = blockNodeSchema('none')
export const NotAllNodeSchema = blockNodeSchema('notall')

export const FilterNodeSchema: z.ZodType<FilterNode> = z.lazy(() =>
	z.discriminatedUnion('type', [
		EqNodeSchema,
		InNodeSchema,
		LtNodeSchema,
		GtNodeSchema,
		InRangeNodeSchema,
		IncludedInNodeSchema,
		ExcludedFromNodeSchema,
		AllNodeSchema,
		SomeNodeSchema,
		NoneNodeSchema,
		NotAllNodeSchema,
	])
) as z.ZodType<FilterNode>

export const RootFilterNodeSchema = FilterNodeSchema.refine(
	(root) => isBlockNode(root),
	{ error: 'Root node must be a block type' },
)

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

export type EditableCompNode = { type: CompType; neg: boolean; args: EditableArg[] }

export const EditableCompNodeSchema = z.object({
	type: z.enum(COMP_TYPES),
	neg: NegSchema,
	args: z.array(EditableArgSchema),
}) satisfies z.ZodType<EditableCompNode, unknown>

export type EditableApplyFilterNode = { type: ApplyFilterType; filterId?: string }

export type EditableFilterNodeCommon =
	| EditableCompNode
	| EditableApplyFilterNode

export type EditableFilterNode = EditableFilterNodeCommon | {
	type: BlockType
	children: EditableFilterNode[]
}

export type ShallowEditableFilterNode = EditableFilterNodeCommon | { type: BlockType }

export type ShallowEditableFilterNodeOfType<T extends NodeType> = Extract<ShallowEditableFilterNode, { type: T }>
export type EditableFilterNodeOfType<T extends NodeType> = Extract<EditableFilterNode, { type: T }>
export type EditableBlockNode = Extract<EditableFilterNode, { type: BlockType }>

// -------- type guards --------

export function isBlockType(type: string): type is BlockType {
	return BLOCK_TYPES.includes(type as BlockType)
}
export function isBlockNode<T extends FilterNode>(
	node: T,
): node is Extract<T, { type: BlockType }> {
	return BLOCK_TYPES.includes(node.type as BlockType)
}
export function isEditableBlockNode<T extends { type: NodeType }>(
	node: T,
): node is Extract<T, { type: BlockType }> {
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

// the operator a fresh comparison should default to for a given subject domain
export function defaultCompType(domain: ValueDomain | undefined): CompType {
	return isFloatDomain(domain) ? 'inrange' : 'eq'
}

// -------- operator selection --------
// what the operator dropdown offers: each entry maps to a (comp type, neg) pair, so negated forms
// (!=, not in, >=, ...) and null tests (eq against the constant null) need no operators of their own

export type CompOpSelectOption = {
	key: string
	label: string
	type: CompType
	neg: boolean
}

export function compOpSelectOptions(domain: ValueDomain | undefined): CompOpSelectOption[] {
	const floatDomain = isFloatDomain(domain)
	// eq/neq are always available; on floats they only compare against null (IS [NOT] NULL), since
	// exact equality against a numeric constant is unreliable. There are no dedicated null-test
	// operators — null is selected as a value.
	const options: CompOpSelectOption[] = [
		{ key: 'eq', label: '=', type: 'eq', neg: false },
		{ key: 'neq', label: '!=', type: 'eq', neg: true },
	]
	// `in` uses exact equality, so skip it for floats (and it's redundant for booleans)
	if (!floatDomain && (!domain || domain.kind !== 'boolean')) {
		options.push(
			{ key: 'in', label: 'in', type: 'in', neg: false },
			{ key: 'notin', label: 'not in', type: 'in', neg: true },
		)
	}
	if (!domain || domain.kind === 'number') {
		options.push(
			{ key: 'lt', label: '<', type: 'lt', neg: false },
			{ key: 'gt', label: '>', type: 'gt', neg: false },
			{ key: 'lte', label: '<=', type: 'gt', neg: true },
			{ key: 'gte', label: '>=', type: 'lt', neg: true },
			{ key: 'inrange', label: '[..]', type: 'inrange', neg: false },
			{ key: 'outrange', label: '![..]', type: 'inrange', neg: true },
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

export function compOpSelectionKey(node: EditableCompNode): string {
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
export function applyCompOpSelection(node: EditableCompNode, option: CompOpSelectOption): EditableCompNode {
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

export function isValidApplyFilterNode(
	node: EditableApplyFilterNode,
): node is ApplyFilterNode {
	return !!node.filterId
}

export function isValidFilterNode(
	node: EditableFilterNode,
): node is FilterNode {
	return FilterNodeSchema.safeParse(node).success
}

// excludes children
export function isLocallyValidFilterNode(node: EditableFilterNode) {
	if (isEditableBlockNode(node)) return true
	if (isCompNode(node)) return isValidCompNode(node)
	if (isApplyFilterNode(node)) return isValidApplyFilterNode(node)
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

export const BaseFilterEntitySchema = z.object({
	id: FilterEntityIdSchema,
	name: z.string().trim().min(3).max(128),
	description: DescriptionSchema.nullable(),
	filter: FilterNodeSchema,
	owner: z.bigint(),

	alertMessage: AlertMessageSchema.nullable(),
	emoji: z.string().nullable(),

	invertedAlertMessage: AlertMessageSchema.nullable(),
	invertedEmoji: z.string().nullable(),
})

export function filterContainsId(id: string, node: FilterNode): boolean {
	if (isBlockNode(node)) return node.children.some((n) => filterContainsId(id, n))
	if (isApplyFilterNode(node)) return node.filterId === id
	return false
}

export const FilterEntitySchema = BaseFilterEntitySchema
	// this refinement does not deal with mutual recursion
	.refine((e) => !filterContainsId(e.id, e.filter), {
		error: 'filter cannot be recursive',
	}) satisfies z.ZodType<SchemaModels.Filter>

export const UpdateFilterEntitySchema = BaseFilterEntitySchema.omit({
	id: true,
	owner: true,
})
export const NewFilterEntitySchema = BaseFilterEntitySchema.omit({
	owner: true,
})

export type FilterEntityUpdate = z.infer<typeof UpdateFilterEntitySchema>
export type FilterEntity = z.infer<typeof FilterEntitySchema>

// -------- validation errors --------

export type InvalidFilterNodeResult = { code: 'err:invalid-node'; errors: NodeValidationError[] }
export type SQLConditionsResult = { code: 'ok'; condition: SQL } | InvalidFilterNodeResult

type ErrorBase = {
	path: string[]
	msg: string
}

export type NodeValidationError =
	| ErrorBase & { type: 'unmapped-column'; column: string }
	| ErrorBase & {
		type: 'unmapped-value'
		column: string
		value: LC.InputValue
	}
	| ErrorBase & {
		type: 'recursive-filter' | 'unknown-filter'
		filterId: string
	}
	// semantic problems: incompatible arg domains, team columns outside a team scope, nested scopes, ...
	| ErrorBase & { type: 'invalid-node' }

export type NodeValidationErrorStore = {
	errors?: NodeValidationError[]
	setErrors: (errors: NodeValidationError[] | undefined) => void
}

// -------- node tree utilities --------

export function buildNodePath(parent: Sparse.NodePath, childIndex: number) {
	return parent.concat(childIndex)
}

export function tryDerefPath(root: EditableFilterNode, path: Sparse.NodePath) {
	let node = root
	for (const index of path) {
		if (!isEditableBlockNode(node)) return null
		node = node.children[index]
	}
	return node
}

function derefPath(root: EditableFilterNode, path: Sparse.NodePath) {
	const node = tryDerefPath(root, path)
	if (!node) {
		throw new Error('Invalid path ' + path + ' for node ' + JSON.stringify(root))
	}
	return node
}

export function* walkNodes(
	filter: EditableFilterNode,
	path: Sparse.NodePath = [],
): IterableIterator<[EditableFilterNode, Sparse.NodePath]> {
	yield [filter, path]
	if (isEditableBlockNode(filter)) {
		for (const [child, index] of filter.children.map((child, index) => [child, index] as const)) {
			yield* walkNodes(child, [...path, index])
		}
	}
}

// TODO this data structure should be phased out in favour of just using sparse-tree. It's pretty dumb.
export type FilterNodeTree = {
	nodes: Map<string, ShallowEditableFilterNode>
	paths: Map<string, Sparse.NodePath>
}

export function* iterChildIdsForPath(tree: FilterNodeTree, targetPath: Sparse.NodePath) {
	for (const [id, path] of tree.paths.entries()) {
		if (path.length === targetPath.length + 1 && Sparse.isChildPath(targetPath, path)) {
			yield id
		}
	}
}

export function nextChildIndex(tree: FilterNodeTree, parentPath: Sparse.NodePath) {
	let last = -1
	for (const id of iterChildIdsForPath(tree, parentPath)) {
		const path = tree.paths.get(id)
		if (!path) continue
		last = Math.max(last, path[path.length - 1])
	}
	return last + 1
}

export function toShallowNode(node: EditableFilterNode): ShallowEditableFilterNode {
	if (isEditableBlockNode(node)) {
		const { children: _c, _id, ...shallowNode } = node as any
		return shallowNode
	}
	return node
}
function upsertTreeInPlaceFromSparse(
	sparseTree: Sparse.SparseNode,
	basePath: Sparse.NodePath = [],
	tree?: Partial<FilterNodeTree>,
) {
	basePath ??= []
	tree ??= {
		nodes: new Map(),
		paths: new Map(),
	}
	tree.paths ??= new Map()

	const idsLeft = new Set<string>()

	// add/update nodes
	for (const [node, _path] of Sparse.walkNodes(sparseTree)) {
		const path = [...basePath, ..._path]
		tree.paths.set(node.id, path)
		idsLeft.add(node.id)
	}

	// delete nodes that are no longer in the tree
	for (const [id, path] of tree.paths.entries()) {
		if (idsLeft.has(id)) continue
		if (!Sparse.isOwnedPath(basePath, path)) continue
		tree.nodes?.delete(id)
		tree.paths.delete(id)
	}

	return tree
}

export function upsertFilterNodeTreeInPlace(
	filter: EditableFilterNode,
	baseFilterPath?: Sparse.NodePath,
	tree?: FilterNodeTree,
): FilterNodeTree {
	baseFilterPath ??= []
	tree ??= {
		nodes: new Map(),
		paths: new Map(),
	}

	const idsLeft = new Set<string>()

	// add/update nodes
	for (const [node, _path] of walkNodes(filter)) {
		const path = [...baseFilterPath, ..._path]
		const id: string = (node as any)._id ?? createId(4)
		const shallowNode = toShallowNode(node)
		if (Obj.deepEqual(shallowNode, tree.nodes.get(id))) {
			continue
		}
		tree.nodes.set(id, shallowNode)
		tree.paths.set(id, path)
		idsLeft.add(id)
	}

	// delete nodes that are no longer in the tree
	for (const id of tree.paths.keys()) {
		if (idsLeft.has(id)) continue
		tree.nodes.delete(id)
		tree.paths.delete(id)
	}

	return tree
}

export function resolveImmediateChildren(tree: FilterNodeTree, id: string): string[] {
	const targetPath = tree.paths.get(id)
	if (!targetPath) return []
	const children: string[] = []

	for (const [id, path] of tree.paths) {
		if (targetPath.length + 1 !== path.length) continue
		if (!Sparse.isChildPath(targetPath, path)) continue
		children[path[targetPath.length]] = id
	}

	return children
}
function treeToSparseTree(tree: Pick<FilterNodeTree, 'paths'>, subtreePath: Sparse.NodePath = []): Sparse.SparseNode {
	let root!: Sparse.SparseNode

	for (const [id, path] of toBreadthFirstTreePathEntries(tree.paths)) {
		if (!Sparse.isOwnedPath(subtreePath, path)) continue
		const sparseNode: Sparse.SparseNode = { id }

		if (!root) {
			root = sparseNode
			continue
		}

		const parent = Sparse.derefPath(root, path.slice(subtreePath.length, -1))!
		parent.children ??= []
		parent.children[path[path.length - 1]] = sparseNode
	}

	return root
}

export function treeToFilterNode(tree: FilterNodeTree, subtree: Sparse.NodePath = []): EditableFilterNode {
	let root!: EditableFilterNode

	for (const [id, path] of toBreadthFirstTreePathEntries(tree.paths)) {
		if (!Sparse.isOwnedPath(subtree, path)) continue
		const shallowNode = tree.nodes.get(id)!
		const node: EditableFilterNode = isEditableBlockNode(shallowNode)
			? { ...shallowNode, children: [] }
			: { ...shallowNode }
		if (!root) {
			root = node
			continue
		}
		;(derefPath(root, path.slice(0, -1)) as EditableBlockNode).children[path[path.length - 1]] = node
	}

	return root
}

// outputs entries sorted in primarily order of depth, and secondarily in order of index
export function toBreadthFirstTreePathEntries(paths: Map<string, Sparse.NodePath>): [string, Sparse.NodePath][] {
	const pathsArr = Array.from(paths.entries())
	pathsArr.sort(([_idA, pathA], [_idB, pathB]) => {
		if (pathA.length !== pathB.length) {
			return pathA.length - pathB.length
		}
		for (let i = 0; i < pathA.length; i++) {
			if (pathA[i] !== pathB[i]) {
				return pathA[i] - pathB[i]
			}
		}
		return 0
	})
	return pathsArr
}

export function moveTreeNodeInPlace(tree: Pick<FilterNodeTree, 'paths'>, sourcePath: Sparse.NodePath, targetPath: Sparse.NodePath) {
	if (Sparse.isChildPath(sourcePath, targetPath)) {
		return
	}
	const commonAncestor = Sparse.getCommonAncestorPath(sourcePath, targetPath)
	if (Obj.deepEqual(sourcePath, commonAncestor) || Obj.deepEqual(targetPath, commonAncestor)) {
		commonAncestor.pop()
	}
	let sparseTree = treeToSparseTree(tree, commonAncestor)
	sparseTree = Sparse.moveNode(sparseTree, sourcePath.slice(commonAncestor.length), targetPath.slice(commonAncestor.length))
	upsertTreeInPlaceFromSparse(sparseTree, commonAncestor, tree)
}

export function deleteTreeNode(tree: FilterNodeTree, targetId: string): void {
	const targetPath = tree.paths.get(targetId)!
	const parentPath = targetPath.slice(0, -1)
	let sparseTree = treeToSparseTree(tree, parentPath)
	sparseTree = Sparse.deleteNode(sparseTree, targetPath.slice(parentPath.length))
	upsertTreeInPlaceFromSparse(sparseTree, parentPath, tree)
}
