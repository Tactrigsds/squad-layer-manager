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
	generation: LayerGenerationConfig
}

export const BASE_COLUMN_CONFIG: EffectiveColumnConfig = {
	defs: BASE_COLUMN_DEFS,
	generation: { columnOrder: [], weights: {} },
}
export function getEffectiveColumnConfig(config: LayerDbConfig): EffectiveColumnConfig {
	const defs: EffectiveColumnConfig['defs'] = {
		...BASE_COLUMN_CONFIG.defs,
	}
	for (const def of Object.values(config.columns)) {
		defs[def.name] = { ...def, table: 'extra-cols' }
	}
	return { ...BASE_COLUMN_CONFIG, defs, generation: config.generation }
}

export function getColumnDef(name: string, cfg = BASE_COLUMN_CONFIG) {
	return cfg.defs[name] as CombinedColumnDef | undefined
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

export function isLayerColumnKey(key: string, cfg = BASE_COLUMN_CONFIG): key is L.LayerColumnKey {
	return key in cfg.defs
}

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
	const def = getColumnDef(name, ctx.effectiveColsConfig)
	if (!def) throw new Error(`Column "${name}" not found`)
	switch (def.table) {
		case 'layers':
			return view.layers[name as keyof typeof view.layers]
		case 'extra-cols':
			return view.layersExtra[name]
		default:
			assertNever(def.table)
	}
}

export function selectViewCols(cols: string[], ctx: CS.EffectiveColumnConfig) {
	return Object.fromEntries(cols.map((col) => [col, viewCol(col, ctx)]))
}
export function selectAllViewCols(ctx: CS.EffectiveColumnConfig) {
	return selectViewCols(Object.keys(ctx.effectiveColsConfig.defs), ctx)
}

export type LayerRow = typeof layers.$inferSelect
export type NewLayerRow = typeof layers.$inferInsert

export function dbValue<T extends string | number | boolean | null | undefined>(
	columnName: string,
	value: string | number | boolean | null | undefined,
	ctx?: CS.EffectiveColumnConfig,
	components = L.StaticLayerComponents,
): T {
	const def = getColumnDef(columnName, ctx?.effectiveColsConfig)!
	if (columnName === 'id') {
		return packId(value as L.LayerId, components) as T
	}
	switch (def.type) {
		case 'string': {
			if (def.enumMapping) {
				const targetArray = components[def.enumMapping as keyof typeof components]! as string[]

				const index = targetArray.indexOf(value as string)
				if (index === -1) {
					throw new Error(`Value "${value}" not found in array for column "${columnName}"`)
				}

				return index as T
			} else {
				return value as T
			}
		}
		case 'integer':
		case 'float':
			return value as T
		case 'boolean':
			return Number(value) as T
		default:
			assertNever(def)
	}
}

export function fromDbValue(
	columnName: string,
	value: string | number | boolean | null | undefined,
	ctx?: CS.EffectiveColumnConfig,
	components = L.StaticLayerComponents,
) {
	const columnDef = getColumnDef(columnName, ctx?.effectiveColsConfig)
	if (!columnDef) return value
	if (columnName === 'id') {
		return unpackId(value as number, components)
	}

	switch (columnDef.type) {
		case 'string': {
			if (columnDef.enumMapping) {
				const targetArray = components[columnDef.enumMapping as keyof typeof components]! as string[]
				const index = targetArray[value as number]
				if (value === undefined) {
					throw new Error(`Value "${value}" not found in array for column "${columnName}"`)
				}
				return index
			} else {
				return value
			}
		}
		case 'integer':
		case 'float':
			return value
		case 'boolean':
			return Boolean(value)
		default:
			assertNever(columnDef)
	}
}

export function dbValues(
	columnNames: string[] | string,
	values: (string | number | boolean | null)[],
	ctx?: CS.EffectiveColumnConfig,
	components = L.StaticLayerComponents,
) {
	columnNames = Array.isArray(columnNames) ? columnNames : [columnNames]
	return columnNames.map((columnName, index) => dbValue(columnName, values[index], ctx, components))
}

/**
 * Packs a layer's identifying components into a compact integer encoding.
 * Uses enumeration indices to minimize the bits required for each component.
 */
export function packId(layerOrId: L.LayerId | L.KnownLayer, components = L.StaticLayerComponents): number {
	const layer = typeof layerOrId === 'string' ? L.fromPossibleRawId(layerOrId) : layerOrId

	if (!L.isKnownLayer(layer)) {
		throw new Error('Cannot pack raw or invalid layer to integer')
	}

	const ctx: CS.EffectiveColumnConfig = { effectiveColsConfig: BASE_COLUMN_CONFIG }
	// Get enumeration indices for each component
	const layerIndex = dbValue('Layer', layer.Layer, ctx, components)! as number
	const faction1Index = dbValue('Faction_1', layer.Faction_1, ctx, components)! as number
	const unit1Index = dbValue('Unit_1', layer.Unit_1, ctx, components)! as number
	const faction2Index = dbValue('Faction_2', layer.Faction_2, ctx, components)! as number
	const unit2Index = dbValue('Unit_2', layer.Unit_2, ctx, components)! as number

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
	return layers.map(l => packId(l, components))
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

export function toRow(layer: L.KnownLayer, ctx: CS.EffectiveColumnConfig, components = L.StaticLayerComponents): LayerRow {
	return {
		id: packId(layer, components) ?? 0,
		Map: dbValue('Map', layer.Map, ctx, components)!,
		Layer: dbValue('Layer', layer.Layer, ctx, components)!,
		Size: dbValue('Size', layer.Size, ctx, components)!,
		Gamemode: dbValue('Gamemode', layer.Gamemode, ctx, components)!,
		LayerVersion: dbValue('LayerVersion', layer.LayerVersion, ctx, components) ?? null,
		Faction_1: dbValue('Faction_1', layer.Faction_1, ctx, components)!,
		Unit_1: dbValue('Unit_1', layer.Unit_1, ctx, components)!,
		Alliance_1: dbValue('Alliance_1', layer.Alliance_1, ctx, components)!,
		Faction_2: dbValue('Faction_2', layer.Faction_2, ctx, components)!,
		Unit_2: dbValue('Unit_2', layer.Unit_2, ctx, components)!,
		Alliance_2: dbValue('Alliance_2', layer.Alliance_2, ctx, components)!,
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
	versions: Set<string | null>
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
	versions: (string | null)[]
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

export const WEIGHT_COLUMNS = z.enum(
	[
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
	],
)

export type WeightColumn = z.infer<typeof WEIGHT_COLUMNS>

export const LayerDbConfigSchema = z.object({
	columns: z.array(ColumnDefSchema),
	generation: z.object({
		columnOrder: z.array(WEIGHT_COLUMNS),
		weights: z.record(WEIGHT_COLUMNS, z.array(z.object({ value: z.string(), weight: z.number() }))),
	}),
})
	.refine(config => {
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

export type LayerDbConfig = z.infer<typeof LayerDbConfigSchema>
export type LayerGenerationConfig = LayerDbConfig['generation']

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
