import _StaticLayerComponents from '$root/assets/layer-components.json'
import * as MapUtils from '@/lib/map'
import * as Obj from '@/lib/object'
import { fromJsonCompatible, OneToManyMap, toJsonCompatible } from '@/lib/one-to-many-map'
import { assertNever } from '@/lib/type-guards'
import * as CS from '@/models/context-shared'
import * as E from 'drizzle-orm/expressions'
import { index, int, numeric, primaryKey, real, sqliteTable, sqliteView, text } from 'drizzle-orm/sqlite-core'
import { z } from 'zod'
import * as L from './layer'

export const COLUMN_TYPE = z.enum(['float', 'string', 'integer', 'boolean'])
export type ColumnType = z.infer<typeof COLUMN_TYPE>

export function createColumnDef<K extends L.LayerColumnKey, T extends Omit<ColumnDef, 'name'>>(name: K, def: T) {
	return {
		[name]: { ...def, name, table: 'layers' as const },
	}
}

export const BASE_COLUMN_DEFS = {
	...createColumnDef('id', { type: 'string', displayName: 'ID' }),

	...createColumnDef('Map', { type: 'string', displayName: 'Map', enumMapping: 'maps' }),
	...createColumnDef('Layer', { type: 'string', displayName: 'Layer', enumMapping: 'layers' }),
	...createColumnDef('Size', { type: 'string', displayName: 'Size', enumMapping: 'size' }),
	...createColumnDef('Gamemode', { type: 'string', displayName: 'Gamemode', enumMapping: 'gamemodes' }),
	...createColumnDef('LayerVersion', { type: 'string', displayName: 'Version', enumMapping: 'versions' }),

	...createColumnDef('Faction_1', { type: 'string', displayName: 'T1', enumMapping: 'factions' }),
	...createColumnDef('Faction_2', { type: 'string', displayName: 'T2', enumMapping: 'factions' }),

	...createColumnDef('Unit_1', { type: 'string', displayName: 'Unit T1', enumMapping: 'units' }),
	...createColumnDef('Unit_2', { type: 'string', displayName: 'Unit T2', enumMapping: 'units' }),

	...createColumnDef('Alliance_1', { type: 'string', displayName: 'Alliance T1', enumMapping: 'alliances' }),
	...createColumnDef('Alliance_2', { type: 'string', displayName: 'Alliance T2', enumMapping: 'alliances' }),
} as const satisfies Record<string, CombinedColumnDef>

export const COLUMN_KEYS = Object.keys(BASE_COLUMN_DEFS) as L.LayerColumnKey[]

export type EffectiveColumnConfig = {
	defs: Record<string | L.LayerColumnKey, CombinedColumnDef>
}

export const BASE_COLUMN_CONFIG: EffectiveColumnConfig = {
	defs: BASE_COLUMN_DEFS,
}
export function getEffectiveColumnConfig(config: ExtraColumnsConfig): EffectiveColumnConfig {
	const defs: EffectiveColumnConfig['defs'] = {
		...BASE_COLUMN_CONFIG.defs,
	}
	for (const def of Object.values(config.columns)) {
		defs[def.name] = { ...def, table: 'extra-cols' }
	}
	return { ...BASE_COLUMN_CONFIG, defs }
}

export function getColumnDef(name: string, cfg = BASE_COLUMN_CONFIG) {
	return cfg.defs[name] as ColumnDef | undefined
}

export function getColumnLabel(name: string, cfg = BASE_COLUMN_CONFIG) {
	return cfg.defs[name]?.displayName ?? name
}

export const GROUP_BY_COLUMNS = [
	'Map',
	'Layer',
	'Size',
	'Faction_1',
	'Faction_2',
	'Unit_1',
	'Unit_2',
	'Alliance_1',
	'Alliance_2',
	'Gamemode',
	'LayerVersion',
] as const satisfies L.LayerColumnKey[]
export type GroupByColumn = typeof GROUP_BY_COLUMNS[number]

export const WEIGHT_COLUMNS = [
	'Map',
	'Layer',
	'Gamemode',
	'Size',
	'Faction_1',
	'Faction_2',
	'Unit_1',
	'Unit_2',
	'Alliance_1',
	'Alliance_2',
] as const satisfies L.LayerColumnKey[]
export type WeightColumn = typeof WEIGHT_COLUMNS[number]

export function isLayerColumnKey(key: string, cfg = BASE_COLUMN_CONFIG): key is L.LayerColumnKey {
	return key in cfg.defs
}

