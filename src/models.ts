import * as VE from '@/lib/validation-errors.ts'
import * as z from 'zod'

import * as C from './lib/constants'
import { reverseMapping } from './lib/object'
import type * as Schema from './server/schema'

export const getLayerKey = (layer: Layer) =>
	`${layer.Level}-${layer.Layer}-${layer.Faction_1}-${layer.SubFac_1}-${layer.Faction_2}-${layer.SubFac_2}`

export type Layer = Schema.Layer
export type Subfaction = C.Subfaction

const MAP_ABBREVIATION = {
	AlBasrah: 'AB',
	Anvil: 'AN',
	Belaya: 'BL',
	BlackCoast: 'BC',
	Chora: 'CH',
	Fallujah: 'FL',
	FoolsRoad: 'FR',
	GooseBay: 'GB',
	Gorodok: 'GD',
	Harju: 'HJ',
	Kamdesh: 'KD',
	Kohat: 'KH',
	Kokan: 'KK',
	Lashkar: 'LK',
	Logar: 'LG',
	Manicouagan: 'MN',
	Mestia: 'MS',
	Mutaha: 'MT',
	Narva: 'NV',
	PacificProvingGrounds: 'PPG',
	Sanxian: 'SX',
	Skorpo: 'SK',
	Sumari: 'SM',
	Tallil: 'TL',
	Yehorivka: 'YH',
	JensensRange: 'JR',
} as Record<string, string>

const UNIT_ABBREVIATION = {
	AirAssault: 'AA',
	Armored: 'AR',
	CombinedArms: 'CA',
	LightInfantry: 'LI',
	Mechanized: 'MZ',
	Motorized: 'MT',
	Support: 'SP',
} as Record<string, string>

export type LayerIdArgs = {
	Level: string
	Gamemode: string
	LayerVersion: string | null
	Faction_1: string
	SubFac_1: string | null
	Faction_2: string
	SubFac_2: string | null
}

export function parseLayerString(layer: string) {
	// eslint-disable-next-line prefer-const
	let [level, gamemode, version] = layer.split('_')
	if (level === 'JensensRange') gamemode = 'Training'
	return { level, gamemode, version: version?.toUpperCase() ?? null }
}

export function getLayerId(layer: LayerIdArgs) {
	let mapLayer = `${MAP_ABBREVIATION[layer.Level]}-${layer.Gamemode}`
	if (layer.LayerVersion) mapLayer += `-${layer.LayerVersion}`

	let faction1 = layer.Faction_1
	if (layer.SubFac_1) faction1 += `-${UNIT_ABBREVIATION[layer.SubFac_1]}`

	let faction2 = layer.Faction_2
	if (layer.SubFac_2) faction2 += `-${UNIT_ABBREVIATION[layer.SubFac_2]}`

	return `${mapLayer}:${faction1}:${faction2}`
}

export function swapFactionsInId(id: string) {
	const [map, faction1, faction2] = id.split(':')
	return `${map}:${faction2}:${faction1}`
}

export function getAdminSetNextLayerCommand(layer: {
	Layer: string
	Faction_1: string | null
	SubFac_1: string | null
	Faction_2: string | null
	SubFac_2: string | null
}) {
	function getFactionModifier(faction: string | null, subFac: string | null) {
		if (!faction) return ''
		return `${subFac ? `+${subFac}` : ''}`
	}

	return `AdminSetNextLayer ${layer.Layer} ${getFactionModifier(layer.Faction_1, layer.SubFac_1)} ${getFactionModifier(layer.Faction_2, layer.SubFac_2)}`
}

export function getSetNextVoteCommand(ids: string[]) {
	return `!genpool ${ids.join(', ')}`
}

export const MAP_ABBREVIATION_REVERSE = reverseMapping(MAP_ABBREVIATION)
export const UNIT_ABBREVIATION_REVERSE = reverseMapping(UNIT_ABBREVIATION)

type ComparisonType = {
	coltype: 'string' | 'float' | 'integer'
	code: string
	displayName: string
}
export const COLUMN_TYPES = ['float', 'string', 'integer'] as const
export type ColumnType = (typeof COLUMN_TYPES)[number]

