import _StaticLayerComponents from '$root/assets/layer-components.json'
import type * as SchemaModels from '$root/drizzle/schema.models'
import * as RBAC from '@/rbac.models'
import * as z from 'zod'
import { createId } from './lib/id'
import { deepClone, isPartial, revLookup } from './lib/object'
import * as OneToMany from './lib/one-to-many-map'
import { assertNever } from './lib/typeGuards'
import { Parts } from './lib/types'

const StaticLayerComponents = _StaticLayerComponents as LayerComponents

export const getLayerKey = (layer: Layer) =>
	`${layer.Map}-${layer.Layer}-${layer.Faction_1}-${layer.SubFac_1}-${layer.Faction_2}-${layer.SubFac_2}`

export const DEFAULT_LAYER_ID = 'GD-RAAS-V1:US-CA:RGF-CA'
export type Layer = SchemaModels.Layer & MiniLayer
export type QueriedLayer = Layer & LayerComposite & { constraints: boolean[] }

export type Subfaction = keyof (typeof _StaticLayerComponents)['subfactionAbbreviations']

export type LayerIdArgs = {
	Map: string
	Gamemode: string
	LayerVersion: string | null
	Faction_1: string
	SubFac_1: string | null
	Faction_2: string
	SubFac_2: string | null
}

export type ParsedFaction = {
	faction: string
	subFaction: string | null
}

export function isRawLayerId(id: LayerId) {
	return id.startsWith('RAW:')
}

export function parseRawLayerText(rawLayerText: string): UnvalidatedMiniLayer {
	try {
		const layer = getMiniLayerFromId(rawLayerText)
		return {
			code: 'parsed',
			id: layer.id,
			layer,
		}
	} catch {
		// pass
	}

	rawLayerText = rawLayerText.replace(/^RAW:/, '')
	rawLayerText = rawLayerText.replace(/^AdminSetNextLayer /, '')
	if (rawLayerText.split(/\s/).length > 3) {
		return {
			code: 'raw',
			id: `RAW:${rawLayerText}`,
		}
	}
	const [layerString, faction1String, faction2String] = rawLayerText.split(/\s/)
	const parsedLayer = parseLayerStringSegment(layerString)
	const [faction1, faction2] = parseLayerFactions(faction1String, faction2String)
	if (!parsedLayer || !faction1 || !faction2) {
		return {
			code: 'raw',
			id: `RAW:${rawLayerText}`,
			partialLayer: {
				Map: parsedLayer?.map,
				Layer: layerString,
				Gamemode: parsedLayer?.gamemode,
				LayerVersion: parsedLayer?.version ?? null,
				Faction_1: faction1?.faction,
				SubFac_1: faction1?.subFaction,
				Faction_2: faction2?.faction,
				SubFac_2: faction2?.subFaction,
			},
		}
	}
	const {
		map: map,
		gamemode,
		version,
	} = parsedLayer

	const layerIdArgs: LayerIdArgs = {
		Map: map,
		Gamemode: gamemode,
		LayerVersion: version ?? null,
		Faction_1: faction1.faction,
		SubFac_1: faction1.subFaction,
		Faction_2: faction2.faction,
		SubFac_2: faction2.subFaction,
	}

	const miniLayer = {
		...layerIdArgs,
		id: getLayerId(layerIdArgs),
		Layer: layerString,
	} as MiniLayer
	const res = MiniLayerSchema.safeParse(miniLayer)
	if (res.success) return { code: 'parsed', id: res.data.id, layer: res.data }
	return {
		code: 'raw',
		id: `RAW:${rawLayerText}`,
		partialLayer: {
			Map: map,
			Layer: layerString,
			Gamemode: gamemode,
			LayerVersion: version ?? null,
			Faction_1: faction1.faction,
			SubFac_1: faction1.subFaction,
			Faction_2: faction2.faction,
			SubFac_2: faction2.subFaction,
		},
	}
}