export const genLayerColumnOrder = sqliteTable('genLayerColumnOrder', {
	columnName: text('columnName').primaryKey().notNull(),
	ordinal: int('ordinal').notNull(),
})

export const genLayerWeights = sqliteTable('genLayerWeights', {
	columnName: text('columnName').notNull(),
	value: int('value').notNull(),
	weight: real('weight').notNull(),
}, (table) => ({
	pk: primaryKey({ columns: [table.columnName, table.value] }),
	columnNameIndex: index('columnNameIndex').on(table.columnName),
	valueIndex: index('valueIndex').on(table.value),
}))

export const layers = sqliteTable('layers', {
	id: int('id').primaryKey().notNull(),

	Map: int('Map').notNull(),
	Layer: int('Layer').notNull(),
	Size: int('Size').notNull(),
	Gamemode: int('Gamemode').notNull(),
	LayerVersion: int('LayerVersion'),

	Faction_1: int('Faction_1').notNull(),
	Unit_1: int('Unit_1').notNull(),
	Alliance_1: int('Alliance_1').notNull(),

	Faction_2: int('Faction_2').notNull(),
	Unit_2: int('Unit_2').notNull(),
	Alliance_2: int('Alliance_2').notNull(),
}, table => ({
	mapIndex: index('mapIndex').on(table.Map),
	layerIndex: index('layerIndex').on(table.Layer),
	gamemodeIndex: index('gamemodeIndex').on(table.Gamemode),
	sizeIndex: index('sizeIndex').on(table.Size),
	layerVersionIndex: index('layerVersionIndex').on(table.LayerVersion),
	faction1Index: index('faction1Index').on(table.Faction_1),
	faction2Index: index('faction2Index').on(table.Faction_2),
	unit1Index: index('unit1Index').on(table.Unit_1),
	unit2Index: index('unit2Index').on(table.Unit_2),
	alliance1Index: index('alliance1Index').on(table.Alliance_1),
	alliance2Index: index('alliance2Index').on(table.Alliance_2),
}))

export const layerStrIds = sqliteTable('layerStrIds', {
	id: int('id').primaryKey().notNull(),
	idStr: text('idStr').notNull(),
}, (table) => ({
	idStrIndex: index('idStrIndex').on(table.idStr),
}))

export function extraColsSchema(ctx: CS.EffectiveColumnConfig) {
	const columns: Record<string, any> = {
		id: int('id').primaryKey().notNull(),
	}
	const indexes: Record<string, (table: any) => any> = {}
	for (const c of Object.values(ctx.effectiveColsConfig.defs)) {
		if (c.table !== 'extra-cols') continue
		switch (c.type) {
			case 'string':
				columns[c.name] = text(c.name)
				break
			case 'float':
				columns[c.name] = real(c.name)
				break
			case 'integer':
				columns[c.name] = int(c.name)
				break
			case 'boolean':
				columns[c.name] = numeric(c.name)
				break
			default:
				assertNever(c)
		}
		indexes[c.name] = (table: any) => index(c.name + 'Index').on(table[c.name])
	}
	return sqliteTable('layersExtra', columns, (table) => Obj.map(indexes, (cb) => cb(table)))
}

// sprinkling in a little bit of object pooling here since we call layersView pretty often and I don't know how expensive sqliteView is. probably doesn't matter much
const viewCache = new WeakMap<EffectiveColumnConfig, ReturnType<typeof _layersView>>()

function _layersView(ctx: CS.EffectiveColumnConfig) {
	const extra = extraColsSchema(ctx)
	return sqliteView('layersView').as((qb) => qb.select().from(layers).leftJoin(extra, E.eq(layers.id, extra.id)))
}

export function layersView(ctx: CS.EffectiveColumnConfig) {
	if (viewCache.has(ctx.effectiveColsConfig)) return viewCache.get(ctx.effectiveColsConfig)!
	const view = _layersView(ctx)
	viewCache.set(ctx.effectiveColsConfig, view)
	return view
}

export function viewCol(name: string, ctx: CS.EffectiveColumnConfig) {
	const view = layersView(ctx)
	if (isLayerColumnKey(name, ctx.effectiveColsConfig)) {
		return view.layers[name]
	}
	const col = view.layersExtra[name]
	if (!col) throw new Error(`Column "${name}" not found`)
	return col
}

