import type * as SchemaModels from '$root/drizzle/schema.models'
import * as Arr from '@/lib/array'
import { assertNever } from '@/lib/type-guards'
import { z } from 'zod'
import * as LC from './layer-columns'

export const COMPOSITE_COLUMNS = z.enum(['Factions'])
export const COMPOSITE_COLTYPES = z.enum(['factions'])
type CompositeColType = z.infer<typeof COMPOSITE_COLTYPES>
export type ComparisonType = {
	coltype: LC.ColumnType | CompositeColType
	code: string
	displayName: string
	default?: boolean
}

export function getColumnTypeWithComposite(
	name: string,
	cfg = LC.BASE_COLUMN_CONFIG,
) {
	if (name === 'Factions') return 'factions'
	return LC.getColumnDef(name, cfg)?.type
}

export const COMPARISON_TYPES = [
	{ coltype: 'float', code: 'lt', displayName: 'Less Than' },
	{ coltype: 'float', code: 'gt', displayName: 'Greater Than' },
	{ coltype: 'float', code: 'inrange', displayName: 'In Range' },
	{ coltype: 'string', code: 'in', displayName: 'In' },
	{ coltype: 'string', code: 'eq', displayName: 'Equals' },
	{ coltype: 'boolean', code: 'is-true', displayName: 'Is True' },
	{
		coltype: 'factions',
		code: 'factions:allow-matchups',
		displayName: 'Matchups',
	},
] as const satisfies ComparisonType[]

export const DEFAULT_COMPARISONS = {
	float: 'inrange',
	string: 'eq',
	boolean: 'is-true',
	factions: 'factions:allow-matchups',
} satisfies Record<
	Exclude<LC.ColumnType, 'integer'> | CompositeColType,
	ComparisonCode
>

export function getDefaultComparison(
	columnType: LC.ColumnType | CompositeColType,
) {
	const result = DEFAULT_COMPARISONS[columnType as keyof typeof DEFAULT_COMPARISONS]
	if (!result) throw new Error(`No default comparison for ${columnType}`)
	return result
}

export type Comparison = z.infer<typeof ComparisonSchema>
export type FilterNode =
	| {
		type: 'and'
		neg: boolean
		children: FilterNode[]
	}
	| {
		type: 'or'
		neg: boolean
		children: FilterNode[]
	}
	| {
		type: 'comp'
		neg: boolean
		comp: Comparison
	}
	| {
		type: 'apply-filter'
		neg: boolean
		filterId: string
	}

export type EditableFilterNode =
	| {
		type: 'and'
		neg: boolean
		children: EditableFilterNode[]
	}
	| {
		type: 'or'
		neg: boolean
		children: EditableFilterNode[]
	}
	| {
		type: 'comp'
		neg: boolean
		comp: EditableComparison
	}
	| {
		type: 'apply-filter'
		neg: boolean
		filterId?: string
	}

export type BlockTypeEditableFilterNode = Extract<
	EditableFilterNode,
	{ type: BlockType }
>

export const BLOCK_TYPES = ['and', 'or'] as const
export function isBlockType(type: string): type is BlockType {
	return BLOCK_TYPES.includes(type as BlockType)
}
export function isBlockNode<T extends FilterNode>(
	node: T,
): node is Extract<T, { type: BlockType }> {
	return BLOCK_TYPES.includes(node.type as BlockType)
}

export function isEditableBlockNode(
	node: EditableFilterNode,
): node is Extract<EditableFilterNode, { type: BlockType }> {
	return BLOCK_TYPES.includes(node.type as BlockType)
}
export type BlockType = (typeof BLOCK_TYPES)[number]

export const getComparisonTypesForColumn = LC.coalesceLookupErrors((
	column: string,
	cfg = LC.BASE_COLUMN_CONFIG,
) => {
	if (Arr.includes(COMPOSITE_COLUMNS.options, column)) {
		return { code: 'ok' as const, comparisonTypes: COMPARISON_TYPES.filter((type) => type.coltype === column) }
	}
	const colType = LC.getColumnDef(column, cfg)!.type
	return { code: 'ok' as const, comparisonTypes: COMPARISON_TYPES.filter((type) => type.coltype === colType) }
})

export type EditableComparison = {
	column?: string
	code?: (typeof COMPARISON_TYPES)[number]['code']
	value?: number | string | null
	values?: (string | null)[]
	range?: [number | undefined, number | undefined]
	allMasks?: FactionMask[][]
	mode?: 'split' | 'both' | 'either'
}

export function editableComparisonHasValue(comp: EditableComparison) {
	return (
		comp.code === 'is-true'
		|| comp.value !== undefined
		|| comp.values !== undefined
		|| comp.range !== undefined
	)
}

// --------  numeric --------
export const LessThanComparison = z.object({
	code: z.literal('lt'),
	value: z.number(),
	column: z.string(),
})
export type LessThanComparison = z.infer<typeof LessThanComparison>

export const GreaterThanComparison = z.object({
	code: z.literal('gt'),
	value: z.number(),
	column: z.string(),
})
export type GreaterThanComparison = z.infer<typeof GreaterThanComparison>

export const InRangeComparison = z
	.object({
		code: z.literal('inrange'),
		range: z
			.tuple([z.number(), z.number()])
			.describe(
				"smallest value is always the start of the range, even if it's larger",
			),
		column: z.string(),
	})
	.describe('Inclusive Range')

export type InRangeComparison = z.infer<typeof InRangeComparison>

export type NumericComparison =
	| LessThanComparison
	| GreaterThanComparison
	| InRangeComparison
// --------  numeric end --------

