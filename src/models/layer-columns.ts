import * as E from 'drizzle-orm'
import { index, int, numeric, sqliteTable, sqliteView, text } from 'drizzle-orm/sqlite-core'
import { z } from 'zod'

import * as CD from '@/lib/ctx-def'
import * as Obj from '@/lib/object-utils'
import { assertNever } from '@/lib/type-guards'
import * as CS from '@/models/context-shared'
import type * as SLL from '@/models/squad-layer-list.models'
import * as VEH from '@/models/vehicles.models'

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
	...createColumnDef('Collection', { type: 'string', displayName: 'Collection', enumMapping: 'collections' }),

	...createColumnDef('Faction_1', { type: 'string', displayName: 'T1', enumMapping: 'factions' }),
	...createColumnDef('Faction_2', { type: 'string', displayName: 'T2', enumMapping: 'factions' }),

	...createColumnDef('Unit_1', { type: 'string', displayName: 'Unit T1', enumMapping: 'units' }),
	...createColumnDef('Unit_2', { type: 'string', displayName: 'Unit T2', enumMapping: 'units' }),

	...createColumnDef('Alliance_1', { type: 'string', displayName: 'Alliance T1', enumMapping: 'alliances' }),
	...createColumnDef('Alliance_2', { type: 'string', displayName: 'Alliance T2', enumMapping: 'alliances' }),
} as const satisfies Record<string, ColumnDef>

export const COLUMN_KEYS = Object.keys(BASE_COLUMN_DEFS) as L.LayerColumnKey[]

// The artifact columns behind vehicle filtering: the Units record each team resolved to, per row. Not
// column defs: nothing selects or displays them, only lowered vehicle predicates scan them by name.
export const UNIT_RECORD_COLUMNS = { 1: 'UnitRecord_1', 2: 'UnitRecord_2' } as const

// Vehicle columns are virtual: they have no artifact column, and comparisons against them lower into
// membership tests over UNIT_RECORD_COLUMNS (see layer-engine.ts). The defs exist so the filter editor
// and validation treat them like any other enum column.
export const VEHICLE_COLUMNS = ['Vehicle_1', 'Vehicle_2', 'VehicleType_1', 'VehicleType_2'] as const
export type VehicleColumn = (typeof VEHICLE_COLUMNS)[number]

const virtualColumnDef = (name: VehicleColumn, displayName: string, enumMapping: 'vehicles' | 'vehicleTypes') => ({
	[name]: { name, type: 'string' as const, displayName, enumMapping, table: 'virtual' as const },
})

export const VIRTUAL_COLUMN_DEFS = {
	...virtualColumnDef('Vehicle_1', 'Vehicle T1', 'vehicles'),
	...virtualColumnDef('Vehicle_2', 'Vehicle T2', 'vehicles'),
	...virtualColumnDef('VehicleType_1', 'Vehicle type T1', 'vehicleTypes'),
	...virtualColumnDef('VehicleType_2', 'Vehicle type T2', 'vehicleTypes'),
} as const satisfies Record<string, CombinedColumnDef>

export function vehicleColumnInfo(column: string): { kind: 'vehicles' | 'vehicleTypes'; team: 1 | 2 } | undefined {
	const def = VIRTUAL_COLUMN_DEFS[column as VehicleColumn]
	if (!def) return undefined
	return { kind: def.enumMapping, team: column.endsWith('_1') ? 1 : 2 }
}

export function isVirtualColumn(name: string, cfg = BASE_COLUMN_CONFIG): boolean {
	return getColumnDef(name, cfg)?.table === 'virtual'
}

// Which collection each enum value belongs to, derived from the catalog: layer configs give maps, layers and
// gamemodes theirs; availability entries propagate it to factions, alliances and units, and the resolved unit
// records carry it on to vehicles and vehicle classes. A value spanning several collections homes to the
// default collection when present, else the first in catalog order.
type CollectionByEnumValue = Partial<Record<string, Map<string, string>>>
const enumValueCollectionsCache = new WeakMap<object, CollectionByEnumValue>()

function enumValueCollections(components: LayerComponents): CollectionByEnumValue {
	const cached = enumValueCollectionsCache.get(components)
	if (cached) return cached

	const sets = new Map<string, Map<string, Set<string>>>()
	const add = (mapping: string, value: string | null | undefined, collection: string) => {
		if (!value) return
		let byValue = sets.get(mapping)
		if (!byValue) sets.set(mapping, (byValue = new Map()))
		let collections = byValue.get(value)
		if (!collections) byValue.set(value, (collections = new Set()))
		collections.add(collection)
	}
	const unitRecordIndex = new Map((components.unitRecords ?? []).map((name, i) => [name, i]))
	for (const config of components.mapLayers) {
		const collection = L.layerConfigCollection(config, components)
		add('maps', config.Map, collection)
		add('layers', config.Layer, collection)
		add('gamemodes', config.Gamemode, collection)
		for (const entry of components.layerFactionAvailability[config.Layer] ?? []) {
			add('factions', entry.Faction, collection)
			add('alliances', components.factionToAlliance[entry.Faction], collection)
			add('units', entry.Unit, collection)
			for (const team of [1, 2] as const) {
				const record = entry.unitObjectNames?.[team]
				const recordIdx = record == null ? undefined : unitRecordIndex.get(record)
				if (recordIdx === undefined) continue
				for (const vehicleIdx of components.unitRecordVehicles?.[recordIdx] ?? []) {
					add('vehicles', components.vehicles?.[vehicleIdx], collection)
					add('vehicleTypes', components.vehicleTypes?.[components.vehicleTypeIds?.[vehicleIdx] ?? -1], collection)
				}
			}
		}
	}

	const defaultCollection = L.getDefaultCollection(components)
	const result: CollectionByEnumValue = {}
	for (const [mapping, byValue] of sets) {
		const home = new Map<string, string>()
		for (const [value, collections] of byValue) {
			home.set(
				value,
				collections.has(defaultCollection)
					? defaultCollection
					: (components.collections.find((c) => collections.has(c)) ?? defaultCollection),
			)
		}
		result[mapping] = home
	}
	enumValueCollectionsCache.set(components, result)
	return result
}