export const LAYER_STRING_PROPERTIES = ['Map', 'Gamemode', 'LayerVersion'] as const satisfies (keyof MiniLayer)[]
export function parseLayerStringSegment(layer: string) {
	if (layer.startsWith('JensensRange')) {
		const jensensFactions = layer.slice('JensensRange_'.length).split('-')
		return {
			map: 'JensensRange',
			gamemode: 'Training',
			version: null,
			jensensFactions,
		}
	}
	const groups = layer.match(/^([A-Za-z0-9]+)_([A-Za-z0-9]+)?_([A-Za-z0-9]+)$/)
	if (!groups) return null
	const [map, gamemode, version] = groups.slice(1)
	return {
		map: map,
		gamemode: gamemode,
		version: version?.toUpperCase() ?? null,
	}
}

export function createLayerStringSegment(details: {
	Map: string
	Gamemode: string
	LayerVersion: string | null
}): string {
	if (details.Map === 'JensensRange') {
		throw new Error('JensensRange is not supported')
	}

	let layerString = `${details.Map}_${details.Gamemode}`
	if (details.LayerVersion) {
		layerString += `_${details.LayerVersion.toLowerCase()}`
	}

	return layerString
}

export function factionFullNameToAbbr(fullName: string, components = StaticLayerComponents) {
	return revLookup(components.factionFullNames, fullName)
}

export function subfacFullNameToAbbr(fullName: string, components = StaticLayerComponents) {
	// @ts-expect-error idc
	return revLookup(components.subfactionFullNames, fullName)!
}

function parseLayerFactions(faction1String: string, faction2String: string) {
	const parsedFactions: [ParsedFaction | null, ParsedFaction | null] = [null, null]
	for (let i = 0; i < 2; i++) {
		const factionString = i === 0 ? faction1String : faction2String
		if (!factionString) continue
		const [faction, subFaction] = factionString.split('+').map(s => s.trim())
		if (!faction) continue
		parsedFactions[i] = {
			faction: faction.trim(),
			subFaction: subFaction?.trim(),
		}
	}
	return parsedFactions
}

export type LayerComponents = {
	maps: string[]
	mapAbbreviations: Record<string, string>
	mapShortNames: Record<string, string>
	layers: string[]
	layerVersions: string[]

	factions: string[]
	factionFullNames: Record<string, string>

	subfactions: string[]
	subfactionAbbreviations: Record<string, string>
	subfactionShortNames: Record<string, string>
	subfactionFullNames: Record<
		string,
		{
			AirAssault?: string
			Armored?: string
			CombinedArms?: string
			LightInfantry?: string
			Mechanized?: string
			Motorized?: string
			Support?: string
			AmphibiousAssault?: string
		}
	>

	gamemodes: string[]
	gamemodeAbbreviations: Record<string, string>
}

export function getLayerString(details: Pick<MiniLayer, 'Map' | 'Gamemode' | 'LayerVersion'>) {
	if (details.Map === 'JensensRange') {
		return `${details.Map}_Training`
	}
	let layer = `${details.Map}_${details.Gamemode}`
	if (details.LayerVersion) layer += `_${details.LayerVersion.toLowerCase()}`
	return layer
}

export function getLayerId(layer: LayerIdArgs, components: LayerComponents = StaticLayerComponents) {
	const mapPart = components.mapAbbreviations[layer.Map] ?? layer.Map
	const gamemodePart = components.gamemodeAbbreviations[layer.Gamemode] ?? layer.Gamemode
	let mapLayer = `${mapPart}-${gamemodePart}`
	if (layer.LayerVersion) mapLayer += `-${layer.LayerVersion.toUpperCase()}`

	const team1 = getLayerTeamString(layer.Faction_1, layer.SubFac_1)
	const team2 = getLayerTeamString(layer.Faction_2, layer.SubFac_2)
	return `${mapLayer}:${team1}:${team2}`
}

export function getLayerTeamString(faction: string, subfac: string | null, components: LayerComponents = StaticLayerComponents) {
	const abbrSubfac = subfac ? (components.subfactionAbbreviations[subfac] ?? subfac) : ''
	return abbrSubfac ? `${faction}-${abbrSubfac}` : faction
}
export function parseTeamString(
	team: string,
	components: typeof StaticLayerComponents = StaticLayerComponents,
): { faction: string; subfac: string | null } {
	const [faction, subfac] = team.split('-')
	return {
		faction,
		subfac: subfac ? revLookup(components.subfactionAbbreviations, subfac) : null,
	}
}
/**
 * Check if the ids are equal, or at least all parts of the layer partials `id` contains are in targetId
 */