// --------  string --------
export const InComparison = z.object({
	code: z.literal('in'),
	values: z.array(z.string().nullable()),
	column: z.string(),
})
export type InComparison = z.infer<typeof InComparison>

export const EqualComparison = z.object({
	code: z.literal('eq'),
	value: z.string().nullable(),
	column: z.string(),
})
export type EqualComparison = z.infer<typeof EqualComparison>

export type StringComparison = InComparison | EqualComparison
// --------  string end --------

const IsTrueComparison = z.object({
	code: z.literal('is-true'),
	column: z.string(),
})

export const FactionMaskSchema = z.object({
	// null is only semantically different for edit state
	alliance: z.array(z.string()).nullable().optional(),
	faction: z.array(z.string()).nullable().optional(),
	unit: z.array(z.string()).nullable().optional(),
})
export type FactionMask = z.infer<typeof FactionMaskSchema>

export const FACTION_MODE = z.enum(['split', 'both', 'either'])
export type FactionMaskMode = z.infer<typeof FACTION_MODE>

// --------  factions --------
export const FactionsAllowMatchupsComparisonSchema = z.object({
	code: z.literal('factions:allow-matchups'),
	column: z.literal('Factions'),
	allMasks: z
		.array(z.array(FactionMaskSchema))
		.refine((teams) => teams.length > 0 && teams.length <= 2, {
			message: 'At least one team is required and at most two teams are allowed',
		}),
	// default either
	mode: FACTION_MODE.optional(),
})

export type FactionsAllowMatchupsComparison = z.infer<
	typeof FactionsAllowMatchupsComparisonSchema
>

// --------  factionsend --------

// Combine into the final ComparisonSchema
export const ComparisonSchema = z
	.discriminatedUnion('code', [
		LessThanComparison,
		GreaterThanComparison,
		InRangeComparison,
		InComparison,
		EqualComparison,
		IsTrueComparison,
		FactionsAllowMatchupsComparisonSchema,
	])
	.refine((comp) => COMPARISON_TYPES.some((type) => type.code === comp.code), {
		message: 'Invalid comparison type',
	})

// TODO add 'not'
export const BaseFilterNodeSchema = z.object({
	type: z.union([
		z.literal('and'),
		z.literal('or'),
		z.literal('comp'),
		z.literal('apply-filter'),
	]),
	comp: ComparisonSchema.optional(),
	// negations
	neg: z.boolean().default(false),
	filterId: z.lazy(() => FilterEntityIdSchema).optional(),
})

export function isValidComparison(
	comp: EditableComparison,
): comp is Comparison {
	const res = ComparisonSchema.safeParse(comp)
	return res.success
}
export function isValidApplyFilterNode(
	node: EditableFilterNode & { type: 'apply-filter' },
): node is FilterNode & { type: 'apply-filter' } {
	return !!node.filterId
}

export const FilterNodeSchema = BaseFilterNodeSchema.extend({
	children: z.lazy(() => FilterNodeSchema.array().optional()),
})
	.refine((node) => node.type !== 'comp' || node.comp !== undefined, {
		message: 'comp must be defined for type "comp"',
	})
	.refine((node) => node.type !== 'comp' || node.children === undefined, {
		message: 'children must not be defined for type "comp"',
	})
	.refine(
		(node) => node.type !== 'apply-filter' || typeof node.filterId === 'string',
		{
			message: 'filterId must be defined for type "apply-filter"',
		},
	)
	.refine((node) => !(['and', 'or'].includes(node.type) && !node.children), {
		message: 'children must be defined for type "and" or "or"',
	}) as z.ZodType<FilterNode>

export const RootFilterNodeSchema = FilterNodeSchema.refine(
	(root) => isBlockNode(root),
	{ message: 'Root node must be a block type' },
)

export function isValidFilterNode(
	node: EditableFilterNode,
): node is FilterNode {
	return FilterNodeSchema.safeParse(node).success
}

// excludes children
export function isLocallyValidFilterNode(node: EditableFilterNode) {
	if (node.type === 'and' || node.type === 'or') return true
	if (node.type === 'comp') return isValidComparison(node.comp)
	if (node.type === 'apply-filter') return isValidApplyFilterNode(node)
	throw new Error('Invalid node type')
}

export const FilterEntityIdSchema = z
	.string()
	.trim()
	.regex(/^[a-z0-9-_]+$/, {
		message: '"Must contain only lowercase letters, numbers, hyphens, and underscores"',
	})
	.min(3)
	.max(64)
	.refine((id) => id !== '_id', {
		message: 'outlaw a particular magic string',
	})

export const FilterEntityDescriptionSchema = z.string().trim().min(3).max(2048)
export type FilterEntityId = z.infer<typeof FilterEntityIdSchema>

export const BaseFilterEntitySchema = z.object({
	id: FilterEntityIdSchema,
	name: z.string().trim().min(3).max(128),
	description: FilterEntityDescriptionSchema.nullable(),
	filter: FilterNodeSchema,
	owner: z.bigint(),
})

export type ComparisonCode = (typeof COMPARISON_TYPES)[number]['code']
export const COMPARISON_CODES = COMPARISON_TYPES.map((type) => type.code) as [ComparisonCode, ...ComparisonCode[]]

export function filterContainsId(id: string, node: FilterNode): boolean {
	switch (node.type) {
		case 'and':
		case 'or':
			return node.children.some((n) => filterContainsId(id, n))
		case 'comp':
			return false
		case 'apply-filter':
			return node.filterId === id
		default:
			assertNever(node)
	}
}

export const FilterEntitySchema = BaseFilterEntitySchema
	// this refinement does not deal with mutual recustion
	.refine((e) => !filterContainsId(e.id, e.filter), {
		message: 'filter cannot be recursive',
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