export function collectionForEnumValue(
	column: string,
	value: string | null,
	components = L.StaticLayerComponents,
	cfg = BASE_COLUMN_CONFIG,
): string | undefined {
	if (value === null) return undefined
	const def = getColumnDef(column, cfg)
	if (def?.type !== 'string') return undefined
	const mapping = def.enumMapping
	if (!mapping || mapping === 'collections') return undefined
	return enumValueCollections(components)[mapping]?.get(value)
}

export type CollectionGroup = { key: string; label: string; prefix: string | null }

const collectionGroupsCache = new WeakMap<object, CollectionGroup[]>()

// The collections as combo box groups: default collection first, then catalog order. The abbreviation is the
// prefix, since that form is repeated on every row of an "all" listing, and the default collection's null
// abbreviation carries through as a null prefix so unmodded values read bare, as they do everywhere else.
// Memoized on the components object because it is passed as a prop, and a fresh array each render would
// rebuild every option list.
export function collectionGroups(components = L.StaticLayerComponents): CollectionGroup[] {
	const cached = collectionGroupsCache.get(components)
	if (cached) return cached
	const defaultCollection = L.getDefaultCollection(components)
	const ordered = [defaultCollection, ...components.collections.filter((c) => c !== defaultCollection)]
	const groups = ordered.map((key) => ({ key, label: key, prefix: components.collectionAbbreviations[key] ?? null }))
	collectionGroupsCache.set(components, groups)
	return groups
}

const vehicleTypeIndexCache = new WeakMap<readonly string[], Map<string, string>>()

export function vehicleTypeForVehicle(vehicle: string, components = L.StaticLayerComponents): string | undefined {
	const { vehicles, vehicleTypes, vehicleTypeIds } = components
	if (!vehicles || !vehicleTypes || !vehicleTypeIds) return undefined
	let index = vehicleTypeIndexCache.get(vehicles)
	if (!index) {
		index = new Map(vehicles.map((name, i) => [name, vehicleTypes[vehicleTypeIds[i]]]))
		vehicleTypeIndexCache.set(vehicles, index)
	}
	return index.get(vehicle)
}

// the class of each of a unit's vehicle rows, in the unit's own order. Undefined per row where the artifact
// predates the vehicle tables, or where the row matched no single canonical vehicle.
export function vehicleTypesForUnitRecord(unit: SLL.Unit, components = L.StaticLayerComponents): (string | undefined)[] {
	if (!VEH.hasVehicleData(components)) return unit.vehicles.map(() => undefined)
	return VEH.canonicalVehiclesForUnitRecord(unit.unitObjectName, unit.vehicles, components).map((id) =>
		id === undefined ? undefined : VEH.vehicleTypeName(id, components),
	)
}

const LOCOMOTION_INITIALS: Record<string, string> = { TRACKED: 'T', WHEELED: 'W', BOAT: 'B', OTHER: 'O' }

// the class as a chip: short enough for a table cell, and still the value the filter menu groups by
export function vehicleTypeShortCode(type: string): string {
	const [base, locomotion] = type.split('_')
	const initial = LOCOMOTION_INITIALS[locomotion]
	return initial ? `${base}·${initial}` : type
}

// the layer-identity columns, offered together as one restricted subject group in the filter editor's
// map/layer/gamemode add flows
export const LAYER_IDENTITY_COLUMNS = [
	'Map',
	'Layer',
	'Gamemode',
	'LayerVersion',
	'Size',
	'Collection',
] as const satisfies L.LayerColumnKey[]

export type EffectiveColumnConfig = {
	defs: Record<string, CombinedColumnDef>
}

export const BASE_COLUMN_CONFIG: EffectiveColumnConfig = {
	defs: { ...BASE_COLUMN_DEFS, ...VIRTUAL_COLUMN_DEFS },
}
// keyed by the extra-column array's identity: the query layer memoizes derived state (drizzle views, extra-col
// schemas, query cache keys) against the returned config, so the same columns must always yield the same object
const effectiveColumnConfigs = new WeakMap<object, EffectiveColumnConfig>()
export function getEffectiveColumnConfig(extraColumns: ColumnDef[] = L.StaticExtraColumns): EffectiveColumnConfig {
	const cached = effectiveColumnConfigs.get(extraColumns)
	if (cached) return cached
	const defs: EffectiveColumnConfig['defs'] = {
		...BASE_COLUMN_CONFIG.defs,
	}
	for (const def of extraColumns) {
		defs[def.name] = { ...def, table: 'extra-cols' }
	}
	const config = { ...BASE_COLUMN_CONFIG, defs }
	effectiveColumnConfigs.set(extraColumns, config)
	return config
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
	'Collection',
] as const satisfies L.LayerColumnKey[]
export type GroupByColumn = (typeof GROUP_BY_COLUMNS)[number]

// every column an enum value editor can source options for: the groupable physical columns plus the
// virtual vehicle columns
export type EnumColumn = GroupByColumn | VehicleColumn

