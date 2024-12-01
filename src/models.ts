import * as z from 'zod'

import LayerComponents from './assets/layer-components.json'
import * as C from './lib/constants'
import { deepClone, reverseMapping, selectProps } from './lib/object'
import { Parts } from './lib/types'
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

export const LAYER_STRING_PROPERTIES = ['Level', 'Gamemode', 'LayerVersion'] as const satisfies (keyof MiniLayer)[]
export function parseLayerString(layer: string) {
	// eslint-disable-next-line prefer-const
	let [level, gamemode, version] = layer.split('_')
	if (level === 'JensensRange') gamemode = 'Training'
	return { level: level, gamemode: gamemode, version: version?.toUpperCase() ?? null }
}
export function getLayerString(details: Pick<MiniLayer, 'Level' | 'Gamemode' | 'LayerVersion'>) {
	if (details.Level === 'JensensRange') {
		return `${details.Level}_Training`
	}
	let layer = `${details.Level}_${details.Gamemode}`
	if (details.LayerVersion) layer += `_${details.LayerVersion.toLowerCase()}`
	return layer
}

export function getLayerId(layer: LayerIdArgs) {
	let mapLayer = `${MAP_ABBREVIATION[layer.Level]}-${layer.Gamemode}`
	if (layer.LayerVersion) mapLayer += `-${layer.LayerVersion.toUpperCase()}`

	let faction1 = layer.Faction_1
	if (layer.SubFac_1) faction1 += `-${UNIT_ABBREVIATION[layer.SubFac_1]}`

	let faction2 = layer.Faction_2
	if (layer.SubFac_2) faction2 += `-${UNIT_ABBREVIATION[layer.SubFac_2]}`

	return `${mapLayer}:${faction1}:${faction2}`
}

export function getMiniLayerFromId(id: string): MiniLayer {
	const [mapPart, faction1Part, faction2Part] = id.split(':')
	const [mapAbbr, gamemode, versionPart] = mapPart.split('-')
	const level = LEVEL_ABBREVIATION_REVERSE[mapAbbr]
	if (!level) {
		throw new Error(`Invalid map abbreviation: ${mapAbbr}`)
	}
	const [faction1, subfac1] = parseFactionPart(faction1Part)
	const [faction2, subfac2] = parseFactionPart(faction2Part)

	const layerVersion = versionPart ? versionPart.toUpperCase() : null
	let layer: string | undefined
	if (level === 'JensensRange') {
		layer = `${level}_${faction1}-${faction2}`
	} else {
		layer = LayerComponents.layers.find(
			(l) => l.startsWith(`${level}_${gamemode}`) && (layerVersion ? l.endsWith(layerVersion.toLowerCase()) : true)
		)
	}
	if (!layer) {
		throw new Error(`Invalid layer: ${level}_${gamemode}${layerVersion ? `_${layerVersion}` : ''}`)
	}

	return {
		id,
		Level: level,
		Layer: layer,
		Gamemode: gamemode,
		LayerVersion: layerVersion,
		Faction_1: faction1,
		SubFac_1: subfac1,
		Faction_2: faction2,
		SubFac_2: subfac2,
	}
}

function validateId(id: string) {
	try {
		getMiniLayerFromId(id)
		return true
	} catch {
		return false
	}
}

export const LayerIdSchema = z.string().refine(validateId, { message: 'Is valid layer id' })
export type LayerId = z.infer<typeof LayerIdSchema>

function parseFactionPart(part: string): [string, C.Subfaction | null] {
	const [faction, subfacAbbr] = part.split('-')
	if (!LayerComponents.factions.includes(faction)) {
		throw new Error(`Invalid faction: ${faction}`)
	}
	const subfac = subfacAbbr ? (SUBFAC_ABBREVIATIONS_REVERSE[subfacAbbr] as C.Subfaction) : null
	if (subfacAbbr && !subfac) {
		throw new Error(`Invalid subfaction abbreviation: ${subfacAbbr}`)
	}
	return [faction, subfac]
}

export function swapFactionsInId(id: string) {
	const [map, faction1, faction2] = id.split(':')
	return `${map}:${faction2}:${faction1}`
}

export type AdminSetNextLayerOptions = {
	Layer: string
	Faction_1: string | null
	SubFac_1: string | null
	Faction_2: string | null
	SubFac_2: string | null
}

export function getAdminSetNextLayerCommand(layer: AdminSetNextLayerOptions) {
	function getFactionModifier(faction: string | null, subFac: string | null) {
		if (!faction) return ''
		return `${subFac ? `+${subFac}` : ''}`
	}

	return `AdminSetNextLayer ${layer.Layer} ${getFactionModifier(layer.Faction_1, layer.SubFac_1)} ${getFactionModifier(
		layer.Faction_2,
		layer.SubFac_2
	)}`
}

export function getSetNextVoteCommand(ids: string[]) {
	return `!genpool ${ids.join(', ')}`
}

