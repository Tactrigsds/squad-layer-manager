import * as z from 'zod'

import LayerComponents from '$root/assets/layer-components.json'
import * as C from './lib/constants'
import { deepClone, reverseMapping } from './lib/object'
import type * as SchemaModels from '$root/drizzle/schema.models'
import { Parts } from './lib/types'
import * as RBAC from '@/rbac.models'
import { PercentageSchema } from './lib/zod'
import { assertNever } from './lib/typeGuards'

export const getLayerKey = (layer: Layer) =>
	`${layer.Level}-${layer.Layer}-${layer.Faction_1}-${layer.SubFac_1}-${layer.Faction_2}-${layer.SubFac_2}`

export const DEFAULT_LAYER_ID = 'GD-RAAS-V1:US-CA:RGF-CA'
export type Layer = SchemaModels.Layer & MiniLayer
export type Subfaction = C.Subfaction

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
	return {
		level: level,
		gamemode: gamemode,
		version: version?.toUpperCase() ?? null,
	}
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
	let mapLayer = `${LayerComponents.levelAbbreviations[layer.Level as keyof typeof LayerComponents.levelAbbreviations]}-${layer.Gamemode}`
	if (layer.LayerVersion) mapLayer += `-${layer.LayerVersion.toUpperCase()}`

	const team1 = getLayerTeamString(layer.Faction_1, layer.SubFac_1)
	const team2 = getLayerTeamString(layer.Faction_2, layer.SubFac_2)
	return `${mapLayer}:${team1}:${team2}`
}

export function getLayerTeamString(faction: string, subfac: string | null) {
	const abbrSubfac = subfac ? LayerComponents.subfactionAbbreviations[subfac as keyof typeof LayerComponents.subfactionAbbreviations] : ''
	return abbrSubfac ? `${faction}-${abbrSubfac}` : faction
}
export function parseTeamString(team: string): { faction: string; subfac: string | null } {
	const [faction, subfac] = team.split('-')
	return {
		faction,
		subfac: subfac ? SUBFAC_ABBREVIATIONS_REVERSE[subfac] : null,
	}
}

export function getMiniLayerFromId(id: string): MiniLayer {
	// console.trace('getMiniLayerFromId', id)
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
			(l) => l.startsWith(`${level}_${gamemode}`) && (!layerVersion || l.endsWith(layerVersion.toLowerCase()))
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

export const LayerIdSchema = z.string().refine(validateId, {
	message: 'Is valid layer id',
})
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
	Faction_1: string
	SubFac_1: string | null
	Faction_2: string
	SubFac_2: string | null
}

export function getAdminSetNextLayerCommand(layer: AdminSetNextLayerOptions) {
	function getFactionModifier(faction: string, subFac: string | null) {
		return ` ${faction}${subFac ? `+${subFac}` : ''}`
	}
	if (layer.Layer.startsWith('JensensRange')) {
		return `AdminSetNextLayer ${layer.Layer}`
	}

	return `AdminSetNextLayer ${layer.Layer}${getFactionModifier(layer.Faction_1, layer.SubFac_1)}${getFactionModifier(
		layer.Faction_2,
		layer.SubFac_2
	)}`
}

export function getSetNextVoteCommand(ids: string[]) {
	return `!genpool ${ids.join(', ')}`
}

export const LEVEL_ABBREVIATION_REVERSE = reverseMapping(LayerComponents.levelAbbreviations)
export const SUBFAC_ABBREVIATIONS_REVERSE = reverseMapping(LayerComponents.subfactionAbbreviations)

export const COLUMN_TYPES = ['float', 'string', 'integer', 'collection', 'boolean'] as const
export type ColumnType = (typeof COLUMN_TYPES)[number]

type ComparisonType = {
	coltype: ColumnType
	code: string
	displayName: string
}