// a filter's column arg is free-form text, so anything reading a column out of filter data has to narrow before
// handing it to the enum helpers below, all of which take the closed set
export function isEnumColumn(column: string | undefined): column is EnumColumn {
	return !!column && ((GROUP_BY_COLUMNS as readonly string[]).includes(column) || (VEHICLE_COLUMNS as readonly string[]).includes(column))
}

export function groupByColumnDefaultValues(column: EnumColumn, components = L.StaticLayerComponents) {
	switch (column) {
		case 'Vehicle_1':
		case 'Vehicle_2':
			return components.vehicles ?? []

		case 'VehicleType_1':
		case 'VehicleType_2':
			return components.vehicleTypes ?? []
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

		case 'Collection':
			return components.collections

		default:
			assertNever(column)
	}
}

export function isLayerColumnKey(key: string, cfg = BASE_COLUMN_CONFIG): key is L.LayerColumnKey {
	return key in cfg.defs
}

export const layers = sqliteTable(
	'layers',
	{
		id: int('id').primaryKey().notNull(),

		Map: int('Map').notNull(),
		Layer: int('Layer').notNull(),
		Size: int('Size').notNull(),
		Gamemode: int('Gamemode').notNull(),
		LayerVersion: int('LayerVersion'),
		Collection: int('Collection').notNull(),

		Faction_1: int('Faction_1').notNull(),
		Unit_1: int('Unit_1').notNull(),
		Alliance_1: int('Alliance_1').notNull(),

		Faction_2: int('Faction_2').notNull(),
		Unit_2: int('Unit_2').notNull(),
		Alliance_2: int('Alliance_2').notNull(),
	},
	(table) => ({
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
	}),
)

function _extraColsSchema(ctx: Ctx) {
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
				// stored as an int scaled by 10^precision (see floatDbScale); read back via fromScaledDbFloat
				columns[c.name] = int(c.name)
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
export function extraColsSchema(ctx: Ctx) {
	if (extraColsSchemaCache.has(ctx.effectiveColsConfig)) return extraColsSchemaCache.get(ctx.effectiveColsConfig)!
	const schema = _extraColsSchema(ctx)
	extraColsSchemaCache.set(ctx.effectiveColsConfig, schema)
	return schema
}

function _layersView(ctx: Ctx) {
	const extra = extraColsSchema(ctx)
	return sqliteView('layersView').as((qb) => qb.select().from(layers).leftJoin(extra, E.eq(layers.id, extra.id)))
}

// sprinkling in a little bit of object pooling here since we call layersView pretty often and I don't know how expensive sqliteView is. probably doesn't matter much
const viewCache = new WeakMap<EffectiveColumnConfig, ReturnType<typeof _layersView>>()
export function layersView(ctx: Ctx) {
	if (viewCache.has(ctx.effectiveColsConfig)) return viewCache.get(ctx.effectiveColsConfig)!
	const view = _layersView(ctx)
	viewCache.set(ctx.effectiveColsConfig, view)
	return view
}

export function viewCol(name: string, ctx: Ctx) {
	const view = layersView(ctx)
	const def = getColumnDef(name, ctx.effectiveColsConfig)
	if (!def) throw new Error(`Column "${name}" not found`)
	switch (def.table) {
		case 'layers':
			return view.layers[name as keyof typeof view.layers]
		case 'extra-cols':
			return view.layersExtra[name]
		case 'virtual':
			throw new ColumnNotFoundError(`Column "${name}" is virtual and has no view column`)
		default:
			assertNever(def.table)
	}
}

export function selectViewCols(cols: string[], ctx: Ctx) {
	return Object.fromEntries(cols.map((col) => [col, viewCol(col, ctx)]))
}
export function selectAllViewCols(ctx: Ctx) {
	return selectViewCols(Object.keys(ctx.effectiveColsConfig.defs), ctx)
}

export function isEnumeratedColumn(column: string, ctx: Ctx) {
	const def = getColumnDef(column, ctx.effectiveColsConfig)
	if (!def) return false
	if (def.type !== 'string') return false
	return !!def.enumMapping
}

export function isNumericColumn(column: string, ctx: Ctx) {
	const def = getColumnDef(column, ctx.effectiveColsConfig)
	if (!def) return false
	return def.type === 'float' || def.type === 'integer'
}

export function isEnumeratedValue(column: string, value: string, ctx: Ctx, components = L.StaticLayerComponents) {
	const def = getColumnDef(column, ctx.effectiveColsConfig)
	if (!def) return false
	if (def.type !== 'string') return false
	if (!def.enumMapping) return
	return ((components[def.enumMapping as keyof typeof components] ?? []) as string[]).includes(value)
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
	constructor(
		public path: string[],
		public code: string,
		message: string,
	) {
		super(message)
	}
}
export type InputValue = string | number | boolean | null | undefined

export function assertDbValue(columnName: string, value: InputValue, ctx?: Ctx, components = L.StaticLayerComponents) {
	const result = dbValue(columnName, value, ctx, components)
	if (isUnmappedDbValue(result)) {
		throw new Error(`Value "${value}" not found in array for column "${columnName}"`)
	}
	return result
}

export function assertedEnumDbValue(columnName: string, value: InputValue, ctx?: Ctx, components = L.StaticLayerComponents) {
	const result = dbValue(columnName, value, ctx, components)
	if (isUnmappedDbValue(result)) {
		throw new Error(`Value "${value}" not found in array for column "${columnName}"`)
	}
	if (typeof result !== 'number') {
		throw new Error(`Expected number, got ${typeof result}`)
	}
	return result
}

// Default decimal places retained for float columns that don't specify `precision`. Float values
// are persisted as ints scaled by 10^precision; see the `precision` field on ColumnDefSchema.
export const DEFAULT_FLOAT_PRECISION = 3

// The positive integer scale a float column's values are multiplied by before being stored as an
// int (and divided by on read). Undefined for non-float columns.
export function floatDbScale(def: CombinedColumnDef | ColumnDef | undefined): number | undefined {
	if (!def || def.type !== 'float') return undefined
	return 10 ** (def.precision ?? DEFAULT_FLOAT_PRECISION)
}

// null/NaN stay null (SQLite has no int NaN; missing floats are already normalized to null on ingest).
export function toScaledDbFloat(def: CombinedColumnDef | ColumnDef | undefined, value: number | null): number | null {
	if (value === null || value === undefined || Number.isNaN(value)) return null
	const scale = floatDbScale(def)
	return scale === undefined ? value : Math.round(value * scale)
}

export function fromScaledDbFloat<T extends number | null | undefined>(def: CombinedColumnDef | ColumnDef | undefined, value: T): T {
	if (value === null || value === undefined) return value
	const scale = floatDbScale(def)
	return (scale === undefined ? value : (value as number) / scale) as T
}

type EnumIndexCacheEntry = { builtAtLength: number; map: Map<unknown, number> }
const enumIndexCache = new WeakMap<unknown[], EnumIndexCacheEntry>()

// indexOf over the enum arrays shows up hot in bulk paths (preprocess, packing). the cache is keyed
// on array identity and rebuilt if the array has grown, since preprocess appends to these arrays
// while building components.
export function enumIndexOf(arr: readonly unknown[], value: unknown): number {
	let entry = enumIndexCache.get(arr as unknown[])
	if (!entry || entry.builtAtLength !== arr.length) {
		const map = new Map<unknown, number>()
		for (let i = 0; i < arr.length; i++) {
			if (!map.has(arr[i])) map.set(arr[i], i)
		}
		entry = { builtAtLength: arr.length, map }
		enumIndexCache.set(arr as unknown[], entry)
	}
	return entry.map.get(value) ?? -1
}

export function enumIncludes(arr: readonly unknown[], value: unknown): boolean {
	return enumIndexOf(arr, value) !== -1
}

export function dbValue(columnName: string, value: InputValue, ctx?: Ctx, components = L.StaticLayerComponents): DbValueResult {
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
				// vehicle mappings are absent from pre-vehicle-filtering artifacts, so a missing array reads
				// as every value unmapped rather than a crash
				const targetArray = (components[def.enumMapping as keyof typeof components] ?? []) as string[]

				const index = enumIndexOf(targetArray, value)
				if (index === -1) {
					return UnmappedDbValue
				}

				return index
			} else {
				return value
			}
		}
		case 'integer':
			return value
		case 'float':
			return toScaledDbFloat(def, value as number | null)
		case 'boolean':
			return Number(value)
		default:
			assertNever(def)
	}
}