export const LEVEL_ABBREVIATION_REVERSE = reverseMapping(LayerComponents.levelAbbreviations)
export const SUBFAC_ABBREVIATIONS_REVERSE = reverseMapping(LayerComponents.subfactionAbbreviations)

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

export function isColType<T extends ColumnType>(col: string, type: T): col is (typeof COLUMN_TYPE_MAPPINGS)[T][number] {
	return (COLUMN_TYPE_MAPPINGS[type] as string[]).includes(col)
}

export const COLUMN_KEYS = [...COLUMN_TYPE_MAPPINGS.string, ...COLUMN_TYPE_MAPPINGS.float, ...COLUMN_TYPE_MAPPINGS.integer] as [
	LayerColumnKey,
	...LayerColumnKey[],
]

// @ts-expect-error initialize
export const COLUMN_KEY_TO_TYPE: Record<LayerColumnKey, ColumnType> = {}
for (const [key, values] of Object.entries(COLUMN_TYPE_MAPPINGS)) {
	for (const value of values) {
		// @ts-expect-error initialize
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
	values?: (string | null)[]
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
	type: z.union([z.literal('and'), z.literal('or'), z.literal('comp'), z.literal('apply-filter')]),
	comp: ComparisonSchema.optional(),
	// negations
	neg: z.boolean(),
	filterId: z.lazy(() => FilterEntityIdSchema).optional(),
})

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

export type BlockTypeEditableFilterNode = Extract<EditableFilterNode, { type: BlockType }>

export const BLOCK_TYPES = ['and', 'or'] as const
export function isBlockType(type: string): type is BlockType {
	return BLOCK_TYPES.includes(type as BlockType)
}
export function isBlockNode<T extends FilterNode>(node: T): node is Extract<T, { type: BlockType }> {
	return BLOCK_TYPES.includes(node.type as BlockType)
}

export function isEditableBlockNode(node: EditableFilterNode): node is Extract<EditableFilterNode, { type: BlockType }> {
	return BLOCK_TYPES.includes(node.type as BlockType)
}
export type BlockType = (typeof BLOCK_TYPES)[number]

export function isValidFilterNode(node: EditableFilterNode): node is FilterNode {
	if (!isLocallyValidFilterNode(node)) return false
	if (node.type === 'and' || node.type === 'or') return node.children.every((child) => isValidFilterNode(child))
	return true
}

// excludes children
export function isLocallyValidFilterNode(node: EditableFilterNode) {
	if (node.type === 'and' || node.type === 'or') return true
	if (node.type === 'comp') return isValidComparison(node.comp)
	if (node.type === 'apply-filter') return isValidApplyFilterNode(node)
	throw new Error('Invalid node type')
}

export function isValidComparison(comp: EditableComparison): comp is Comparison {
	return !!comp.code && !!comp.column && (comp.code === 'in' ? comp.values : comp.value) !== undefined
}
export function isValidApplyFilterNode(node: EditableFilterNode & { type: 'apply-filter' }): node is FilterNode & { type: 'apply-filter' } {
	return !!node.filterId
}

export const FilterNodeSchema = BaseFilterNodeSchema.extend({
	children: z.lazy(() => FilterNodeSchema.array().optional()),
})
	.refine((node) => node.type !== 'comp' || node.comp !== undefined, { message: 'comp must be defined for type "comp"' })
	.refine((node) => node.type !== 'comp' || node.children === undefined, { message: 'children must not be defined for type "comp"' })
	.refine((node) => node.type !== 'apply-filter' || typeof node.filterId === 'string', {
		message: 'filterId must be defined for type "apply-filter"',
	})
	.refine((node) => !['and', 'or'].includes(node.type) || node.children, {
		message: 'children must be defined for type "and" or "or"',
	}) as z.ZodType<FilterNode>

export const LayerVoteSchema = z.object({
	defaultChoice: LayerIdSchema,
	choices: z.array(LayerIdSchema),
})

export const LayerQueueItemSchema = z.object({
	layerId: LayerIdSchema.optional(),
	vote: LayerVoteSchema.optional(),
	generated: z.boolean(),
})

export const LayerQueueSchema = z.array(LayerQueueItemSchema)

export type LayerQueue = z.infer<typeof LayerQueueSchema>
export type LayerQueueItem = z.infer<typeof LayerQueueItemSchema>
// doing this because Omit<> sucks to work with

export function preprocessLevel(level: string) {
	if (level.startsWith('Sanxian')) return 'Sanxian'
	if (level.startsWith('Belaya')) return 'Belaya'
	return level
}