export function isLayerIdPartialMatch(id: string, targetId: string, ignoreFraas: boolean = true) {
	if (id === targetId) return true

	const layerRes = getLayerDetailsFromUnvalidated(getUnvalidatedLayerFromId(id))
	const targetLayerRes = getLayerDetailsFromUnvalidated(getUnvalidatedLayerFromId(targetId))
	if (ignoreFraas) {
		if (layerRes.Layer) layerRes.Layer = layerRes.Layer?.replace('FRAAS', 'RAAS')
		if (targetLayerRes.Layer) targetLayerRes.Layer = targetLayerRes.Layer?.replace('FRAAS', 'RAAS')
		if (layerRes.Gamemode === 'FRAAS') layerRes.Gamemode = 'RAAS'
		if (targetLayerRes.Gamemode === 'FRAAS') targetLayerRes.Gamemode = 'RAAS'
	}

	return isPartial(layerRes, targetLayerRes)
}

export function areLayerIdsCompatible(id1: string, id2: string, ignoreFraas = true) {
	return isLayerIdPartialMatch(id1, id2, ignoreFraas) || isLayerIdPartialMatch(id2, id1, ignoreFraas)
}

export function getLayerDetailsFromUnvalidated(unvalidatedLayer: UnvalidatedMiniLayer) {
	if (unvalidatedLayer.code === 'raw') return unvalidatedLayer.partialLayer ?? {}
	const { id: _, ...partial } = unvalidatedLayer.layer
	return partial
}

export function getSetNextLayerCommandFromId(id: string) {
	const res = getUnvalidatedLayerFromId(id)
	let cmd: string
	switch (res.code) {
		case 'raw':
			cmd = `AdminSetNextLayer ${res.id.slice('RAW:'.length)}`
			break
		case 'parsed':
			cmd = getAdminSetNextLayerCommand(res.layer)
			break
		default:
			assertNever(res)
	}
	return cmd
}

export function getUnvalidatedLayerFromId(id: string, components = StaticLayerComponents): UnvalidatedMiniLayer {
	if (id.startsWith('RAW:')) {
		return parseRawLayerText(id.slice('RAW:'.length))
	}
	const layer = getMiniLayerFromId(id, components)
	return { code: 'parsed', layer, id }
}

export function getMiniLayerFromId(id: string, components = StaticLayerComponents): MiniLayer {
	const [mapPart, faction1Part, faction2Part] = id.split(':')
	const [mapAbbr, gamemodeAbbr, versionPart] = mapPart.split('-')
	let gamemode = revLookup(components.gamemodeAbbreviations, gamemodeAbbr)
	if (!gamemode) {
		if (!components.gamemodes.includes(gamemodeAbbr)) throw new Error(`Invalid gamemode abbreviation: ${gamemodeAbbr}`)
		// for backwards compatibility with old layerids
		gamemode = gamemodeAbbr
	}
	const map = revLookup(components.mapAbbreviations, mapAbbr)
	if (!map) {
		throw new Error(`Invalid map abbreviation: ${mapAbbr}`)
	}
	const [faction1, subfac1] = parseFactionPart(faction1Part)
	const [faction2, subfac2] = parseFactionPart(faction2Part)

	const layerVersion = versionPart ? versionPart.toUpperCase() : null
	let layer: string | undefined
	if (map === 'JensensRange') {
		layer = `${map}_${faction1}-${faction2}`
	} else {
		layer = StaticLayerComponents.layers.find(
			(l) => l.startsWith(`${map}_${gamemode}`) && (!layerVersion || l.endsWith(layerVersion.toLowerCase())),
		)
	}
	if (!layer) {
		throw new Error(`Invalid layer: ${map}_${gamemode}${layerVersion ? `_${layerVersion}` : ''}`)
	}

	return {
		id,
		Map: map,
		Layer: layer,
		Gamemode: gamemode,
		LayerVersion: layerVersion,
		Faction_1: faction1,
		SubFac_1: subfac1,
		Faction_2: faction2,
		SubFac_2: subfac2,
	}
}