export type StringColumn = (typeof COLUMN_TYPE_MAPPINGS)['string'][number]
export type FloatColumn = (typeof COLUMN_TYPE_MAPPINGS)['float'][number]
export const COMPARISON_TYPES = [
	{ coltype: 'float', code: 'lt', displayName: 'Less Than' },
	{ coltype: 'float', code: 'gt', displayName: 'Greater Than' },
	{ coltype: 'float', code: 'inrange', displayName: 'In Range' },
	{ coltype: 'string', code: 'in', displayName: 'In' },
	{ coltype: 'string', code: 'eq', displayName: 'Equals' },
	{ coltype: 'string', code: 'like', displayName: 'Like' },
] as const satisfies ComparisonType[]

// we're keeping this definition separate to reduce type inference a bit
export const COLUMN_TYPE_MAPPINGS = {
	float: [
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
		'Asymmetry Score',
		'Logistics_Diff',
		'Transportation_Diff',
		'Anti-Infantry_Diff',
		'Armor_Diff',
		'ZERO_Score_Diff',
	] as const,
	string: ['id', 'Level', 'Layer', 'Size', 'Faction_1', 'Faction_2', 'SubFac_1', 'SubFac_2', 'Gamemode', 'LayerVersion'] as const,
	integer: [] as const,
} satisfies { [key in ColumnType]: LayerColumnKey[] }

export const COLUMN_KEYS = [...COLUMN_TYPE_MAPPINGS.string, ...COLUMN_TYPE_MAPPINGS.float, ...COLUMN_TYPE_MAPPINGS.integer] as [
	LayerColumnKey,
	...LayerColumnKey[],
]

//@ts-expect-error initialize
export const COLUMN_KEY_TO_TYPE: Record<LayerColumnKey, ColumnType> = {}
for (const [key, values] of Object.entries(COLUMN_TYPE_MAPPINGS)) {
	for (const value of values) {
		//@ts-expect-error initialize
		COLUMN_KEY_TO_TYPE[value] = key
	}
}

export function getComparisonTypesForColumn(column: LayerColumnKey) {
	const colType = COLUMN_KEY_TO_TYPE[column]
	return COMPARISON_TYPES.filter((type) => type.coltype === colType)
}

export type EditableComparison = {
	column?: LayerColumnKey
	code?: (typeof COMPARISON_TYPES)[number]['code']
	value?: number | string | null
	values?: string[]
	min?: number
	max?: number
}

export const LessThanComparison = z.object({
	code: z.literal('lt'),
	value: z.number(),
	column: z.enum(COLUMN_TYPE_MAPPINGS.float),
})
export type LessThanComparison = z.infer<typeof LessThanComparison>

export const GreaterThanComparison = z.object({
	code: z.literal('gt'),
	value: z.number(),
	column: z.enum(COLUMN_TYPE_MAPPINGS.float),
})
export type GreaterThanComparison = z.infer<typeof GreaterThanComparison>

export const InRangeComparison = z.object({
	code: z.literal('inrange'),
	min: z.number(),
	max: z.number(),
	column: z.enum(COLUMN_TYPE_MAPPINGS.float),
})
export type InRangeComparison = z.infer<typeof InRangeComparison>

export type NumericComparison = LessThanComparison | GreaterThanComparison | InRangeComparison

export const InComparison = z.object({
	code: z.literal('in'),
	values: z.array(z.string().nullable()),
	column: z.enum(COLUMN_TYPE_MAPPINGS.string),
})
export type InComparison = z.infer<typeof InComparison>

export const EqualComparison = z.object({
	code: z.literal('eq'),
	value: z.string().nullable(),
	column: z.enum(COLUMN_TYPE_MAPPINGS.string),
})
export type EqualComparison = z.infer<typeof EqualComparison>

export const LikeComparison = z.object({
	code: z.literal('like'),
	value: z.string(),
	column: z.enum(COLUMN_TYPE_MAPPINGS.string),
})

export type LikeComparison = z.infer<typeof LikeComparison>

export type StringComparison = InComparison | EqualComparison | LikeComparison

// Combine into the final ComparisonSchema
export const ComparisonSchema = z
	.discriminatedUnion('code', [LessThanComparison, GreaterThanComparison, InRangeComparison, InComparison, EqualComparison, LikeComparison])
	.refine((comp) => COMPARISON_TYPES.some((type) => type.code === comp.code), { message: 'Invalid comparison type' })
	.refine(
		(comp) => {
			const coltype = COMPARISON_TYPES.find((type) => type.code === comp.code)!.coltype
			return COLUMN_KEY_TO_TYPE[comp.column] === coltype
		},
		{ message: 'Invalid column type for comparison type' }
	)