export function fromDbValue(
	columnName: string,
	value: string | number | boolean | null | undefined,
	ctx?: Ctx,
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
			return value
		case 'float':
			return fromScaledDbFloat(columnDef, value as number | null)
		case 'boolean':
			return Boolean(value)
		default:
			assertNever(columnDef)
	}
}
export function fromDbValues(data: Record<string, DbValue>[], ctx?: Ctx, components = L.StaticLayerComponents) {
	return data.map((row) => {
		const result: Record<string, any> = {}
		for (const [columnName, dbValue] of Object.entries(row)) {
			result[columnName] = fromDbValue(columnName, dbValue, ctx, components)
		}
		return result
	})
}

export function dbValues(
	columnName: string,
	values: (string | number | boolean | null)[],
	ctx?: Ctx,
	components = L.StaticLayerComponents,
) {
	if (values.length === 0) return []
	return values.map((value) => dbValue(columnName, value, ctx, components))
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

	const ctx: Ctx = { ...CS.init(), effectiveColsConfig: BASE_COLUMN_CONFIG }
	// Get enumeration indices for each component
	const layerIndex = assertedEnumDbValue('Layer', layer.Layer, ctx, components)
	const faction1Index = assertedEnumDbValue('Faction_1', layer.Faction_1, ctx, components)
	const unit1Index = assertedEnumDbValue('Unit_1', layer.Unit_1, ctx, components)
	const faction2Index = assertedEnumDbValue('Faction_2', layer.Faction_2, ctx, components)
	const unit2Index = assertedEnumDbValue('Unit_2', layer.Unit_2, ctx, components)

	// Mixed-radix rather than bit-packed: exact products keep the id inside i32 (the artifact's id column) where
	// power-of-two widths would overflow it at today's component counts. Layer-major, so ascending ids group rows by
	// map and layer, which the artifact's row order and the engine's scan skipping both rely on.
	const factions = components.factions.length
	const units = components.units.length
	const packed = (((layerIndex * factions + faction1Index) * units + unit1Index) * factions + faction2Index) * units + unit2Index
	if (packed > 2147483647) {
		throw new Error(`packed layer id overflows i32: ${components.layers.length} layers x ${factions} factions x ${units} units`)
	}
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
	return layers.map((l) => packId(l, components))
}

/**
 * Unpacks a layer from its integer encoding
 */