function validateLayerId(id: string) {
	if (id.startsWith('RAW:')) return true
	try {
		getMiniLayerFromId(id)
		return true
	} catch {
		return false
	}
}

export const LayerIdSchema = z.string().min(1).max(255).refine(validateLayerId, {
	message: 'Is valid layer id',
})
export type LayerId = z.infer<typeof LayerIdSchema>

function parseFactionPart(part: string, components = StaticLayerComponents): [string, Subfaction | null] {
	const [faction, subfacAbbr] = part.split('-')
	if (!StaticLayerComponents.factions.includes(faction)) {
		throw new Error(`Invalid faction: ${faction}`)
	}
	const subfac = subfacAbbr ? (revLookup(components.subfactionAbbreviations, subfacAbbr) as Subfaction) : null
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

	return `AdminSetNextLayer ${layer.Layer?.replace('FRAAS', 'RAAS')}${getFactionModifier(layer.Faction_1, layer.SubFac_1)}${
		getFactionModifier(
			layer.Faction_2,
			layer.SubFac_2,
		)
	}`
}

export function getSetNextVoteCommand(ids: string[]) {
	return `!genpool ${ids.join(', ')}`
}

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
export type BooleanColumn = (typeof COLUMN_TYPE_MAPPINGS)['boolean'][number]
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
	string: ['id', 'Map', 'Layer', 'Size', 'Faction_1', 'Faction_2', 'SubFac_1', 'SubFac_2', 'Gamemode', 'LayerVersion'] as const,
	integer: [] as const,
	collection: ['FactionMatchup', 'FullMatchup', 'SubFacMatchup'] as const,
	boolean: ['Z_Pool', 'Scored'] as const,
} satisfies { [key in ColumnType]: (LayerColumnKey | LayerCompositeKey)[] }

export const GROUP_BY_COLUMNS = [
	'Map',
	'Layer',
	'Size',
	'Faction_1',
	'Faction_2',
	'SubFac_1',
	'SubFac_2',
	'Gamemode',
	'LayerVersion',
] as const
export type GroupByColumn = typeof GROUP_BY_COLUMNS[number]

export const WEIGHT_COLUMNS = [
	'Map',
	'Layer',
	'Gamemode',
	'Size',
	'Faction_1',
	'Faction_2',
	'SubFac_1',
	'SubFac_2',
] as const
export type WeightColumn = typeof WEIGHT_COLUMNS[number]

