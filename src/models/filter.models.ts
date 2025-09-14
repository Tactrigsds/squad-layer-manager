import type * as SchemaModels from '$root/drizzle/schema.models'
import { useRefConstructor } from '@/lib/react'
import { assertNever } from '@/lib/type-guards'
import type { SQL } from 'drizzle-orm'
import deepEqual from 'fast-deep-equal'
import { z } from 'zod'
import * as Zus from 'zustand'
import * as LC from './layer-columns'

export type ComparisonType = {
	coltype: LC.ColumnType
	code: string
	displayName: string
	default?: boolean
}

export const COMPARISON_TYPES = [
	{ coltype: 'float', code: 'lt', displayName: '<' },
	{ coltype: 'float', code: 'gt', displayName: '>' },
	{ coltype: 'float', code: 'inrange', displayName: '[..]' },
	{ coltype: 'string', code: 'in', displayName: 'in' },
	{ coltype: 'string', code: 'notin', displayName: 'not in' },
	{ coltype: 'string', code: 'eq', displayName: '=' },
	{ coltype: 'string', code: 'neq', displayName: '!=' },
	{ coltype: 'boolean', code: 'is-true', displayName: 'true' },
] as const satisfies ComparisonType[]

export const DEFAULT_COMPARISONS = {
	float: 'inrange',
	string: 'eq',
	boolean: 'is-true',
} satisfies Record<
	Exclude<LC.ColumnType, 'integer'>,
	ComparisonCode
>
export function getColumnTypeWithComposite(column: string, cfg = LC.BASE_COLUMN_CONFIG) {
	const colDef = LC.getColumnDef(column, cfg)
	if (!colDef) return undefined
	return colDef.type
}

export function getDefaultComparison(
	columnType: LC.ColumnType,
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
	| {
		type: 'allow-matchups'
		allowMatchups: FactionsAllowMatchups
		neg: boolean
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
	| {
		type: 'allow-matchups'
		allowMatchups: FactionsAllowMatchups
		neg: boolean
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

export const InRangeComparisonSchema = z
	.object({
		code: z.literal('inrange'),
		range: z
			.tuple([z.number().optional(), z.number().optional()])
			.describe(
				"smallest value is always the start of the range, even if it's larger",
			)
			.refine(
				(range) => {
					return range.some((value) => value !== undefined)
				},
				{ message: 'Range must have at least one value' },
			),
		column: z.string(),
	})
	.describe('Inclusive Range')

export type InRangeComparison = z.infer<typeof InRangeComparisonSchema>

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

export const NotInComparison = z.object({
	code: z.literal('notin'),
	values: z.array(z.string().nullable()),
	column: z.string(),
})
export type NotInComparison = z.infer<typeof NotInComparison>

export const EqualComparison = z.object({
	code: z.literal('eq'),
	value: z.string().nullable(),
	column: z.string(),
})
export type EqualComparison = z.infer<typeof EqualComparison>

export const NotEqualComparison = z.object({
	code: z.literal('neq'),
	value: z.string().nullable(),
	column: z.string(),
})
export type NotEqualComparison = z.infer<typeof NotEqualComparison>

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
export const FactionsAllowMatchupsSchema = z.object({
	allMasks: z
		.array(z.array(FactionMaskSchema))
		.refine((teams) => teams.length > 0 && teams.length <= 2, {
			message: 'At least one team is required and at most two teams are allowed',
		}),
	// default either
	mode: FACTION_MODE.optional(),
})

export type FactionsAllowMatchups = z.infer<typeof FactionsAllowMatchupsSchema>

// --------  factionsend --------

// Combine into the final ComparisonSchema
export const ComparisonSchema = z
	.discriminatedUnion('code', [
		LessThanComparison,
		GreaterThanComparison,
		InRangeComparisonSchema,
		InComparison,
		NotInComparison,
		EqualComparison,
		NotEqualComparison,
		IsTrueComparison,
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
		z.literal('allow-matchups'),
	]),
	comp: ComparisonSchema.optional(),
	// negations
	neg: z.boolean().default(false),
	filterId: z.lazy(() => FilterEntityIdSchema).optional(),
	allowMatchups: FactionsAllowMatchupsSchema.optional(),
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

// TODO Implement isValidAllowMatchupsNode
export function isValidAllowMatchupsNode(
	node: EditableFilterNode & { type: 'allow-matchups' },
): node is FilterNode & { type: 'allow-matchups' } {
	return !!node.allowMatchups
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
	if (node.type === 'allow-matchups') return isValidAllowMatchupsNode(node)
	assertNever(node)
}

export function isEditableBlockNode(
	node: EditableFilterNode,
): node is Extract<EditableFilterNode, { type: BlockType }> {
	return BLOCK_TYPES.includes(node.type as BlockType)
}
export type BlockType = (typeof BLOCK_TYPES)[number]

export const getComparisonTypesForColumn = LC.coalesceLookupErrors(
	(column: string, cfg = LC.BASE_COLUMN_CONFIG) => {
		const colType = LC.getColumnDef(column, cfg)!.type
		return {
			code: 'ok' as const,
			comparisonTypes: COMPARISON_TYPES.filter(
				(type) => type.coltype === colType,
			),
		}
	},
)

export const EditableComparisonSchema = z.object({
	column: z.string().optional(),
	code: z
		.enum(
			COMPARISON_TYPES.map((type) => type.code) as [
				ComparisonCode,
				...ComparisonCode[],
			],
		)
		.optional(),
	value: z.union([z.number(), z.string(), z.null()]).optional(),
	values: z.array(z.string().nullable()).optional(),
	range: z.tuple([z.number().optional(), z.number().optional()]).optional(),
	allMasks: z.array(z.array(FactionMaskSchema)).optional(),
	mode: z.enum(['split', 'both', 'either']).optional(),
})
export type EditableComparison = z.infer<typeof EditableComparisonSchema>

export function editableComparisonHasValue(comp: EditableComparison) {
	return (
		comp.code === 'is-true'
		|| comp.value !== undefined
		|| comp.values !== undefined
		|| (comp.range !== undefined
			&& !deepEqual(comp.range, [undefined, undefined]))
		|| comp.allMasks?.some((side) => side.length > 0)
	)
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
export const COMPARISON_CODES = z.enum(
	COMPARISON_TYPES.map((type) => type.code) as [
		ComparisonCode,
		...ComparisonCode[],
	],
)

export function filterContainsId(id: string, node: FilterNode): boolean {
	switch (node.type) {
		case 'and':
		case 'or':
			return node.children.some((n) => filterContainsId(id, n))
		case 'comp':
		case 'allow-matchups':
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

export type NodeValidationErrorStore = {
	errors?: NodeValidationError[]
	setErrors: (errors: NodeValidationError[]) => void
}

export function useNodeValidationErrorStore() {
	const storeRef = useRefConstructor(() => {
		return Zus.createStore<NodeValidationErrorStore>((set) => ({
			errors: [],
			setErrors: (errors) => {
				console.log('node errors:', JSON.stringify(errors))
				return set({ errors })
			},
		}))
	})
	return storeRef.current
}