export function unpackId(packed: number, components = L.StaticLayerComponents) {
	const factions = components.factions.length
	const units = components.units.length

	const unit2Index = packed % units
	packed = (packed - unit2Index) / units
	const faction2Index = packed % factions
	packed = (packed - faction2Index) / factions
	const unit1Index = packed % units
	packed = (packed - unit1Index) / units
	const faction1Index = packed % factions
	packed = (packed - faction1Index) / factions
	const layerIndex = packed

	const layer = components.layers[layerIndex]
	const config = L.getLayerConfig(layer, components)
	if (!config) throw new Error(`packed id references layer ${layer}, which is not in the catalog`)
	return L.getKnownLayerId(
		{
			Map: config.Map,
			Gamemode: config.Gamemode,
			LayerVersion: config.LayerVersion,
			Collection: L.layerConfigCollection(config, components),
			Faction_1: components.factions[faction1Index],
			Unit_1: components.units[unit1Index],
			Faction_2: components.factions[faction2Index],
			Unit_2: components.units[unit2Index],
		},
		components,
	)!
}

export function toRow(layer: L.KnownLayer, ctx: Ctx, components = L.StaticLayerComponents): LayerRow {
	return {
		id: packId(layer, components) ?? 0,
		Map: assertedEnumDbValue('Map', layer.Map, ctx, components),
		Layer: assertedEnumDbValue('Layer', layer.Layer, ctx, components),
		Size: assertedEnumDbValue('Size', layer.Size, ctx, components),
		Gamemode: assertedEnumDbValue('Gamemode', layer.Gamemode, ctx, components),
		LayerVersion: assertedEnumDbValue('LayerVersion', layer.LayerVersion, ctx, components) ?? null,
		Collection: assertedEnumDbValue('Collection', layer.Collection, ctx, components),
		Faction_1: assertedEnumDbValue('Faction_1', layer.Faction_1, ctx, components),
		Unit_1: assertedEnumDbValue('Unit_1', layer.Unit_1, ctx, components),
		Alliance_1: assertedEnumDbValue('Alliance_1', layer.Alliance_1, ctx, components),
		Faction_2: assertedEnumDbValue('Faction_2', layer.Faction_2, ctx, components),
		Unit_2: assertedEnumDbValue('Unit_2', layer.Unit_2, ctx, components),
		Alliance_2: assertedEnumDbValue('Alliance_2', layer.Alliance_2, ctx, components),
	}
}

// Availability is overwhelmingly repetition: the shipped v10.4.0 artifact has 14893 entries across 254 layers, but
// only 273 distinct entries and 55 distinct per-layer lists. Persisted as pools of each with layers indexing into
// them, which is a 37x smaller subtree on disk and 70x in memory once expanded back with the duplicates shared.
export type LayerFactionAvailabilityPool = {
	entries: L.LayerFactionAvailabilityEntry[]
	lists: number[][]
	byLayer: Record<string, number>
}

// artifacts written before the pool existed carry the expanded form, and a deployment can mount an older pair than
// the image ships (see layer-artifacts.server), so both shapes have to be readable
export type PersistedLayerFactionAvailability = Record<string, L.LayerFactionAvailabilityEntry[]> | LayerFactionAvailabilityPool

// vocabulary that layer sources add on top of the hardcoded core tables (see the source manifests under
// data/sources). Ships inside layer-data.json so clients rebuild the same merged tables the artifact was built with.
export type SourceAbbreviations = {
	maps: Record<string, string>
	gamemodes: Record<string, string>
	units: Record<string, string>
	unitShortNames: Record<string, string>
	collections: Record<string, string | null>
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
	layerFactionAvailability: PersistedLayerFactionAvailability
	// absent in artifacts written before mod sources existed
	sourceAbbreviations?: SourceAbbreviations
	// canonical vehicle tables (see vehicles.models.ts); absent in artifacts written before vehicle filtering
	vehicles?: string[]
	vehicleTypes?: string[]
	vehicleTypeIds?: number[]
	unitRecords?: string[]
	unitRecordVehicles?: number[][]
}

export type LayerComponents = Omit<BaseLayerComponents, 'layerFactionAvailability'> & {
	layerFactionAvailability: Record<string, L.LayerFactionAvailabilityEntry[]>
	mapAbbreviations: Record<string, string>
	unitAbbreviations: Record<string, string>
	unitShortNames: Record<string, string>
	gamemodeAbbreviations: Record<string, string>
	backwardsCompat: L.BackwardsCompatMappings
	collections: string[]
	collectionAbbreviations: Record<string, string | null>
}

const BASE_LAYER_COMPONENT_KEYS = [
	'maps',
	'alliances',
	'gamemodes',
	'layers',
	'versions',
	'size',
	'mapLayers',
	'factions',
	'units',
	'allianceToFaction',
	'factionToAlliance',
	'factionToUnit',
	'factionUnitToUnitFullName',
	'layerFactionAvailability',
	'sourceAbbreviations',
	'vehicles',
	'vehicleTypes',
	'vehicleTypeIds',
	'unitRecords',
	'unitRecordVehicles',
] as const satisfies (keyof BaseLayerComponents)[]

export function toBaseLayerComponents(components: LayerComponents): BaseLayerComponents {
	return {
		...Obj.selectProps(components, BASE_LAYER_COMPONENT_KEYS),
		layerFactionAvailability: poolLayerFactionAvailability(components.layerFactionAvailability),
	}
}

function availabilityEntryKey(entry: L.LayerFactionAvailabilityEntry) {
	const variants = entry.variants ? `${entry.variants.boats}/${entry.variants.noHeli}` : ''
	const unitObjectNames = entry.unitObjectNames ? `${entry.unitObjectNames[1] ?? ''}/${entry.unitObjectNames[2] ?? ''}` : ''
	return `${entry.Faction}|${entry.Unit}|${entry.allowedTeams.join(',')}|${entry.isDefaultUnit}|${variants}|${unitObjectNames}`
}

