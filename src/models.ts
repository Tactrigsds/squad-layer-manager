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
	LayerVersion: string
	Faction_1: string
	SubFac_1: string
	Faction_2: string
	SubFac_2: string
}

export function parseLayerString(layer: string) {
	const [level, gamemode, version] = layer.split('_')
	return { level, gamemode, version }
}

export function getLayerId(layer: LayerIdArgs) {
	const mapLayer = `${MAP_ABBREVIATION[layer.Level]}-${layer.Gamemode}-${layer.LayerVersion.toUpperCase()}`
	const faction1 = `${[layer.Faction_1]}-${UNIT_ABBREVIATION[layer.SubFac_1]}`
	const faction2 = `${layer.Faction_2}-${UNIT_ABBREVIATION[layer.SubFac_2]}`
	return `${mapLayer}:${faction1}:${faction2}`
}
export function getAdminSetNextLayerCommand(layer: {
	Layer: string
	Faction_1: string
	SubFac_1: string
	Faction_2: string
	SubFac_2: string
}) {
	return `AdminSetNextLayer ${layer.Layer} ${layer.Faction_1}+${layer.SubFac_1} ${layer.Faction_2}+${layer.SubFac_2}`
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
	integer: ['randomOrdinal'] as const,
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
	value?: number | string
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
	values: z.array(z.string()),
	column: z.enum(COLUMN_TYPE_MAPPINGS.string),
})
export type InComparison = z.infer<typeof InComparison>

export const EqualComparison = z.object({
	code: z.literal('eq'),
	value: z.string(),
	column: z.enum(COLUMN_TYPE_MAPPINGS.string),
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
			return coltype === 'float'
				? (COLUMN_TYPE_MAPPINGS.float as string[]).includes(comp.column)
				: (COLUMN_TYPE_MAPPINGS.string as string[]).includes(comp.column)
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

//@ts-expect-error it works
export function isValidFilterNode(node: EditableFilterNode): node is FilterNode {
	if (node.type === 'comp') {
		return isValidComparison(node.comp)
	}
	return node.children.length > 0 && node.children.every((child) => isValidFilterNode(child))
}

// excludes children
export function isLocallyValidFilterNode(node: EditableFilterNode, depth: number) {
	if (node.type === 'and' || node.type === 'or') return depth === 0 || node.children.length > 0
	if (node.type === 'comp') return isValidComparison(node.comp)
	throw new Error('Invalid node type')
}

export function isValidComparison(comp: EditableComparison): comp is Comparison {
	return !!comp.code && !!comp.column && (comp.code === 'in' ? comp.values : comp.value) !== undefined
}

export const FilterNodeSchema: z.ZodType<FilterNode> = BaseFilterNodeSchema.extend({
	children: z.lazy(() => FilterNodeSchema.array().optional()),
})
	.refine((node) => node.type !== 'comp' || node.comp !== undefined, { message: 'comp must be defined for type "comp"' })
	.refine((node) => node.type !== 'comp' || node.children === undefined, { message: 'children must not be defined for type "comp"' })
	.refine((node) => !['and', 'or'].includes(node.type) || (node.children && node.children.length > 0), {
		message: 'children must be defined for type "and" or "or"',
	})

export const LayerVoteSchema = z.object({
	defaultChoiceLayerId: z.string(),
	choiceLayerIds: z.record(z.string(), z.number()),
	voteDeadline: z.string().optional(),
	votes: z.record(z.string(), z.array(z.bigint())).optional(),
})

export const LayerQueueItemSchema = z.object({ layerId: z.string().optional(), vote: LayerVoteSchema.optional(), generated: z.boolean() })
export const LayerQueueSchema = z.array(LayerQueueItemSchema)

export type LayerQueue = z.infer<typeof LayerQueueSchema>
export type LayerQueueItem = LayerQueue[number]
// doing this because Omit<> sucks to work with
export type MiniLayer = {
	id: Layer['id']
	Level: Layer['Level']
	Layer: Layer['Layer']
	Gamemode: Layer['Gamemode']
	LayerVersion: Layer['LayerVersion']
	Faction_1: Layer['Faction_1']
	SubFac_1: Layer['SubFac_1']
	Faction_2: Layer['Faction_2']
	SubFac_2: Layer['SubFac_2']
}

export type LayerVote = unknown

export type MiniUser = {
	steamId: bigint
	username: string
}

export const LayerQueueUpdateSchema = z.object({
	seqId: z.number(),
	queue: LayerQueueSchema,
	nowPlaying: z.union([z.string(), z.null()]),
})

export type LayerQueueUpdate = z.infer<typeof LayerQueueUpdateSchema>

export type LayerQueueUpdate_Denorm = LayerQueueUpdate & {
	layers: MiniLayer[]
}

export type ServerStatus = {
	name: string
	currentPlayers: number
	maxPlayers: number
	currentPlayersInQueue: number
	currentVIPsInQueue: number
	currentLayer: MiniLayer
	nextLayer: MiniLayer
}