export type StringColumn = (typeof COLUMN_TYPE_MAPPINGS)['string'][number]
export type FloatColumn = (typeof COLUMN_TYPE_MAPPINGS)['float'][number]
export type CollectionColumn = (typeof COLUMN_TYPE_MAPPINGS)['collection'][number]
export const COMPARISON_TYPES = [
	{ coltype: 'float', code: 'lt', displayName: 'Less Than' },
	{ coltype: 'float', code: 'gt', displayName: 'Greater Than' },
	{ coltype: 'float', code: 'inrange', displayName: 'In Range' },
	{ coltype: 'string', code: 'in', displayName: 'In' },
	{ coltype: 'string', code: 'eq', displayName: 'Equals' },
	{ coltype: 'string', code: 'like', displayName: 'Like' },
	{ coltype: 'collection', code: 'has', displayName: 'Has All' },
	{ coltype: 'boolean', code: 'is-true', displayName: 'Is True' },
] as const satisfies ComparisonType[]
export type ComparisonCode = (typeof COMPARISON_TYPES)[number]['code']
export const COMPARISON_CODES = COMPARISON_TYPES.map((type) => type.code)

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
		'Asymmetry_Score',
		'Logistics_Diff',
		'Transportation_Diff',
		'Anti-Infantry_Diff',
		'Armor_Diff',
		'ZERO_Score_Diff',
	] as const,
	string: ['id', 'Level', 'Layer', 'Size', 'Faction_1', 'Faction_2', 'SubFac_1', 'SubFac_2', 'Gamemode', 'LayerVersion'] as const,
	integer: [] as const,
	collection: ['FactionMatchup', 'FullMatchup', 'SubFacMatchup'] as const,
	boolean: ['Z_Pool', 'Scored'] as const,
} satisfies { [key in ColumnType]: (LayerColumnKey | LayerCompositeKey)[] }

export const COLUMN_LABELS = {
	id: 'ID',
	Level: 'Level',
	Layer: 'Layer',
	Size: 'Size',
	Faction_1: 'T1',
	Faction_2: 'T2',
	SubFac_1: 'SubFac T1',
	SubFac_2: 'SubFac T2',
	Gamemode: 'Gamemode',
	LayerVersion: 'Version',
	'Anti-Infantry_1': 'Anti-Inf T1',
	'Anti-Infantry_2': 'Anti-Inf T2',
	Armor_1: 'Armor T1',
	Armor_2: 'Armor T2',
	ZERO_Score_1: 'ZScore T1',
	ZERO_Score_2: 'ZScore T2',
	Logistics_1: 'Logi T1',
	Logistics_2: 'Logi T2',
	Transportation_1: 'Trans T1',
	Transportation_2: 'Trans T2',
	Balance_Differential: 'Balance',
	Asymmetry_Score: 'Asymm',
	Logistics_Diff: 'Logi Diff',
	Transportation_Diff: 'Trans Diff',
	'Anti-Infantry_Diff': 'Anti-Inf Diff',
	Armor_Diff: 'Armor Diff',
	ZERO_Score_Diff: 'ZScore Diff',
	Z_Pool: 'Z-Pool',
	FactionMatchup: 'Faction Matchup',
	SubFacMatchup: 'Subfac Matchup',
	FullMatchup: 'Full Matchup',
	Scored: 'Scored',
} satisfies { [k in LayerColumnKey | LayerCompositeKey]: string }

export function isColType<T extends ColumnType>(col: string, type: T): col is (typeof COLUMN_TYPE_MAPPINGS)[T][number] {
	return (COLUMN_TYPE_MAPPINGS[type] as string[]).includes(col)
}

export const COLUMN_KEYS = [
	...COLUMN_TYPE_MAPPINGS.string,
	...COLUMN_TYPE_MAPPINGS.float,
	...COLUMN_TYPE_MAPPINGS.integer,
	...COLUMN_TYPE_MAPPINGS.boolean,
] as const

export const COLUMN_KEYS_WITH_COMPUTED = [...COLUMN_KEYS, ...COLUMN_TYPE_MAPPINGS.collection] as [
	LayerColumnKey | LayerCompositeKey,
	...(LayerColumnKey | LayerCompositeKey)[],
]