export function poolLayerFactionAvailability(byLayer: Record<string, L.LayerFactionAvailabilityEntry[]>): LayerFactionAvailabilityPool {
	const entries: L.LayerFactionAvailabilityEntry[] = []
	const entryIndexes = new Map<string, number>()
	const lists: number[][] = []
	const listIndexes = new Map<string, number>()
	const layerToList: Record<string, number> = {}

	for (const [layer, layerEntries] of Object.entries(byLayer)) {
		const list = layerEntries.map((entry) => {
			const key = availabilityEntryKey(entry)
			let index = entryIndexes.get(key)
			if (index === undefined) {
				index = entries.push(entry) - 1
				entryIndexes.set(key, index)
			}
			return index
		})
		const listKey = list.join(',')
		let listIndex = listIndexes.get(listKey)
		if (listIndex === undefined) {
			listIndex = lists.push(list) - 1
			listIndexes.set(listKey, listIndex)
		}
		layerToList[layer] = listIndex
	}

	return { entries, lists, byLayer: layerToList }
}

function isAvailabilityPool(value: PersistedLayerFactionAvailability): value is LayerFactionAvailabilityPool {
	const pool = value as LayerFactionAvailabilityPool
	return Array.isArray(pool.entries) && Array.isArray(pool.lists) && !!pool.byLayer && !Array.isArray(pool.byLayer)
}

