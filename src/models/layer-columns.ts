import * as Obj from '@/lib/object'
import type { OneToManyMap } from '@/lib/one-to-many-map'
import { fromJsonCompatible, toJsonCompatible } from '@/lib/one-to-many-map'
import { assertNever } from '@/lib/type-guards'
import type * as CS from '@/models/context-shared'
import * as E from 'drizzle-orm/expressions'
import { index, int, numeric, real, sqliteTable, sqliteView, text } from 'drizzle-orm/sqlite-core'
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
} as const satisfies Record<string, ColumnDef>

export const COLUMN_KEYS = Object.keys(BASE_COLUMN_DEFS) as L.LayerColumnKey[]

export type EffectiveColumnConfig = {
	defs: Record<string, CombinedColumnDef>
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
	const column = cfg.defs[name] as CombinedColumnDef | undefined
	if (!column) {
		return
	}
	return column
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

export function groupByColumnDefaultValues<C extends GroupByColumn>(column: C, components = L.StaticLayerComponents) {
	switch (column) {
		case 'Map':
			return components.maps

		case 'Layer':
			return components.layers

		case 'Size':
			return components.size

		case 'Gamemode':
			return components.gamemodes

		case 'LayerVersion':
			return components.versions

		case 'Alliance_1':
		case 'Alliance_2':
			return components.alliances

		case 'Faction_1':
		case 'Faction_2':
			return components.factions

		case 'Unit_1':
		case 'Unit_2':
			return components.units

		default:
			assertNever(column)
	}
}

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

function _extraColsSchema(ctx: CS.EffectiveColumnConfig) {
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
const extraColsSchemaCache = new WeakMap<EffectiveColumnConfig, ReturnType<typeof _extraColsSchema>>()
export function extraColsSchema(ctx: CS.EffectiveColumnConfig) {
	if (extraColsSchemaCache.has(ctx.effectiveColsConfig)) return extraColsSchemaCache.get(ctx.effectiveColsConfig)!
	const schema = _extraColsSchema(ctx)
	extraColsSchemaCache.set(ctx.effectiveColsConfig, schema)
	return schema
}

function _layersView(ctx: CS.EffectiveColumnConfig) {
	const extra = extraColsSchema(ctx)
	return sqliteView('layersView').as((qb) => qb.select().from(layers).leftJoin(extra, E.eq(layers.id, extra.id)))
}

// sprinkling in a little bit of object pooling here since we call layersView pretty often and I don't know how expensive sqliteView is. probably doesn't matter much
const viewCache = new WeakMap<EffectiveColumnConfig, ReturnType<typeof _layersView>>()
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

export function isEnumeratedColumn(column: string, ctx: CS.EffectiveColumnConfig) {
	const def = getColumnDef(column, ctx.effectiveColsConfig)
	if (!def) return false
	if (def.type !== 'string') return false
	return !!def.enumMapping
}

export function isNumericColumn(column: string, ctx: CS.EffectiveColumnConfig) {
	const def = getColumnDef(column, ctx.effectiveColsConfig)
	if (!def) return false
	return def.type === 'float' || def.type === 'integer'
}

export function isEnumeratedValue(column: string, value: string, ctx: CS.EffectiveColumnConfig, components = L.StaticLayerComponents) {
	const def = getColumnDef(column, ctx.effectiveColsConfig)
	if (!def) return false
	if (def.type !== 'string') return false
	if (!def.enumMapping) return
	return (components[def.enumMapping as keyof typeof components] as string[]).includes(value)
}

export type LayerRow = typeof layers.$inferSelect
export type NewLayerRow = typeof layers.$inferInsert

export class ValueNotFoundError extends Error {}
export class ColumnNotFoundError extends Error {}

const UnmappedDbValue = Symbol('UnmappedDbValue')
export type UnmappedDbValue = typeof UnmappedDbValue
export type DbValue = string | number | boolean | null | undefined
export type DbValueResult = DbValue | UnmappedDbValue

export function isUnmappedDbValue(value: unknown): value is UnmappedDbValue {
	return value === UnmappedDbValue
}
export function assertedMappedValue(value: DbValueResult) {
	if (isUnmappedDbValue(value)) {
		throw new Error(`Expected UnmappedValue, got ${typeof value}`)
	}
	return value
}

export class DbValueError extends Error {
	constructor(public path: string[], public code: string, message: string) {
		super(message)
	}
}
export type InputValue = string | number | boolean | null | undefined

export function assertDbValue(
	columnName: string,
	value: InputValue,
	ctx?: CS.EffectiveColumnConfig,
	components = L.StaticLayerComponents,
) {
	const result = dbValue(columnName, value, ctx, components)
	if (isUnmappedDbValue(result)) {
		throw new Error(`Value "${value}" not found in array for column "${columnName}"`)
	}
	return result
}

export function assertedEnumDbValue(
	columnName: string,
	value: InputValue,
	ctx?: CS.EffectiveColumnConfig,
	components = L.StaticLayerComponents,
) {
	const result = dbValue(columnName, value, ctx, components)
	if (isUnmappedDbValue(result)) {
		throw new Error(`Value "${value}" not found in array for column "${columnName}"`)
	}
	if (typeof result !== 'number') {
		throw new Error(`Expected number, got ${typeof result}`)
	}
	return result
}

export function dbValue(
	columnName: string,
	value: InputValue,
	ctx?: CS.EffectiveColumnConfig,
	components = L.StaticLayerComponents,
): DbValueResult {
	const def = getColumnDef(columnName, ctx?.effectiveColsConfig)!
	if (columnName === 'id') {
		if (!L.isKnownLayer(value as string)) {
			return UnmappedDbValue
		}
		return packId(value as L.LayerId, components)
	}
	switch (def.type) {
		case 'string': {
			if (def.enumMapping) {
				const targetArray = components[def.enumMapping as keyof typeof components]! as string[]

				const index = targetArray.indexOf(value as string)
				if (index === -1) {
					return UnmappedDbValue
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
			return Number(value)
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
export function fromDbValues(
	data: Record<string, DbValue>[],
	ctx?: CS.EffectiveColumnConfig,
	components = L.StaticLayerComponents,
) {
	return data.map((row) => {
		const result: Record<string, any> = {}
		for (const [columnName, dbValue] of Object.entries(row)) {
			result[columnName] = fromDbValue(columnName, dbValue, ctx, components)
		}
		return result
	})
}

export function dbValues(
	columnNames: string[] | string,
	values: (string | number | boolean | null)[],
	ctx?: CS.EffectiveColumnConfig,
	components = L.StaticLayerComponents,
) {
	if (values.length === 0) return []
	columnNames = Array.isArray(columnNames) ? columnNames : [columnNames]
	return columnNames.map((columnName, index) => dbValue(columnName, values[index], ctx, components))
}

/**
 * Packs a layer's identifying components into a compact integer encoding.
 * Uses enumeration indices to minimize the bits required for each component.
 */
export function packId(layerOrId: L.LayerId | L.KnownLayer, components = L.StaticLayerComponents): number {
	const layer = typeof layerOrId === 'string' ? L.toLayer(layerOrId) : layerOrId

	if (!L.isKnownLayer(layer, components)) {
		throw new Error('Cannot pack raw or invalid layer to integer')
	}

	const ctx: CS.EffectiveColumnConfig = { effectiveColsConfig: BASE_COLUMN_CONFIG }
	// Get enumeration indices for each component
	const layerIndex = assertedEnumDbValue('Layer', layer.Layer, ctx, components)
	const faction1Index = assertedEnumDbValue('Faction_1', layer.Faction_1, ctx, components)
	const unit1Index = assertedEnumDbValue('Unit_1', layer.Unit_1, ctx, components)
	const faction2Index = assertedEnumDbValue('Faction_2', layer.Faction_2, ctx, components)
	const unit2Index = assertedEnumDbValue('Unit_2', layer.Unit_2, ctx, components)

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

export function isKnownAndValidLayer(
	layer: L.LayerId | L.UnvalidatedLayer,
	cfg = BASE_COLUMN_CONFIG,
	components = L.StaticLayerComponents,
) {
	layer = L.toLayer(layer)
	if (!L.isKnownLayer(layer)) return false
	for (const [key, value] of Obj.objEntries(layer)) {
		const colDef = getColumnDef(key, cfg)
		if (!colDef) return false
		if (colDef.type === 'string' && colDef.enumMapping) {
			const mapping = components[colDef.enumMapping as keyof typeof components] as string[]
			if (!mapping.includes(value as string)) return false
		}
	}
	return true
}

export function packValidLayers(layers: (L.LayerId | L.KnownLayer)[]) {
	const packed: number[] = []
	for (const layer of layers) {
		if (L.isKnownLayer(layer)) {
			packed.push(packId(layer, L.StaticLayerComponents))
		}
	}
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
	const parsedSegments = L.parseLayerStringSegment(layer)!
	const compatMappedSegments = L.applyBackwardsCompatMappings(parsedSegments, components)
	return L.getKnownLayerId({
		...compatMappedSegments,
		Faction_1: components.factions[faction1Index],
		Unit_1: components.units[unit1Index],
		Faction_2: components.factions[faction2Index],
		Unit_2: components.units[unit2Index],
	}, components)!
}

export function toRow(layer: L.KnownLayer, ctx: CS.EffectiveColumnConfig, components = L.StaticLayerComponents): LayerRow {
	return {
		id: packId(layer, components) ?? 0,
		Map: assertedEnumDbValue('Map', layer.Map, ctx, components),
		Layer: assertedEnumDbValue('Layer', layer.Layer, ctx, components),
		Size: assertedEnumDbValue('Size', layer.Size, ctx, components),
		Gamemode: assertedEnumDbValue('Gamemode', layer.Gamemode, ctx, components),
		LayerVersion: assertedEnumDbValue('LayerVersion', layer.LayerVersion, ctx, components) ?? null,
		Faction_1: assertedEnumDbValue('Faction_1', layer.Faction_1, ctx, components),
		Unit_1: assertedEnumDbValue('Unit_1', layer.Unit_1, ctx, components),
		Alliance_1: assertedEnumDbValue('Alliance_1', layer.Alliance_1, ctx, components),
		Faction_2: assertedEnumDbValue('Faction_2', layer.Faction_2, ctx, components),
		Unit_2: assertedEnumDbValue('Unit_2', layer.Unit_2, ctx, components),
		Alliance_2: assertedEnumDbValue('Alliance_2', layer.Alliance_2, ctx, components),
	}
}

export type BaseLayerComponents = {
	maps: string[]
	alliances: string[]
	gamemodes: string[]
	layers: string[]
	versions: (string | null)[]
	size: string[]
	mapLayers: L.LayerConfig[]
	factions: string[]
	units: string[]
	allianceToFaction: Record<string, string[]>
	factionToAlliance: Record<string, string>
	factionToUnit: Record<string, string[]>
	factionUnitToUnitFullName: Record<string, string>
	layerFactionAvailability: Record<string, L.LayerFactionAvailabilityEntry[]>
}

export type LayerComponents = BaseLayerComponents & {
	mapAbbreviations: Record<string, string>
	unitAbbreviations: Record<string, string>
	unitShortNames: Record<string, string>
	gamemodeAbbreviations: Record<string, string>
	backwardsCompat: L.BackwardsCompatMappings
}

const baseProperties = {
	name: z.string(),
	displayName: z.string(),
	shortName: z.string().optional(),
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
	// these mappings are encapsulated intentionally. only consume these via layer-components.json
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
		Armored: 'Armor',
		LightInfantry: 'Light',
		Mechanized: 'Mech',
		Motorized: 'Motor',
		Support: 'Sup',
		AirAssault: 'Air',
		AmphibiousAssault: 'Amphib',
	}
	const BACKWARDS_COMPAT = {
		factions: {
			INS: 'MEI',
			MEA: 'GFI',
		},
		gamemodes: {},
		maps: {},
		units: {},
	}

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
		backwardsCompat: BACKWARDS_COMPAT,
	}

	return layerComponents
}

export function coalesceLookupErrors<Args extends any[], V>(cb: (...args: Args) => V) {
	return (...args: Args) => {
		try {
			return cb(...args)
		} catch (error) {
			if (error instanceof ColumnNotFoundError) {
				return {
					code: 'err:column-not-found' as const,
					message: error.message,
				}
			}
			if (error instanceof ValueNotFoundError) {
				return {
					code: 'err:value-not-found' as const,
					message: error.message,
				}
			}
			throw error
		}
	}
}

export type PartitionedScores = {
	other: Record<string, number>
	diffs: Record<string, number>
	team1: Record<string, number>
	team2: Record<string, number>
}

export function partitionScores(layer: any, cfg: EffectiveColumnConfig) {
	const partitioned: PartitionedScores = {
		diffs: {},
		team1: {},
		team2: {},
		other: {},
	}
	for (const def of Object.values(cfg.defs)) {
		if (def.table !== 'extra-cols' || def.type !== 'float') continue
		if (def.name.endsWith('Diff') || def.name == 'Balance_Differential') partitioned.diffs[def.name.replace(/_Diff$/, '')] = layer[def.name]
		else if (def.name.endsWith('_1')) partitioned.team1[def.name.replace(/_1$/, '')] = layer[def.name]
		else if (def.name.endsWith('_2')) partitioned.team2[def.name.replace(/_2$/, '')] = layer[def.name]
		else partitioned.other[def.name] = layer[def.name]
	}
	return partitioned
}