// @ts-expect-error initialize
export const COLUMN_KEY_TO_TYPE: Record<LayerColumnKey | LayerCompositeKey, ColumnType> = {}
for (const [key, values] of Object.entries(COLUMN_TYPE_MAPPINGS)) {
	for (const value of values) {
		// @ts-expect-error initialize
		COLUMN_KEY_TO_TYPE[value] = key
	}
}

export function getComparisonTypesForColumn(column: LayerColumnKey | LayerCompositeKey) {
	const colType = COLUMN_KEY_TO_TYPE[column]
	return COMPARISON_TYPES.filter((type) => type.coltype === colType)
}

export type EditableComparison = {
	column?: LayerColumnKey | LayerCompositeKey
	code?: (typeof COMPARISON_TYPES)[number]['code']
	value?: number | string | null
	values?: (string | null)[]
	range?: [number | undefined, number | undefined]
}
// --------  numeric --------
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

export const InRangeComparison = z
	.object({
		code: z.literal('inrange'),
		range: z.tuple([z.number(), z.number()]).describe("smallest value is always the start of the range, even if it's larger"),
		column: z.enum(COLUMN_TYPE_MAPPINGS.float),
	})
	.describe('Inclusive Range')

export type InRangeComparison = z.infer<typeof InRangeComparison>

export type NumericComparison = LessThanComparison | GreaterThanComparison | InRangeComparison
// --------  numeric end --------

// --------  string --------
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
// --------  string end --------

// --------  collection --------
export const HasAllComparisonSchema = z.object({
	code: z.literal('has'),
	values: z.array(z.string()),
	column: z.enum(COLUMN_TYPE_MAPPINGS.collection),
})
export type HasComparison = z.infer<typeof HasAllComparisonSchema>
export type CollectionComparison = HasComparison

// --------  collection end --------
//
const IsTrueComparison = z.object({
	code: z.literal('is-true'),
	column: z.enum(COLUMN_TYPE_MAPPINGS.boolean),
})

// Combine into the final ComparisonSchema
export const ComparisonSchema = z
	.discriminatedUnion('code', [
		LessThanComparison,
		GreaterThanComparison,
		InRangeComparison,
		InComparison,
		EqualComparison,
		LikeComparison,
		HasAllComparisonSchema,
		IsTrueComparison,
	])
	.refine((comp) => COMPARISON_TYPES.some((type) => type.code === comp.code), {
		message: 'Invalid comparison type',
	})
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
	neg: z.boolean().default(false),
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
	return FilterNodeSchema.safeParse(node).success
}

// excludes children
export function isLocallyValidFilterNode(node: EditableFilterNode) {
	if (node.type === 'and' || node.type === 'or') return true
	if (node.type === 'comp') return isValidComparison(node.comp)
	if (node.type === 'apply-filter') return isValidApplyFilterNode(node)
	throw new Error('Invalid node type')
}