// The expanded entries and per-layer arrays are shared between every layer that uses them, which is where the memory
// saving is. Frozen so that sharing cannot be discovered the hard way: nothing mutates these at runtime, only
// preprocess builds them, and it builds rather than reads.
export function expandLayerFactionAvailability(
	persisted: PersistedLayerFactionAvailability | undefined,
): Record<string, L.LayerFactionAvailabilityEntry[]> {
	// preprocess builds a scratch components object out of {} to get at the derived abbreviation maps before it has
	// any availability to put in one
	if (!persisted) return {}
	if (!isAvailabilityPool(persisted)) return persisted

	const entries = persisted.entries.map((entry) => {
		if (entry.variants) Object.freeze(entry.variants)
		Object.freeze(entry.allowedTeams)
		return Object.freeze(entry)
	})
	const lists = persisted.lists.map((list) => Object.freeze(list.map((index) => entries[index])))
	const byLayer: Record<string, L.LayerFactionAvailabilityEntry[]> = {}
	for (const [layer, listIndex] of Object.entries(persisted.byLayer)) {
		byLayer[layer] = lists[listIndex] as L.LayerFactionAvailabilityEntry[]
	}
	return byLayer
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
		// Number of decimal places to retain. Float columns are stored as integers scaled by
		// 10^precision (see floatDbScale) to keep the db compact: an 8-byte REAL becomes a varint
		// int a few bytes wide, in both the table and its index. Ordering and range semantics are
		// preserved because the scale is a positive constant. Defaults to DEFAULT_FLOAT_PRECISION.
		precision: z.number().int().nonnegative().optional(),
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
export type CombinedColumnDef = ColumnDef & { table: 'layers' | 'extra-cols' | 'virtual' }

export const WEIGHT_COLUMNS = z.enum([
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
])

export type WeightColumn = z.infer<typeof WEIGHT_COLUMNS>

// A matchup weights the two teams as a pair instead of weighting each team's column on its own, so ADF vs PLA can
// be weighted differently from ADF and PLA individually. Matchups are unordered: the weight for [ADF, PLA] applies
// to a layer whichever team fields which faction.
export const MATCHUP_KEYS = z.enum(['AllianceMatchup', 'FactionMatchup', 'UnitMatchup', 'FactionUnitMatchup'])
export type MatchupKey = z.infer<typeof MATCHUP_KEYS>

// the columns each matchup compares, team 1's first. A team's side of the matchup is the tuple of its values for
// these columns, so FactionUnitMatchup groups on (Faction, Unit) per team while FactionMatchup ignores the unit.
export const MATCHUP_COLUMNS = {
	AllianceMatchup: [['Alliance_1'], ['Alliance_2']],
	FactionMatchup: [['Faction_1'], ['Faction_2']],
	UnitMatchup: [['Unit_1'], ['Unit_2']],
	FactionUnitMatchup: [
		['Faction_1', 'Unit_1'],
		['Faction_2', 'Unit_2'],
	],
} as const satisfies Record<MatchupKey, [readonly WeightColumn[], readonly WeightColumn[]]>

// a pick step is either a single column or a matchup between the two teams
export const PICK_KEYS = z.enum([...WEIGHT_COLUMNS.options, ...MATCHUP_KEYS.options])
export type PickKey = z.infer<typeof PICK_KEYS>

export function isMatchupKey(key: PickKey): key is MatchupKey {
	return key in MATCHUP_COLUMNS
}

export const FactionUnitSchema = z.object({ Faction: z.string(), Unit: z.string() })
export type FactionUnit = z.infer<typeof FactionUnitSchema>
export type MatchupSide = string | FactionUnit

function matchupEntries<S extends z.ZodType>(side: S) {
	return z.array(z.object({ teams: z.tuple([side, side]), weight: z.number() })).prefault([])
}

export const MatchupWeightsSchema = z
	.object({
		AllianceMatchup: matchupEntries(z.string()),
		FactionMatchup: matchupEntries(z.string()),
		UnitMatchup: matchupEntries(z.string()),
		FactionUnitMatchup: matchupEntries(FactionUnitSchema),
	})
	.prefault({})

export type MatchupWeights = z.infer<typeof MatchupWeightsSchema>
export type MatchupWeightEntry<K extends MatchupKey = MatchupKey> = MatchupWeights[K][number]

// a side's values in MATCHUP_COLUMNS order
export function matchupSideValues(key: MatchupKey, side: MatchupSide): string[] {
	if (key === 'FactionUnitMatchup') {
		const fu = side as FactionUnit
		return [fu.Faction, fu.Unit]
	}
	return [side as string]
}

// order-independent key for a matchup: the two sides' values, canonically ordered, so a layer and its
// team-swapped counterpart land in the same group
export function matchupGroupKey(side1: readonly DbValue[], side2: readonly DbValue[]) {
	const a = side1.join(',')
	const b = side2.join(',')
	return a <= b ? `${a}|${b}` : `${b}|${a}`
}

// identity of a configured matchup entry, in app values rather than db values: [ADF, PLA] and [PLA, ADF] are the
// same matchup, so they share a key
export function matchupEntryKey(key: MatchupKey, teams: readonly [MatchupSide, MatchupSide]) {
	return matchupGroupKey(matchupSideValues(key, teams[0]), matchupSideValues(key, teams[1]))
}

// ---------------------------- generation group keys ----------------------------
// Generation groups candidate layers by pick step, and it does the grouping in SQL (see getRandomGeneratedLayers), so
// a step's group has to be expressible as one scalar the database can GROUP BY, PARTITION BY and match with IN. These
// pack a step's columns into a single integer, mixed-radix over each column's enum size. The SQL builders mirror this
// packing exactly, so a key computed here from a weight entry matches the key the database computes from a layer row.

// db values are enum indices, so a column's values fit in [0, size); the extra slot holds null (packed as 0)
export function weightColumnRadix(column: WeightColumn, components = L.StaticLayerComponents) {
	return (groupByColumnDefaultValues(column, components) as string[]).length + 1
}

export function sideKeyRadix(columns: readonly WeightColumn[], components = L.StaticLayerComponents) {
	let radix = 1
	for (const column of columns) radix *= weightColumnRadix(column, components)
	return radix
}

export function packSideKey(columns: readonly WeightColumn[], values: readonly DbValue[], components = L.StaticLayerComponents) {
	let key = 0
	for (let i = 0; i < columns.length; i++) {
		key = key * weightColumnRadix(columns[i], components) + ((values[i] as number | null | undefined) ?? -1) + 1
	}
	return key
}

// the two sides are packed in canonical (min, max) order, which is what makes a matchup unordered: a layer and its
// team-swapped counterpart produce the same key
export function stepKeyRadix(key: PickKey, components = L.StaticLayerComponents) {
	if (!isMatchupKey(key)) return sideKeyRadix([key], components)
	const sideRadix = sideKeyRadix(MATCHUP_COLUMNS[key][1], components)
	return sideRadix * sideRadix
}

export function packStepKey(key: PickKey, dbValueOf: (column: WeightColumn) => DbValue, components = L.StaticLayerComponents) {
	if (!isMatchupKey(key)) return packSideKey([key], [dbValueOf(key)], components)
	const [columns1, columns2] = MATCHUP_COLUMNS[key]
	const side1 = packSideKey(columns1, columns1.map(dbValueOf), components)
	const side2 = packSideKey(columns2, columns2.map(dbValueOf), components)
	const radix = sideKeyRadix(columns2, components)
	return Math.min(side1, side2) * radix + Math.max(side1, side2)
}

// a path is the step keys picked so far, packed together. Long pick orders can overflow the exact-integer range, in
// which case callers fall back to string keys (see pathKeyMode)
export function pathKeyRadix(pickOrder: readonly PickKey[], components = L.StaticLayerComponents) {
	let radix = 1
	for (const key of pickOrder) radix *= stepKeyRadix(key, components)
	return radix
}

export function pathKeyMode(pickOrder: readonly PickKey[], components = L.StaticLayerComponents): 'int' | 'string' {
	return pathKeyRadix(pickOrder, components) <= Number.MAX_SAFE_INTEGER ? 'int' : 'string'
}

export function packPathKey(pickOrder: readonly PickKey[], stepKeys: readonly number[], components = L.StaticLayerComponents) {
	if (pathKeyMode(pickOrder, components) === 'string') return stepKeys.join('_')
	let key = 0
	for (let i = 0; i < stepKeys.length; i++) key = key * stepKeyRadix(pickOrder[i], components) + stepKeys[i]
	return key
}

// whether a side is one the layer set actually has. a faction/unit pairing the game doesn't field is as inert as a
// faction it dropped: no layer can match it
export function isMatchupSideKnown(key: MatchupKey, side: MatchupSide, components = L.StaticLayerComponents) {
	if (key === 'FactionUnitMatchup') {
		const { Faction, Unit } = side as FactionUnit
		return components.factionToUnit[Faction]?.includes(Unit) ?? false
	}
	const column = MATCHUP_COLUMNS[key][0][0]
	return (groupByColumnDefaultValues(column, components) as string[]).includes(side as string)
}

// weight applied to values which aren't listed in the config for their column
export const DEFAULT_GENERATION_WEIGHT = 0.1

// deliberately permissive: an entry that is stale (a map dropped by a game update), weighted for a column that
// isn't picked, or duplicated is inert rather than wrong, and a settings document that fails to parse takes the
// server down with it (see loadGlobalSettings). The editor surfaces these instead; see layer-generation-config-editor.
export const LayerGenerationConfigSchema = z
	.object({
		pickOrder: z
			.array(PICK_KEYS)
			.prefault([])
			.describe(
				'Columns and matchups to pick weighted-randomly during layer generation, in the order they are picked. Each pick narrows the candidate pool for the next.',
			),
		weights: z
			.partialRecord(WEIGHT_COLUMNS, z.array(z.object({ value: z.string(), weight: z.number() })))
			.prefault({})
			.describe(
				`Relative selection weight per column value. Values not listed here are weighted ${DEFAULT_GENERATION_WEIGHT}. Weights are relative, not probabilities: they are normalized against the values actually available in the pool at pick time.`,
			),
		matchupWeights: MatchupWeightsSchema.describe(
			`Relative selection weight per matchup between the two teams. Matchups are unordered, so [ADF, PLA] and [PLA, ADF] are the same entry. Pairings not listed here are weighted ${DEFAULT_GENERATION_WEIGHT}.`,
		),
	})
	.prefault({})

export type LayerGenerationConfig = z.infer<typeof LayerGenerationConfigSchema>

export const LayerDbConfigSchema = z
	.object({
		columns: z.array(ColumnDefSchema),
	})
	.refine(
		(config) => {
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
		},
		{
			error: 'Duplicate/Preexisting column name',
		},
	)

export type LayerDbConfig = z.infer<typeof LayerDbConfigSchema>

export function buildFullLayerComponents(components: BaseLayerComponents, skipValidate = false) {
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

	const COLLECTION_ABBREVIATIONS: Record<string, string | null> = {
		OWI: null,
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
		collections: { Community: 'OWI' },
		collectionAbbreviations: { CL: 'OWI' },
		maps: {},
		units: {},
	}

	const src = components.sourceAbbreviations ?? { maps: {}, gamemodes: {}, units: {}, unitShortNames: {}, collections: {} }
	const mergeAbbreviations = <V extends string | null>(kind: string, core: Record<string, V>, added: Record<string, V>) => {
		const merged: Record<string, V> = { ...core }
		const values = new Set(Object.values(core).filter((v) => v !== null))
		for (const [name, abbreviation] of Object.entries(added)) {
			if (name in merged) {
				if (merged[name] !== abbreviation) throw new Error(`${kind} ${name} is already defined with abbreviation ${merged[name]}`)
				continue
			}
			if (abbreviation !== null && values.has(abbreviation)) {
				throw new Error(`${kind} ${name}: abbreviation ${abbreviation} is already taken`)
			}
			merged[name] = abbreviation
			if (abbreviation !== null) values.add(abbreviation)
		}
		return merged
	}
	const mapAbbreviations = mergeAbbreviations('map', MAP_ABBREVIATIONS, src.maps)
	const gamemodeAbbreviations = mergeAbbreviations('gamemode', GAMEMODE_ABBREVIATIONS as Record<string, string>, src.gamemodes)
	const unitAbbreviations = mergeAbbreviations('unit', UNIT_ABBREVIATIONS as Record<string, string>, src.units)
	const unitShortNames = { ...UNIT_SHORT_NAMES, ...src.unitShortNames }
	const collectionAbbreviations = mergeAbbreviations('collection', COLLECTION_ABBREVIATIONS, src.collections)
	if (Object.values(collectionAbbreviations).filter((abbreviation) => abbreviation === null).length !== 1) {
		throw new Error('exactly one collection must have a null abbreviation; it is the default collection')
	}

	if (!skipValidate) {
		for (const mapLayer of components.mapLayers) {
			if (!(mapLayer.Map in mapAbbreviations)) {
				throw new Error(`map ${mapLayer.Map} doesn't have an abbreviation`)
			}
			if (!(mapLayer.Gamemode in gamemodeAbbreviations)) {
				throw new Error(`gamemode ${mapLayer.Gamemode} doesn't have an abbreviation`)
			}
		}
		for (const subfaction of components.units) {
			if (subfaction === null) continue
			if (!(subfaction in unitAbbreviations)) {
				throw new Error(`subfaction ${subfaction} doesn't have an abbreviation`)
			}
			if (!(subfaction in unitShortNames)) {
				throw new Error(`subfaction ${subfaction} doesn't have a short name`)
			}
		}
	}

	const layerComponents: LayerComponents = {
		...components,
		layerFactionAvailability: expandLayerFactionAvailability(components.layerFactionAvailability),
		collections: Object.keys(collectionAbbreviations),
		collectionAbbreviations,
		gamemodeAbbreviations,
		unitAbbreviations,
		unitShortNames,
		mapAbbreviations,
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
		if (def.name.endsWith('Diff') || def.name == 'Balance_Differential')
			partitioned.diffs[def.name.replace(/_Diff$/, '')] = layer[def.name]
		else if (def.name.endsWith('_1')) partitioned.team1[def.name.replace(/_1$/, '')] = layer[def.name]
		else if (def.name.endsWith('_2')) partitioned.team2[def.name.replace(/_2$/, '')] = layer[def.name]
		else partitioned.other[def.name] = layer[def.name]
	}
	return partitioned
}

export type Ctx = CS.Ctx & { effectiveColsConfig: EffectiveColumnConfig }
export const CtxDef = CD.defCtx<Ctx>()(['effectiveColsConfig'], { name: 'effectiveColsConfig' })

export namespace Ctx {
	// the weighted-random layer generation config. unlike effectiveColsConfig this is admin-editable at
	// runtime (globalSettings.layerGeneration), so holders must refresh it when settings change
	export type Generation = CS.Ctx & { generationConfig: LayerGenerationConfig }
	export const GenerationDef = CD.defCtx<Generation>()(['generationConfig'], { name: 'layerGeneration' })
}
