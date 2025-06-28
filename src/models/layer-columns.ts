import { z } from 'zod'
import * as L from './layer'

export const COLUMN_TYPES = ['float', 'string', 'integer', 'boolean'] as const
export const COLUMN_TYPE = z.enum(COLUMN_TYPES)
export type ColumnType = z.infer<typeof COLUMN_TYPE>

const baseProperties = {
	name: z.string(),
	displayName: z.string(),
}
export const ColumnDefSchema = z.discriminatedUnion('type', [
	z.object({
		type: z.literal('string'),
		...baseProperties,
		length: z.number().min(1).max(255),
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

export const ExtraColumnsConfigSchema = z.object({
	columns: z.array(ColumnDefSchema),
}).refine(config => {
	const allCols = new Set(COLUMN_KEYS) as Set<string>
	for (const col of config.columns) {
		if (allCols.has(col.name)) throw new Error(`Duplicate/Preexisting column name: ${col.name}`)
		allCols.add(col.name)
	}
}, { message: 'Duplicate/Preexisting column name' })

export type ExtraColumnsConfig = z.infer<typeof ExtraColumnsConfigSchema>

export type LayerColumnKey = keyof L.KnownLayer

export function createColumnDef<K extends LayerColumnKey, T extends Omit<ColumnDef, 'name'>>(name: K, def: T) {
	return {
		[name]: { ...def, name },
	}
}

export const BASE_COLUMN_DEFS = {
	...createColumnDef('id', { type: 'string', displayName: 'ID', length: 64 }),

	...createColumnDef('Map', { type: 'string', displayName: 'Map', length: 255 }),
	...createColumnDef('Layer', { type: 'string', displayName: 'Layer', length: 255 }),
	...createColumnDef('Size', { type: 'string', displayName: 'Size', length: 255 }),
	...createColumnDef('Gamemode', { type: 'string', displayName: 'Gamemode', length: 255 }),
	...createColumnDef('LayerVersion', { type: 'string', displayName: 'Version', length: 255 }),

	...createColumnDef('Faction_1', { type: 'string', displayName: 'T1', length: 255 }),
	...createColumnDef('Faction_2', { type: 'string', displayName: 'T2', length: 255 }),

	...createColumnDef('Unit_1', { type: 'string', displayName: 'Unit T1', length: 255 }),
	...createColumnDef('Unit_2', { type: 'string', displayName: 'Unit T2', length: 255 }),

	...createColumnDef('Alliance_1', { type: 'string', displayName: 'Alliance T1', length: 255 }),
	...createColumnDef('Alliance_2', { type: 'string', displayName: 'Alliance T2', length: 255 }),
} as const satisfies Record<string, ColumnDef>

export const COLUMN_KEYS = Object.keys(BASE_COLUMN_DEFS) as LayerColumnKey[]

export type EffectiveColumnConfig = {
	defs: Record<string | LayerColumnKey, ColumnDef>
}

export const BASE_COLUMN_CONFIG: EffectiveColumnConfig = {
	defs: BASE_COLUMN_DEFS,
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
] as const satisfies LayerColumnKey[]
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
] as const satisfies LayerColumnKey[]
export type WeightColumn = typeof WEIGHT_COLUMNS[number]

export function isLayerColumnKey(key: string, cfg = BASE_COLUMN_DEFS): key is LayerColumnKey {
	return key in cfg.defs
}