export const COLUMN_LABELS = {
	id: 'ID',
	Map: 'Map',
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

export function editableComparisonHasValue(comp: EditableComparison) {
	return comp.code === 'is-true' || comp.value !== undefined || comp.values !== undefined || comp.range !== undefined
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
		{ message: 'Invalid column type for comparison type' },
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

export const LayerSourceSchema = z.discriminatedUnion('type', [
	z.object({ type: z.literal('generated') }),
	z.object({ type: z.literal('gameserver') }),
	z.object({ type: z.literal('unknown') }),
	z.object({ type: z.literal('manual'), userId: z.bigint() }),
])
export type LayerSource = z.infer<typeof LayerSourceSchema>

export const LayerListItemSchema = z.object({
	itemId: z.string().regex(/^[a-zA-Z0-9_-]{6,24}$/),
	layerId: LayerIdSchema.optional(),
	vote: LayerVoteSchema.optional(),
	source: LayerSourceSchema,
})

export const LayerListSchema = z.array(LayerListItemSchema)

export type LayerList = z.infer<typeof LayerListSchema>
export type LayerListItem = z.infer<typeof LayerListItemSchema>
export type NewLayerListItem = Omit<LayerListItem, 'itemId'>

export function getActiveItemLayerId(item: LayerListItem) {
	return item.layerId ?? item.vote!.choices[0]
}
export function createLayerListItem(newItem: NewLayerListItem): LayerListItem {
	return {
		...newItem,
		itemId: createId(24),
	}
}

// doing this because Omit<> sucks to work with

export function preprocessLevel(level: string) {
	if (level.startsWith('Sanxian')) return 'Sanxian'
	if (level.startsWith('Belaya')) return 'Belaya'
	if (level.startsWith('Albasra')) return level.replace('Albasra', 'AlBasrah')
	return level
}

export const MiniLayerSchema = z.object({
	id: LayerIdSchema,
	Map: z.string().transform(preprocessLevel),
	Layer: z.string(),
	Gamemode: z.string(),
	LayerVersion: z
		.string()
		.nullable()
		.transform((v) => (v === null ? v : v.toUpperCase())),
	Faction_1: z.string(),
	SubFac_1: z.string().nullable(),
	Faction_2: z.string(),
	SubFac_2: z.string().nullable(),
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
export type UnvalidatedMiniLayer = { code: 'parsed'; id: string; layer: MiniLayer } | {
	code: 'raw'
	id: string
	partialLayer?: Partial<MiniLayer>
}

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
export const FilterEntityDescriptionSchema = z.string().trim().min(3).max(2048)
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

export const DnrFieldSchema = z.enum(['Map', 'Layer', 'Gamemode', 'Faction', 'FactionAndUnit'])
export type DnrField = z.infer<typeof DnrFieldSchema>
export const DoNotRepeatRuleSchema = z.object({
	field: DnrFieldSchema,
	label: z.string().min(1).max(100).optional().describe('A label for the rule'),
	targetValues: z.array(z.string()).optional().describe('A "Whitelist" of values which the rule applies to'),
	within: z.number().min(0).max(50).describe('the number of matches in which this rule applies. if 0, the rule should be ignored'),
})
export type DoNotRepeatRule = z.infer<typeof DoNotRepeatRuleSchema>

export function getTeamNormalizedFactionProp(offset: number, team: 'A' | 'B') {
	const props = ['Faction_1', 'Faction_2'] as const
	return props[(offset + Number(team === 'B')) % 2]
}

export function getTeamNormalizedUnitProp(offset: number, team: 'A' | 'B') {
	const props = ['SubFac_1', 'SubFac_2'] as const
	return props[(offset + Number(team === 'B')) % 2]
}

export function getFactionAndUnitValue(faction: string, unit: string | null | undefined) {
	return faction + '_' + unit || ''
}

export const LayerQueryConstraintSchema = z.discriminatedUnion('type', [
	z.object({
		type: z.literal('filter-anon'),
		filter: FilterNodeSchema,
		applyAs: z.enum(['field', 'where-condition']),
		name: z.string().optional(),
		id: z.string(),
	}),
	z.object({
		type: z.literal('filter-entity'),
		filterEntityId: FilterEntityIdSchema,
		applyAs: z.enum(['field', 'where-condition']),
		name: z.string().optional(),
		id: z.string(),
	}),
	z.object({
		type: z.literal('do-not-repeat'),
		rule: DoNotRepeatRuleSchema,
		applyAs: z.enum(['field', 'where-condition']),
		name: z.string().optional(),
		id: z.string(),
	}),
])
export type LayerQueryConstraint = z.infer<typeof LayerQueryConstraintSchema>
export type NamedQueryConstraint = LayerQueryConstraint & { name: string }
export function filterToNamedConstrant(
	filter: FilterNode,
	id: string,
	name: string,
	applyAs: LayerQueryConstraint['applyAs'] = 'where-condition',
): NamedQueryConstraint {
	return {
		type: 'filter-anon',
		filter,
		applyAs,
		name,
		id,
	}
}

export function filterToConstraint(
	filter: FilterNode,
	id: string,
	applyAs: LayerQueryConstraint['applyAs'] = 'where-condition',
): LayerQueryConstraint {
	return {
		type: 'filter-anon',
		filter,
		applyAs,
		id,
	}
}

export function filterEntityToConstraint(
	filterEntity: FilterEntity,
	id: string,
	applyAs: LayerQueryConstraint['applyAs'] = 'where-condition',
): LayerQueryConstraint {
	return {
		type: 'filter-entity',
		filterEntityId: filterEntity.id,
		id,
		applyAs,
	}
}

export const LayersQuerySortSchema = z
	.discriminatedUnion('type', [
		z.object({
			type: z.literal('column'),
			sortBy: z.enum(COLUMN_KEYS),
			sortDirection: z.enum(['ASC', 'DESC']).optional().default('ASC'),
		}),
		z.object({
			type: z.literal('random'),
			seed: z.number().int().positive(),
		}),
	])
	.describe('if not provided, no sorting will be done')

export const DEFAULT_SORT: LayersQueryInput['sort'] = {
	type: 'column',
	sortBy: 'Asymmetry_Score',
	sortDirection: 'ASC',
}
export const DEFAULT_PAGE_SIZE = 20

export const LayersQueryInputSchema = z.object({
	pageIndex: z.number().int().min(0).optional(),
	pageSize: z.number().int().min(1).max(200).optional(),
	sort: LayersQuerySortSchema.optional(),
	constraints: z.array(LayerQueryConstraintSchema).optional(),
	historyOffset: z
		.number()
		.int()
		.min(0)
		.optional()
		.describe(
			'Offset of history entries to consider for DNR rules, where 0 is current layer, 1 is the previous layer, etc',
		),
	previousLayerIds: z
		.array(LayerIdSchema)
		.default([])
		.describe(
			'Layer Ids to be considered as part of the history for DNR rules',
		),
})

export function getEditedFilterConstraint(filter: FilterNode): LayerQueryConstraint {
	return { type: 'filter-anon', id: 'edited-filter', filter, applyAs: 'where-condition' }
}

export type LayersQueryInput = z.infer<typeof LayersQueryInputSchema>

export type LayerQueryContext = {
	constraints?: LayerQueryConstraint[]

	// ids previous to this one but after any relevant layer history, in the order they would appear in the queue/list
	previousLayerIds?: LayerId[]

	// whether to consider stored match history for layers previous to previousLayerIds. defaults to true
	applyMatchHistory?: boolean
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
})

type TallyProperties = {
	votes: Record<string, LayerId>
	deadline: number
}

export type VoteState =
	| ({ code: 'ready' } & LayerVote)
	| (
		& {
			code: 'in-progress'
			initiator: GuiOrChatUserId
		}
		& TallyProperties
		& LayerVote
	)
	| (
		& {
			code: 'ended:winner'
			winner: LayerId
		}
		& TallyProperties
		& LayerVote
	)
	| (
		& {
			code: 'ended:aborted'
			aborter: GuiOrChatUserId
		}
		& TallyProperties
		& LayerVote
	)
	| (
		& {
			code: 'ended:insufficient-votes'
		}
		& TallyProperties
		& LayerVote
	)

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

const DEFAULT_DNR_RULES: DoNotRepeatRule[] = [
	{ field: 'Map', within: 4 },
	{ field: 'Layer', within: 7 },
	{ field: 'Faction', within: 3 },
]

export const PoolConfigurationSchema = z.object({
	filters: z.array(FilterEntityIdSchema),
	doNotRepeatRules: z.array(DoNotRepeatRuleSchema),
})
export type PoolConfiguration = z.infer<typeof PoolConfigurationSchema>

export const ServerSettingsSchema = z
	.object({
		updatesToSquadServerDisabled: z.boolean().default(false).describe('disable SLM from setting the next layer on the server'),
		queue: z
			.object({
				mainPool: PoolConfigurationSchema.default({ filters: [], doNotRepeatRules: DEFAULT_DNR_RULES }),
				// extends the main pool during automated generation
				applyMainPoolToGenerationPool: z.boolean().default(true),
				generationPool: PoolConfigurationSchema.default({ filters: [], doNotRepeatRules: [] }),
				preferredLength: z.number().default(12),
				generatedItemType: z.enum(['layer', 'vote']).default('layer'),
				preferredNumVoteChoices: z.number().default(3),
			})
			// avoid sharing default queue object - TODO unclear if necessary
			.default({}).transform((obj) => deepClone(obj)),
	})

export type ServerSettings = z.infer<typeof ServerSettingsSchema>

export type Changed<T> = {
	[K in keyof T]: T[K] extends object ? Changed<T[K]> : boolean
}

// note the QueryConstraint is not perfectly suited to this kind of use-case as we have to arbitrarily specify apply-as
export function getPoolConstraints(
	poolConfig: PoolConfiguration,
	applyAsDnr: LayerQueryConstraint['applyAs'] = 'field',
	applyAsFilterEntiry: LayerQueryConstraint['applyAs'] = 'field',
) {
	const constraints: LayerQueryConstraint[] = []

	for (const rule of poolConfig.doNotRepeatRules) {
		constraints.push({
			type: 'do-not-repeat',
			rule,
			id: 'layer-pool:' + rule.field,
			name: rule.field,
			applyAs: applyAsDnr,
		})
	}

	for (const filterId of poolConfig.filters) {
		constraints.push({
			type: 'filter-entity',
			id: 'pool:' + filterId,
			filterEntityId: filterId,
			applyAs: applyAsFilterEntiry,
		})
	}
	return constraints
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
	layerQueue: LayerListSchema,
	settings: ServerSettingsSchema,
})

export type UserModifiableServerState = z.infer<typeof UserModifiableServerStateSchema>
export type LQServerStateUpdate = {
	state: LQServerState
	source:
		| {
			type: 'system'
			event:
				| 'server-roll'
				| 'app-startup'
				| 'vote-timeout'
				| 'next-layer-override'
				| 'vote-start'
				| 'admin-change-layer'
				| 'filter-delete'
				| 'next-layer-generated'
				| 'updates-to-squad-server-toggled'
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
export function getNextLayerId(layerQueue: LayerList) {
	if (layerQueue.length === 0) return
	return getLayerIdToSetFromItem(layerQueue[0])
}

export function getLayerIdToSetFromItem(item: LayerListItem) {
	return item.layerId ?? item.vote?.defaultChoice
}

export function getAllItemLayerIds(item: LayerListItem, opts?: { excludeVoteChoices?: boolean }) {
	const ids = new Set<LayerId>()
	if (item.layerId) {
		ids.add(item.layerId)
	}

	if (item.vote && !opts?.excludeVoteChoices) {
		for (const choice of item.vote.choices) ids.add(choice)
	}
	return ids
}

export function getAllLayerIdsFromList(layerList: LayerList, opts?: { excludeVoteChoices?: boolean }) {
	const layerIds = new Set<LayerId>()
	// using list instead of set to preserve ordering
	for (const set of layerList.map(item => getAllItemLayerIds(item, { excludeVoteChoices: opts?.excludeVoteChoices }))) {
		for (const id of set) layerIds.add(id)
	}
	return Array.from(layerIds)
}

export type UserPart = { users: User[] }
export type LayerStatuses = {
	// keys are (itemId:(choiceLayerId)?)
	blocked: OneToMany.OneToManyMap<string, string>
	present: Set<LayerId>
	violationDescriptors: Map<string, Record<string, string[] | undefined>>
}

export function toQueueLayerKey(itemId: string, choice?: string) {
	let id = itemId
	if (choice) id += `:${choice}`
	return id
}

export function parseQueueLayerKey(key: string) {
	const [itemId, choice] = key.split(':')
	return [itemId, choice]
}

export function getAllLayerIdsWithQueueKey(item: LayerListItem) {
	const tuples: [string, LayerId][] = []
	if (item.layerId) tuples.push([toQueueLayerKey(item.itemId), item.layerId])
	if (item.vote) {
		for (const choice of item.vote.choices) {
			tuples.push([item.itemId, choice])
		}
	}
	return tuples
}

export function getAllLayerQueueKeysWithLayerId(layerId: LayerId, queue: LayerList) {
	const keys = new Set<string>()
	for (const item of queue) {
		if (item.layerId === layerId) {
			keys.add(toQueueLayerKey(item.itemId))
		}
		if (item.vote) {
			for (const choice of item.vote.choices) {
				keys.add(toQueueLayerKey(item.itemId, choice))
			}
		}
	}
	return keys
}

export type LayerStatusPart = { layerStatuses: LayerStatuses }
export function getLayerStatusId(layerId: LayerId, filterEntityId: FilterEntityId) {
	return `${layerId}::${filterEntityId}`
}

export type FilterEntityPart = {
	filterEntities: Map<FilterEntityId, FilterEntity>
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
export type UserEntityMutation<K extends string | number, V> = {
	username: string
	key: K
	value: V
	type: 'add' | 'update' | 'delete'
}