export function selectViewCols(cols: string[], ctx: CS.EffectiveColumnConfig) {
	return Object.fromEntries(cols.map((col) => [col, viewCol(col, ctx)]))
}
export function selectAllViewCols(ctx: CS.EffectiveColumnConfig) {
	// const effectiveConfig =
	return Object.fromEntries(Object.keys(viewCol('', ctx)).map((col) => [col, viewCol(col, ctx)]))
}

export type LayerRow = typeof layers.$inferSelect
export type NewLayerRow = typeof layers.$inferInsert

/**
 * Returns the index of a value in the corresponding array from layer-components,
 * or returns the value as-is if it's not found in any default arrays.
 */
export function getColValueEnum(columnName: string, value?: string | number | boolean | null, components = L.StaticLayerComponents) {
	const columnDef = getColumnDef(columnName)
	if (typeof value !== 'string' || columnDef?.type !== 'string' || !columnDef.enumMapping) return

	// Map column names to their corresponding arrays in layer-components
	const targetArray = components[columnDef.enumMapping as keyof typeof components]! as string[]

	const index = targetArray.indexOf(value)
	if (index === -1) {
		throw new Error(`Value "${value}" not found in array for column "${columnName}"`)
	}

	return index
}

/**
 * Packs a layer's identifying components into a compact integer encoding.
 * Uses enumeration indices to minimize the bits required for each component.
 */
export function packLayer(layerOrId: L.LayerId | L.KnownLayer, components = L.StaticLayerComponents): number {
	const layer = typeof layerOrId === 'string' ? L.fromPossibleRawId(layerOrId) : layerOrId

	if (!L.isKnownLayer(layer)) {
		throw new Error('Cannot pack raw or invalid layer to integer')
	}

	// Get enumeration indices for each component
	const layerIndex = getColValueEnum('Layer', layer.Layer, components)!
	const faction1Index = getColValueEnum('Faction_1', layer.Faction_1, components)!
	const unit1Index = getColValueEnum('Unit_1', layer.Unit_1, components)!
	const faction2Index = getColValueEnum('Faction_2', layer.Faction_2, components)!
	const unit2Index = getColValueEnum('Unit_2', layer.Unit_2, components)!

	// Calculate bits needed for each component based on array sizes
	// const layerBits = Math.ceil(Math.log2(components.layers.length))
	const factionBits = Math.ceil(Math.log2(components.factions.length))
	const unitBits = Math.ceil(Math.log2(components.units.length))

	// Pack components into a single integer
	let packed = 0
	let bitOffset = 0

	// Pack in reverse order so most significant bits contain the layer
	packed |= unit2Index << bitOffset
	bitOffset += unitBits

	packed |= faction2Index << bitOffset
	bitOffset += factionBits

	packed |= unit1Index << bitOffset
	bitOffset += unitBits

	packed |= faction1Index << bitOffset
	bitOffset += factionBits

	packed |= layerIndex << bitOffset

	return packed
}

export function packLayers(layers: (L.LayerId | L.KnownLayer)[], components = L.StaticLayerComponents) {
	return layers.map(l => packLayer(l, components))
}

export function fromEnum(column: string, enumValue: number, components = L.StaticLayerComponents) {
	const colDef = getColumnDef(column)
	if (colDef?.type !== 'string' || !colDef.enumMapping) return

	return (components as any)[colDef.enumMapping][enumValue] as string
}

/**
 * Unpacks a layer from its integer encoding
 */
export function unpackId(
	packed: number,
	components = L.StaticLayerComponents,
) {
	// Calculate bits needed for each component
	const layerBits = Math.ceil(Math.log2(components.layers.length))
	const factionBits = Math.ceil(Math.log2(components.factions.length))
	const unitBits = Math.ceil(Math.log2(components.units.length))

	// Create masks for each component
	const unitMask = (1 << unitBits) - 1
	const factionMask = (1 << factionBits) - 1
	const layerMask = (1 << layerBits) - 1

	// Unpack in reverse order
	let bitOffset = 0

	const unit2Index = (packed >> bitOffset) & unitMask
	bitOffset += unitBits

	const faction2Index = (packed >> bitOffset) & factionMask
	bitOffset += factionBits

	const unit1Index = (packed >> bitOffset) & unitMask
	bitOffset += unitBits

	const faction1Index = (packed >> bitOffset) & factionMask
	bitOffset += factionBits

	const layerIndex = (packed >> bitOffset) & layerMask

	const layer = components.layers[layerIndex]
	return L.getKnownLayerId({
		...L.parseLayerStringSegment(layer)!,
		Faction_1: components.factions[faction1Index],
		Unit_1: components.units[unit1Index],
		Faction_2: components.factions[faction2Index],
		Unit_2: components.units[unit2Index],
	}, components)!
}

