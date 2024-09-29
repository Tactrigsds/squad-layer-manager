import * as z from 'zod'

export const getLayerKey = (layer: Layer) =>
	`${layer.Level}-${layer.Layer}-${layer.Faction_1}-${layer.SubFac_1}-${layer.Faction_2}-${layer.SubFac_2}`

// Define enums for SubFac
export const SubFacEnum = z.enum(['CombinedArms', 'Armored', 'LightInfantry', 'Mechanized', 'Motorized', 'Support', 'AirAssault'])

// Define the schema for raw data
export const RawLayerSchema = z.object({
	Level: z.string(),
	Layer: z.string(),
	Size: z.string(),
	Faction_1: z.string(),
	SubFac_1: SubFacEnum,
	Logistics_1: z.number(),
	Transportation_1: z.number(),
	'Anti-Infantry_1': z.number(),
	Armor_1: z.number(),
	ZERO_Score_1: z.number(),
	Faction_2: z.string(),
	SubFac_2: SubFacEnum,
	Logistics_2: z.number(),
	Transportation_2: z.number(),
	'Anti-Infantry_2': z.number(),
	Armor_2: z.number(),
	ZERO_Score_2: z.number(),
	Balance_Differential: z.number(),
})

export type RawLayer = z.infer<typeof RawLayerSchema>

// Define the schema for processed data
export const ProcessedLayerSchema = RawLayerSchema.extend({
	Gamemode: z.string(),
	LayerVersion: z.string(),
	Logistics_Diff: z.number(),
	Transportation_Diff: z.number(),
	'Anti-Infantry_Diff': z.number(),
	Armor_Diff: z.number(),
	ZERO_Score_Diff: z.number(),
})

type ComparisonType = {
	coltype: 'string' | 'numeric'
	code: string
	displayName: string
}
export const COLUMN_TYPES = ['numeric', 'string'] as const
export type ColumnType = (typeof COLUMN_TYPES)[number]
export const COLUMN_TYPE_MAPPING = {
	numeric: [
		'Anti-Infantry_1',
		'Armor_1',
		'ZERO_Score_1',
		'Logistics_1',
		'Transportation_1',
		'Anti-Infantry_2',
		'Armor_2',
		'ZERO_Score_2',
		'Logistics_2',
		'Transportation_2',
		'Balance_Differential',
		'Logistics_Diff',
		'Transportation_Diff',
		'Anti-Infantry_Diff',
		'Armor_Diff',
		'ZERO_Score_Diff',
	] as const,
	string: ['Level', 'Layer', 'Size', 'Faction_1', 'Faction_2', 'SubFac_1', 'SubFac_2', 'Gamemode', 'LayerVersion'] as const,
} satisfies { [key in ColumnType]: (keyof Layer)[] }
export const COLUMN_KEYS = [...COLUMN_TYPE_MAPPING.numeric, ...COLUMN_TYPE_MAPPING.string]

export type StringColumn = (typeof COLUMN_TYPE_MAPPING)['string'][number]
export type NumericColumn = (typeof COLUMN_TYPE_MAPPING)['numeric'][number]
export const COMPARISON_TYPES = [
	{ coltype: 'numeric', code: 'lt', displayName: 'Less Than' },
	{ coltype: 'numeric', code: 'gt', displayName: 'Greater Than' },
	{ coltype: 'numeric', code: 'inrange', displayName: 'In Range' },
	{ coltype: 'string', code: 'in', displayName: 'In' },
	{ coltype: 'string', code: 'eq', displayName: 'Equals' },
] as const satisfies ComparisonType[]

export function getComparisonTypesForColumn(column: LayerKey) {
	console.assert(Object.keys(COLUMN_TYPE_MAPPING).length === 2)
	const colType = COLUMN_TYPE_MAPPING.numeric.includes(column) ? 'numeric' : 'string'
	return COMPARISON_TYPES.filter((type) => type.coltype === colType)
}

export type EditableComparison = {
	column?: LayerKey
	code?: (typeof COMPARISON_TYPES)[number]['code']
	value?: number | string
	values?: string[]
}

export const LessThanComparison = z.object({
	code: z.literal('lt'),
	value: z.number(),
	column: z.enum(COLUMN_TYPE_MAPPING.numeric),
})
export type LessThanComparison = z.infer<typeof LessThanComparison>

export const GreaterThanComparison = z.object({
	code: z.literal('gt'),
	value: z.number(),
	column: z.enum(COLUMN_TYPE_MAPPING.numeric),
})
export type GreaterThanComparison = z.infer<typeof GreaterThanComparison>

export const InRangeComparison = z.object({
	code: z.literal('inrange'),
	min: z.number(),
	max: z.number(),
	column: z.enum(COLUMN_TYPE_MAPPING.numeric),
})
export type InRangeComparison = z.infer<typeof InRangeComparison>

export type NumericComparison = LessThanComparison | GreaterThanComparison | InRangeComparison

export const InComparison = z.object({
	code: z.literal('in'),
	values: z.array(z.string()),
	column: z.enum(COLUMN_TYPE_MAPPING.string),
})
export type InComparison = z.infer<typeof InComparison>

export const EqualComparison = z.object({
	code: z.literal('eq'),
	value: z.string(),
	column: z.enum(COLUMN_TYPE_MAPPING.string),
})
export type EqualComparison = z.infer<typeof EqualComparison>

export type StringComparison = InComparison | EqualComparison

// Combine into the final ComparisonSchema
export const ComparisonSchema = z
	.discriminatedUnion('code', [LessThanComparison, GreaterThanComparison, InRangeComparison, InComparison, EqualComparison])
	.refine((comp) => COMPARISON_TYPES.some((type) => type.code === comp.code), { message: 'Invalid comparison type' })
	.refine(
		(comp) => {
			const coltype = COMPARISON_TYPES.find((type) => type.code === comp.code)!.coltype
			return coltype === 'numeric'
				? (COLUMN_TYPE_MAPPING.numeric as string[]).includes(comp.column)
				: (COLUMN_TYPE_MAPPING.string as string[]).includes(comp.column)
		},
		{ message: 'Invalid column type for comparison type' }
	)

export type Layer = z.infer<typeof ProcessedLayerSchema>
export type LayerKey = keyof Layer
export type Comparison = z.infer<typeof ComparisonSchema>

// TODO add 'not'
export const BaseFilterNodeSchema = z.object({
	type: z.union([z.literal('and'), z.literal('or'), z.literal('comp')]),
	comp: ComparisonSchema.optional(),
})

export type FilterNode = z.infer<typeof BaseFilterNodeSchema> & { children?: FilterNode[] }
export type EditableFilterNode =
	| {
			type: 'and'
			children: EditableFilterNode[]
	  }
	| {
			type: 'or'
			children: EditableFilterNode[]
	  }
	| {
			type: 'comp'
			comp: EditableComparison
	  }

export const FilterNodeSchema: z.ZodType<FilterNode> = BaseFilterNodeSchema.extend({
	children: z.lazy(() => FilterNodeSchema.array().optional()),
})
	.refine((node) => node.type !== 'comp' || node.comp !== undefined, { message: 'comp must be defined for type "comp"' })
	.refine((node) => node.type !== 'comp' || node.children === undefined, { message: 'children must not be defined for type "comp"' })
	.refine((node) => !['and', 'or'].includes(node.type) || (node.children && node.children.length > 0), {
		message: 'children must be defined for type "and" or "or"',
	})