export function isValidComparison(comp: EditableComparison): comp is Comparison {
	return ComparisonSchema.safeParse(comp).success
}
export function isValidApplyFilterNode(node: EditableFilterNode & { type: 'apply-filter' }): node is FilterNode & { type: 'apply-filter' } {
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
	.refine((node) => node.type !== 'apply-filter' || typeof node.filterId === 'string', {
		message: 'filterId must be defined for type "apply-filter"',
	})
	.refine((node) => !(['and', 'or'].includes(node.type) && !node.children), {
		message: 'children must be defined for type "and" or "or"',
	}) as z.ZodType<FilterNode>

export const RootFilterNodeSchema = FilterNodeSchema.refine((root) => isBlockNode(root), { message: 'Root node must be a block type' })

export const LayerVoteSchema = z.object({
	defaultChoice: LayerIdSchema,
	choices: z.array(LayerIdSchema),
})
export type LayerVote = z.infer<typeof LayerVoteSchema>

export const LayerQueueItemSchema = z.object({
	layerId: LayerIdSchema.optional(),
	vote: LayerVoteSchema.optional(),
	source: z.enum(['generated', 'gameserver', 'manual']),
	lastModifiedBy: z.bigint().optional(),
})

export const LayerQueueSchema = z.array(LayerQueueItemSchema)

export type LayerQueue = z.infer<typeof LayerQueueSchema>
export type LayerListItem = z.infer<typeof LayerQueueItemSchema>
// doing this because Omit<> sucks to work with

export function preprocessLevel(level: string) {
	if (level.startsWith('Sanxian')) return 'Sanxian'
	if (level.startsWith('Belaya')) return 'Belaya'
	if (level.startsWith('Albasra')) return level.replace('Albasra', 'AlBasrah')
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

export const MiniLayersWithCollections = MiniLayerSchema.transform(includeComputedCollections)
export type LayerComposite = {
	FactionMatchup: [string, string]
	FullMatchup: [string, string]
	SubFacMatchup: [string | null, string | null]
}
export type LayerCompositeKey = keyof LayerComposite
export function includeComputedCollections<T extends MiniLayer>(layer: T): T & LayerComposite {
	return {
		...layer,
		FactionMatchup: [layer.Faction_1, layer.Faction_2].sort(),
		FullMatchup: [getLayerTeamString(layer.Faction_1, layer.SubFac_1), getLayerTeamString(layer.Faction_2, layer.SubFac_2)].sort(),
		SubFacMatchup: [layer.SubFac_1, layer.SubFac_2].sort(),
	} as T & LayerComposite
}

export type MiniLayer = z.infer<typeof MiniLayerSchema>
export type PossibleUnknownMiniLayer = { code: 'known'; layer: MiniLayer } | { code: 'unknown'; layerString: string; factionString: string }

export function isFullMiniLayer(layer: Partial<MiniLayer>): layer is MiniLayer {
	return MiniLayerSchema.safeParse(layer).success
}

export type UserPresenceState = {
	editState?: {
		userId: bigint
		wsClientId: string
		startTime: number
	}
}
export type UserPresenceStateUpdate = {
	state: UserPresenceState
	event: 'edit-start' | 'edit-end' | 'edit-kick'
}

export type User = SchemaModels.User
export type UserWithRbac = User & { perms: RBAC.Permission[]; roles: RBAC.Role[] }
export type MiniUser = {
	username: string
	discordId: string
}

// should eventually replace all user id validation with this
export const UserIdSchema = z.bigint().positive()

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

export const FilterEntityIdSchema = z
	.string()
	.trim()
	.regex(/^[a-z0-9-_]+$/, {
		message: '"Must contain only lowercase letters, numbers, hyphens, and underscores"',
	})
	.min(3)
	.max(64)
export const FilterEntityDescriptionSchema = z.string().trim().min(3).max(512)
export type FilterEntityId = z.infer<typeof FilterEntityIdSchema>
export const BaseFilterEntitySchema = z.object({
	id: FilterEntityIdSchema,
	name: z.string().trim().min(3).max(128),
	description: FilterEntityDescriptionSchema.nullable(),
	filter: FilterNodeSchema,
	owner: z.bigint(),
})

export const FilterEntitySchema = BaseFilterEntitySchema
	// this refinement does not deal with mutual recustion
	.refine((e) => !filterContainsId(e.id, e.filter), {
		message: 'filter cannot be recursive',
	}) satisfies z.ZodType<SchemaModels.Filter>

export const UpdateFilterEntitySchema = BaseFilterEntitySchema.omit({ id: true, owner: true })
export const NewFilterEntitySchema = BaseFilterEntitySchema.omit({ owner: true })

export type FilterEntityUpdate = z.infer<typeof UpdateFilterEntitySchema>
export type FilterEntity = z.infer<typeof FilterEntitySchema>

export const HistoryFilterSchema = z.discriminatedUnion(
	'type',
	[
		z.object({
			type: z.literal('static', {
				description: 'sets hardcoded filters which match on attributes that should not be repeated within a certain threshold',
			}),
			comparison: ComparisonSchema,
			excludeFor: z.object({
				matches: z.number().int().positive(),
			}),
		}),
		z.object({
			type: z.literal('dynamic', {
				description:
					'Will use an equality comparison to check if any layers in the history match the predicated layer under the specific column',
			}),
			column: z.enum(COLUMN_KEYS_WITH_COMPUTED),
			excludeFor: z.object({
				matches: z.number().int().positive(),
			}),
		}),
	],
	{ description: 'exclude layers based on the match history' }
)

export type HistoryFilter = z.infer<typeof HistoryFilterSchema>

export type HistoryFilterEdited =
	| {
			type: 'dynamic'
			column: (typeof COLUMN_KEYS_WITH_COMPUTED)[number]
			excludeFor: {
				matches: number
			}
	  }
	| {
			type: 'static'
			comparison: EditableComparison
			excludeFor: {
				matches: number
			}
	  }

export const GenLayerQueueItemsOptionsSchema = z.object({
	numToAdd: z.number().positive(),
	numVoteChoices: z.number().positive(),
	itemType: z.enum(['layer', 'vote']),
	baseFilterId: FilterEntityIdSchema.optional(),
})

export type GenLayerQueueItemsOptions = z.infer<typeof GenLayerQueueItemsOptionsSchema>
export const StartVoteInputSchema = z.object({
	restart: z.boolean().default(false),
	durationSeconds: z.number().positive(),
	minValidVotePercentage: PercentageSchema,
})

type TallyProperties = {
	votes: Record<string, LayerId>
	deadline: number
}

export type VoteState =
	| ({ code: 'ready' } & LayerVote)
	| ({
			code: 'in-progress'
			initiator: GuiOrChatUserId
			minValidVotes: number
	  } & TallyProperties &
			LayerVote)
	| ({
			code: 'ended:winner'
			winner: LayerId
	  } & TallyProperties &
			LayerVote)
	| ({
			code: 'ended:aborted'
			aborter: GuiOrChatUserId
	  } & TallyProperties &
			LayerVote)
	| ({
			code: 'ended:insufficient-votes'
	  } & TallyProperties &
			LayerVote)

export type Tally = ReturnType<typeof tallyVotes>
export function tallyVotes(currentVote: VoteStateWithVoteData, numPlayers: number) {
	if (Object.values(currentVote.choices).length == 0) {
		throw new Error('No choices listed')
	}
	const tally = new Map<string, number>()
	let leaders: string[] = []
	for (const choice of currentVote.choices) {
		tally.set(choice, 0)
	}

	for (const choice of Object.values(currentVote.votes)) {
		const newVotesForChoice = tally.get(choice)! + 1

		if (leaders.length === 0) {
			leaders = [choice]
		} else if (tally.get(leaders[0]!) === newVotesForChoice) {
			leaders.push(choice)
		} else if (tally.get(leaders[0]!)! < newVotesForChoice) {
			leaders = [choice]
		}
		tally.set(choice, newVotesForChoice)
	}
	const totalVotes = Object.values(currentVote.votes).length
	const percentages = new Map<string, number>()
	if (totalVotes > 0) {
		for (const [choice, votes] of tally.entries()) {
			percentages.set(choice, (votes / totalVotes) * 100)
		}
	}
	const turnoutPercentage = (totalVotes / numPlayers) * 100
	return {
		totals: tally,
		totalVotes,
		turnoutPercentage: isNaN(turnoutPercentage) ? null : turnoutPercentage,
		percentages,
		leaders: leaders,
	}
}

export type GuiUserId = { discordId: bigint }
export type ChatUserId = { steamId: string }
export type GuiOrChatUserId = { discordId?: bigint; steamId?: string }
export type VoteStateUpdateOrInitialWithParts =
	| {
			code: 'initial-state'
			state: (VoteState & Parts<UserPart>) | null
	  }
	| {
			code: 'update'
			update: VoteStateUpdate & Parts<UserPart>
	  }

export type VoteStateUpdateOrInitial =
	| {
			code: 'initial-state'
			state: VoteState | null
	  }
	| { code: 'update'; update: VoteStateUpdate }

export type VoteStateUpdate = {
	state: VoteState | null
	source:
		| {
				type: 'system'
				event: 'vote-timeout' | 'queue-change' | 'next-layer-override' | 'app-startup'
		  }
		| {
				type: 'manual'
				event: 'start-vote' | 'abort-vote' | 'vote' | 'queue-change'
				user: GuiOrChatUserId
		  }
}

export type VoteStateWithVoteData = Extract<
	VoteState,
	{ code: 'in-progress' | 'ended:winner' | 'ended:aborted' | 'ended:insufficient-votes' }
>
export const ServerSettingsSchema = z
	.object({
		queue: z
			.object({
				poolFilterId: FilterEntityIdSchema.optional(),
				preferredLength: z.number().default(12),
				generatedItemType: z.enum(['layer', 'vote']).default('layer'),
				preferredNumVoteChoices: z.number().default(3),
				historyFilterEnabled: z.boolean().default(false),
				// lateNightPoolConfig: z.object({
				// 	time: z
				// 		.string()
				// 		.regex(/^([01]\d|2[0-3]):([0-5]\d)$/)
				// 		.default('22:00'),
				// 	filterId: FilterEntityIdSchema.optional(),
				// }),
			})
			.default({
				preferredLength: 12,
				generatedItemType: 'layer',
				preferredNumVoteChoices: 3,
				historyFilterEnabled: false,
			}),
	})
	// avoid sharing default queue object
	.transform((obj) => deepClone(obj))

export type ServerSettings = z.infer<typeof ServerSettingsSchema>

export type Changed<T> = {
	[K in keyof T]: T[K] extends object ? Changed<T[K]> : boolean
}

export type SettingsChanged = Changed<ServerSettings>

export function getSettingsChanged(original: ServerSettings, modified: ServerSettings) {
	// @ts-expect-error it works
	const result: SettingsChanged = {}
	for (const _key in original) {
		const key = _key as keyof ServerSettings
		if (typeof original[key] === 'object') {
			// @ts-expect-error it works
			result[key] = getSettingsChanged(original[key] as ServerSettings, modified[key] as ServerSettings)
		} else {
			// @ts-expect-error it works
			result[key] = original[key] !== modified[key]
		}
	}
	return result
}

export const UserModifiableServerStateSchema = z.object({
	layerQueueSeqId: z.number().int(),
	layerQueue: LayerQueueSchema,
	historyFilters: z.array(HistoryFilterSchema),
	settings: ServerSettingsSchema,
})

export type UserModifiableServerState = z.infer<typeof UserModifiableServerStateSchema>
export type LQServerStateUpdate = {
	state: LQServerState
	source:
		| {
				type: 'system'
				event: 'server-roll' | 'app-startup' | 'vote-timeout' | 'next-layer-override' | 'vote-start' | 'admin-change-layer'
		  }
		// TODO bring this up to date with signature of VoteStateUpdate
		| {
				type: 'manual'
				event: 'edit'
				user: GuiOrChatUserId
		  }
}

export const ServerIdSchema = z.string().min(1).max(256)
export type ServerId = z.infer<typeof ServerIdSchema>

export const ServerStateSchema = UserModifiableServerStateSchema.extend({
	id: ServerIdSchema,
	displayName: z.string().min(1).max(256),
	online: z.boolean(),
	lastRoll: z.date().nullable(),
})

export type LQServerState = z.infer<typeof ServerStateSchema>
export function getNextLayerId(layerQueue: LayerQueue) {
	return layerQueue[0]?.layerId ?? layerQueue[0]?.vote?.defaultChoice
}

// layer status as it relates to the layer pool, other possibly other things later
export type LayerStatus = {
	inPool: boolean
}

export type UserPart = { users: User[] }
export type LayerStatusPart = { layerInPoolState: Map<string, LayerStatus> }
export function getLayerStatusId(layerId: LayerId, filterEntityId: FilterEntityId) {
	return `${layerId}::${filterEntityId}`
}

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

export const GenericServerStateUpdateSchema = UserModifiableServerStateSchema

// represents a user's edit or deletion of an entity
export type UserEntityMutation<K> = {
	username: string
	value: K
	type: 'add' | 'update' | 'delete'
}