export const MiniLayerSchema = z.object({
	id: LayerIdSchema,
	Level: z.string().transform(preprocessLevel),
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

export function isFullMiniLayer(layer: Partial<MiniLayer>): layer is MiniLayer {
	return MiniLayerSchema.safeParse(layer).success
}

export type MiniUser = {
	username: string
	discordId: string
}

export type LayerVote = unknown

export const FilterUpdateSchema = z.object({
	name: z.string().trim().min(3).max(128),
	description: z.string().trim().min(3).max(512).nullable(),
	filter: FilterNodeSchema,
}) satisfies z.ZodType<Partial<Schema.Filter>>

function filterContainsId(id: string, node: FilterNode): boolean {
	if (node.type === 'and' || node.type === 'or') return node.children.every((n) => filterContainsId(id, n))
	if (node.type === 'comp') return false
	return node.filterId === id
}

export const FilterEntityIdSchema = z
	.string()
	.trim()
	.regex(/^[a-z0-9-_]+$/, { message: '"Must contain only lowercase letters, numbers, hyphens, and underscores"' })
	.min(3)
	.max(64)
export type FilterEntityId = z.infer<typeof FilterEntityIdSchema>

export const FilterEntitySchema = z
	.object({
		id: FilterEntityIdSchema,
		name: z.string().trim().min(3).max(128),
		description: z.string().trim().min(3).max(512).nullable(),
		filter: FilterNodeSchema,
	})
	// this refinement does not deal with mutual recustion
	.refine((e) => !filterContainsId(e.id, e.filter), { message: 'filter cannot be recursive' }) satisfies z.ZodType<Schema.Filter>

export type FilterEntityUpdate = z.infer<typeof FilterUpdateSchema>
export type FilterEntity = z.infer<typeof FilterEntitySchema>
export const StartVoteSchema = z.object({
	seqId: z.number(),
	restart: z.boolean().default(false),
})
export type LayerQueueUpdate = z.infer<typeof GenericServerStateUpdateSchema>
const TallyProperties = {
	votes: z.record(z.string(), LayerIdSchema),
	deadline: z.number(),
	defaultChoice: LayerIdSchema,
	choices: z.array(LayerIdSchema),
}
export const VoteStateSchema = z.discriminatedUnion('code', [
	z.object({ code: z.literal('ready') }),
	z.object({
		code: z.literal('in-progress'),
		...TallyProperties,
	}),
	z.object({
		code: z.literal('ended:winner'),
		winner: LayerIdSchema,
		...TallyProperties,
	}),
	z.object({
		code: z.literal('ended:aborted'),
		abortReason: z.enum(['timeout:insufficient-votes', 'manual']),
		aborter: z.string().optional(),
		...TallyProperties,
	}),
])

export function tallyVotes(currentVote: VoteStateWithVoteData) {
	if (Object.values(currentVote.choices).length == 0) throw new Error('No chlices listsed')
	const tally = new Map<string, number>()
	let maxVotes: string | null = null
	for (const choice of currentVote.choices) {
		tally.set(choice, 0)
	}

	for (const choice of Object.values(currentVote.votes)) {
		tally.set(choice, tally.get(choice)! + 1)

		if (maxVotes === null || tally.get(choice)! > tally.get(maxVotes)!) {
			maxVotes = choice
		}
	}
	const totalVotes = Object.values(currentVote.votes).length
	return { totals: tally, totalVotes, choice: maxVotes, votes: tally.get(maxVotes!)! }
}

export function getVoteTallyProperties(state: Exclude<VoteState, { code: 'ready' }>) {
	return selectProps(state, ['votes', 'deadline', 'choices', 'defaultChoice'])
}

export type VoteState = z.infer<typeof VoteStateSchema>
export type VoteStateWithVoteData = Extract<VoteState, { code: 'in-progress' | 'ended:winner' | 'ended:aborted' }>
export const ServerSettingsSchema = z
	.object({
		queue: z
			.object({
				poolFilterId: FilterEntityIdSchema.optional(),
				preferredLength: z.number().default(12),
			})
			.default({
				preferredLength: 12,
			}),
	})
	// avoid sharing default queue object
	.transform((obj) => deepClone(obj))

export type ServerSettings = z.infer<typeof ServerSettingsSchema>

export const ServerStateSchema = z.object({
	id: z.string().min(1).max(256),
	online: z.boolean(),
	displayName: z.string().min(1).max(256),
	layerQueueSeqId: z.number().int(),
	layerQueue: LayerQueueSchema,
	currentVote: VoteStateSchema.nullable(),
	settings: ServerSettingsSchema,
}) satisfies z.ZodType<Schema.Server>

export type ServerState = z.infer<typeof ServerStateSchema>
export type UserPart = Parts<{ users: Schema.User[] }>
export type LayerSyncState =
	| {
			// for when the expected layer in the app's backend memory is not what's currently on the server, aka we're waiting for the squad server to tell us that its current layer has been updated
			status: 'desynced'
			// local in this case meaning our application server
			expected: string
			current: string
	  }
	| {
			// server offline
			status: 'offline'
	  }
	| {
			// expected layer is on the server
			status: 'synced'
			value: string
	  }

// for the basic dialog
export const GenericServerStateUpdateSchema = z.object({
	seqId: z.number(),
	queue: LayerQueueSchema,
	settings: ServerSettingsSchema,
})

// represents a user's edit or deletion of an entity
export type UserEntityMutation<K> = {
	username: string
	value: K
	type: 'add' | 'update' | 'delete'
}