export function toRow(layer: L.KnownLayer, components = L.StaticLayerComponents): LayerRow {
	return {
		id: packLayer(layer, components) ?? 0,
		Map: getColValueEnum('Map', layer.Map, components)!,
		Layer: getColValueEnum('Layer', layer.Layer, components)!,
		Size: getColValueEnum('Size', layer.Size, components)!,
		Gamemode: getColValueEnum('Gamemode', layer.Gamemode, components)!,
		LayerVersion: getColValueEnum('LayerVersion', layer.LayerVersion, components) ?? null,
		Faction_1: getColValueEnum('Faction_1', layer.Faction_1, components)!,
		Unit_1: getColValueEnum('Unit_1', layer.Unit_1, components)!,
		Alliance_1: getColValueEnum('Alliance_1', layer.Alliance_1, components)!,
		Faction_2: getColValueEnum('Faction_2', layer.Faction_2, components)!,
		Unit_2: getColValueEnum('Unit_2', layer.Unit_2, components)!,
		Alliance_2: getColValueEnum('Alliance_2', layer.Alliance_2, components)!,
	}
}

export type LayerFactionAvailabilityEntry = {
	Faction: string
	Unit: string
	allowedTeams: (1 | 2)[]
	isDefaultUnit: boolean
}

export type MapConfigLayer = { Layer: string; Map: string; Size: string; Gamemode: string; LayerVersion: string }

export type BaseLayerComponents = {
	maps: Set<string>
	alliances: Set<string>
	gamemodes: Set<string>
	layers: Set<string>
	versions: Set<string>
	size: Set<string>
	mapLayers: MapConfigLayer[]
	factions: Set<string>
	units: Set<string>
	allianceToFaction: OneToManyMap<string, string>
	factionToAlliance: Map<string, string>
	factionToUnit: OneToManyMap<string, string>
	factionUnitToUnitFullName: Map<string, string>
	layerFactionAvailability: Map<string, LayerFactionAvailabilityEntry[]>
}

export type BaseLayerComponentsJson = {
	maps: string[]
	alliances: string[]
	gamemodes: string[]
	layers: string[]
	versions: string[]
	size: string[]
	mapLayers: MapConfigLayer[]
	factions: string[]
	units: string[]
	allianceToFaction: Record<string, string[]>
	factionToAlliance: Record<string, string>
	factionToUnit: Record<string, string[]>
	factionUnitToUnitFullName: Record<string, string>
	layerFactionAvailability: Record<string, LayerFactionAvailabilityEntry[]>
}

export type LayerComponents = BaseLayerComponents & {
	mapAbbreviations: Record<string, string>
	unitAbbreviations: Record<string, string>
	unitShortNames: Record<string, string>
	gamemodeAbbreviations: Record<string, string>
}

export type LayerComponentsJson = BaseLayerComponentsJson & {
	mapAbbreviations: Record<string, string>
	unitAbbreviations: Record<string, string>
	unitShortNames: Record<string, string>
	gamemodeAbbreviations: Record<string, string>
}

export function toLayerComponentsJson(components: LayerComponents): LayerComponentsJson {
	return {
		...components,
		size: Array.from(components.size),
		maps: Array.from(components.maps),
		layers: Array.from(components.layers),
		versions: Array.from(components.versions),
		gamemodes: Array.from(components.gamemodes),
		alliances: Array.from(components.alliances),
		factions: Array.from(components.factions),
		units: Array.from(components.units),
		allianceToFaction: toJsonCompatible(components.allianceToFaction),
		factionToAlliance: Object.fromEntries(components.factionToAlliance),
		factionToUnit: toJsonCompatible(components.factionToUnit),
		factionUnitToUnitFullName: Object.fromEntries(components.factionUnitToUnitFullName),
		layerFactionAvailability: Object.fromEntries(components.layerFactionAvailability),
		mapAbbreviations: components.mapAbbreviations,
		unitAbbreviations: components.unitAbbreviations,
		unitShortNames: components.unitShortNames,
		gamemodeAbbreviations: components.gamemodeAbbreviations,
	}
}