export type LayerColumnKey = keyof Layer
export type Comparison = z.infer<typeof ComparisonSchema>

// TODO add 'not'
export const BaseFilterNodeSchema = z.object({
	type: z.union([z.literal('and'), z.literal('or'), z.literal('comp')]),
	comp: ComparisonSchema.optional(),
})

export type FilterNode =
	| {
			type: 'and'
			children: FilterNode[]
	  }
	| {
			type: 'or'
			children: FilterNode[]
	  }
	| {
			type: 'comp'
			comp: Comparison
	  }

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

//@ts-expect-error it works
export function isValidFilterNode(node: EditableFilterNode): node is FilterNode {
	if (node.type === 'comp') {
		return isValidComparison(node.comp)
	}
	return node.children.every((child) => isValidFilterNode(child))
}

// excludes children
export function isLocallyValidFilterNode(node: EditableFilterNode, depth: number) {
	if (node.type === 'and' || node.type === 'or') return true
	if (node.type === 'comp') return isValidComparison(node.comp)
	throw new Error('Invalid node type')
}

export function isValidComparison(comp: EditableComparison): comp is Comparison {
	return !!comp.code && !!comp.column && (comp.code === 'in' ? comp.values : comp.value) !== undefined
}

export const FilterNodeSchema = BaseFilterNodeSchema.extend({
	children: z.lazy(() => FilterNodeSchema.array().optional()),
})
	.refine((node) => node.type !== 'comp' || node.comp !== undefined, { message: 'comp must be defined for type "comp"' })
	.refine((node) => node.type !== 'comp' || node.children === undefined, { message: 'children must not be defined for type "comp"' })
	.refine((node) => !['and', 'or'].includes(node.type) || node.children, {
		message: 'children must be defined for type "and" or "or"',
	}) as z.ZodType<FilterNode>

export const LayerVoteSchema = z.object({
	defaultChoiceLayerId: z.string(),
	choiceLayerIds: z.record(z.string(), z.number()),
	voteDeadline: z.string().optional(),
	votes: z.record(z.string(), z.array(z.bigint())).optional(),
})

export const LayerQueueItemSchema = z.object({ layerId: z.string().optional(), vote: LayerVoteSchema.optional(), generated: z.boolean() })
export const LayerQueueSchema = z.array(LayerQueueItemSchema)

export type LayerQueue = z.infer<typeof LayerQueueSchema>
export type LayerQueueItem = z.infer<typeof LayerQueueItemSchema>
// doing this because Omit<> sucks to work with

export const MiniLayerSchema = z.object({
	id: z.string(),
	Level: z.string(),
	Layer: z.string(),
	Gamemode: z.string(),
	LayerVersion: z
		.string()
		.nullable()
		.transform((v) => (v === null ? v : v.toUpperCase())),
	Faction_1: z.string(),
	SubFac_1: z.enum(C.SUBFACTIONS).nullable(),
	Faction_2: z.string(),
	SubFac_2: z.enum(C.SUBFACTIONS).nullable(),
})

export type MiniLayer = z.infer<typeof MiniLayerSchema>

export type LayerVote = unknown

export type MiniUser = {
	steamId: bigint
	username: string
}

export const FilterUpdateSchema = z.object({
	name: z.string().trim().min(3).max(128),
	description: z.string().trim().min(3).max(512).nullable(),
	filter: FilterNodeSchema,
})
export const FilterEntitySchema = FilterUpdateSchema.extend({
	id: z
		.string()
		.trim()
		.regex(/^[a-z0-9-_]+$/, { message: '"Must contain only lowercase letters, numbers, hyphens, and underscores"' })
		.min(3)
		.max(64),
})

export type FilterEntityUpdate = z.infer<typeof FilterUpdateSchema>
export type FilterEntity = z.infer<typeof FilterEntitySchema>

export const ServerStateSchema = z.object({
	seqId: z.number(),
	queue: LayerQueueSchema,
	nowPlaying: z.union([z.string(), z.null()]),
	poolFilterId: FilterEntitySchema.shape.id.nullable(),
})

export type ServerState = z.infer<typeof ServerStateSchema>

export type ServerState_Denorm = ServerState & {
	layers: MiniLayer[]
	poolFilter?: FilterEntity
}