export function toLayerComponents(json: LayerComponentsJson): LayerComponents {
	return {
		...json,
		maps: new Set(json.maps),
		layers: new Set(json.layers),
		size: new Set(json.size),
		versions: new Set(json.versions),
		gamemodes: new Set(json.gamemodes),
		alliances: new Set(json.alliances),
		factions: new Set(json.factions),
		units: new Set(json.units),
		allianceToFaction: fromJsonCompatible(json.allianceToFaction),
		factionToAlliance: new Map(Object.entries(json.factionToAlliance)),
		factionToUnit: fromJsonCompatible(json.factionToUnit),
		factionUnitToUnitFullName: new Map(Object.entries(json.factionUnitToUnitFullName)),
		layerFactionAvailability: new Map(Object.entries(json.layerFactionAvailability)),
		mapAbbreviations: json.mapAbbreviations,
		unitAbbreviations: json.unitAbbreviations,
		unitShortNames: json.unitShortNames,
		gamemodeAbbreviations: json.gamemodeAbbreviations,
	}
}

const MAP_ABBREVIATIONS = {
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

const UNIT_ABBREVIATIONS = {
	AirAssault: 'AA',
	Armored: 'AR',
	CombinedArms: 'CA',
	LightInfantry: 'LI',
	Mechanized: 'MZ',
	Motorized: 'MT',
	Support: 'SP',
	AmphibiousAssault: 'AM',
}

const GAMEMODE_ABBREVIATIONS = {
	RAAS: 'RAAS',
	FRAAS: 'FRAAS',
	AAS: 'AAS',
	TC: 'TC',
	Invasion: 'INV',
	Skirmish: 'SK',
	Destruction: 'DES',
	Insurgency: 'INS',
	'Track Attack': 'TA',
	Seed: 'SD',
	Training: 'TR',
	Tanks: 'TN',
}

const UNIT_SHORT_NAMES = {
	CombinedArms: 'Combined',
	Armored: 'Armored',
	LightInfantry: 'Light',
	Mechanized: 'Mech',
	Motorized: 'Motor',
	Support: 'Sup',
	AirAssault: 'Air',
	AmphibiousAssault: 'Amphib',
}

const baseProperties = {
	name: z.string(),
	displayName: z.string(),
	notNull: z.boolean().optional(),
}
export const ColumnDefSchema = z.discriminatedUnion('type', [
	z.object({
		type: z.literal('string'),

		// mapping to this value's enumeration in LayerComponents
		enumMapping: z.string().optional(),
		...baseProperties,
	}),
	z.object({
		type: z.literal('float'),
		...baseProperties,
	}),
	z.object({
		type: z.literal('integer'),
		...baseProperties,
	}),
	z.object({
		type: z.literal('boolean'),
		...baseProperties,
	}),
])

export type ColumnDef = z.infer<typeof ColumnDefSchema>
export type CombinedColumnDef = ColumnDef & { table: 'layers' | 'extra-cols' }

export const ExtraColumnsConfigSchema = z.object({
	columns: z.array(ColumnDefSchema),
}).refine(config => {
	const allCols = new Set(COLUMN_KEYS) as Set<string>
	for (const col of config.columns) {
		if (allCols.has(col.name)) {
			const msg = `Duplicate/Preexisting column name: ${col.name}`
			console.error(msg)
			return false
		}
		allCols.add(col.name)
	}
	return true
}, { message: 'Duplicate/Preexisting column name' })

export type ExtraColumnsConfig = z.infer<typeof ExtraColumnsConfigSchema>

export function buildFullLayerComponents(
	components: BaseLayerComponents,
	skipValidate = false,
) {
	if (!skipValidate) {
		for (const mapLayer of components.mapLayers) {
			if (!(mapLayer.Map in MAP_ABBREVIATIONS)) {
				throw new Error(`map ${mapLayer.Map} doesn't have an abbreviation`)
			}
		}
		for (const subfaction of components.units) {
			if (subfaction === null) continue
			if (!(subfaction in UNIT_ABBREVIATIONS)) {
				throw new Error(`subfaction ${subfaction} doesn't have an abbreviation`)
			}
			if (!(subfaction in UNIT_SHORT_NAMES)) {
				throw new Error(`subfaction ${subfaction} doesn't have a short name`)
			}
		}
	}

	const layerComponents: LayerComponents = {
		...components,
		gamemodeAbbreviations: GAMEMODE_ABBREVIATIONS,
		unitAbbreviations: UNIT_ABBREVIATIONS,
		unitShortNames: UNIT_SHORT_NAMES,
		mapAbbreviations: MAP_ABBREVIATIONS,
	}

	return layerComponents
}
