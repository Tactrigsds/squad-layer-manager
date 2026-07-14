import type * as LC from '@/models/layer-columns'

// The columnar layer artifact the query engine reads (layer-engine/src/store.rs).
//
// Layout: "SLMC1", a u32 manifest length, the manifest as JSON, padding to a 4-byte boundary, then the column data.
// Column offsets are relative to the start of that data section, so the manifest's own length never feeds back into
// them. Enum columns are one byte per row (the widest, Layer, has 254 values), extra columns keep the
// precision-scaled integer encoding the layer db already used, and ids are i32. Null is NULL_U8 / NULL_I32.
//
// Rows are written in ascending id order. That is load-bearing twice over: the engine binary-searches ids to resolve
// a layer, and packed-id order groups rows by map and layer, so a selective pool filter leaves whole 64-row words
// empty and the filter scan skips them.

export const MAGIC = 'SLMC1'
export const ARTIFACT_EXT = '.bin'
export const NULL_U8 = 255
export const NULL_I32 = -2147483648

export type ColumnKind = 'u8' | 'i32'
export type ColSpec = { name: string; kind: ColumnKind; offset: number }
export type Manifest = { rowCount: number; columns: ColSpec[]; layersVersion: string }
// values may arrive as a plain array (null for missing) or as a typed array with the null sentinel already written,
// which is what preprocess uses: a plain array per column would cost hundreds of MB across 732k rows
export type ArtifactColumn = { name: string; kind: ColumnKind; values: ArrayLike<number | null> }

// enum columns index into their component list, which is why a byte is enough; everything else is already an integer
export function columnKind(def: LC.CombinedColumnDef): ColumnKind {
	if (def.name === 'id') return 'i32'
	switch (def.type) {
		case 'string':
			if (def.enumMapping) return 'u8'
			// a text extra column has no encoding the engine can compare against. None exist today, and adding one
			// would need a dictionary column, so fail loudly rather than silently dropping it.
			throw new Error(`Extra column "${def.name}" is a string; the layer engine has no string column type yet`)
		case 'boolean':
			return 'u8'
		case 'float':
		case 'integer':
			return 'i32'
		default:
			throw new Error(`Unsupported column type for "${(def as LC.CombinedColumnDef).name}"`)
	}
}

// the artifact carries every column of the effective config, in config order
export function artifactColumnDefs(cfg: LC.EffectiveColumnConfig) {
	return Object.values(cfg.defs).map((def) => ({ def, kind: columnKind(def) }))
}

// values arrive already db-encoded (enum indices, scaled ints), the same shape the layer db stored
export function writeArtifact(args: { rowCount: number; layersVersion: string; columns: ArtifactColumn[] }): Buffer {
	const { rowCount, columns } = args
	const specs: ColSpec[] = []
	const buffers: Buffer[] = []
	let offset = 0
	for (const column of columns) {
		if (column.values.length !== rowCount) {
			throw new Error(`Column ${column.name} has ${column.values.length} values, expected ${rowCount}`)
		}
		let buf: Buffer
		if (column.kind === 'u8') {
			buf = Buffer.alloc(rowCount)
			for (let i = 0; i < rowCount; i++) {
				const value = column.values[i]
				buf[i] = value === null ? NULL_U8 : value
			}
		} else {
			buf = Buffer.alloc(rowCount * 4)
			for (let i = 0; i < rowCount; i++) {
				const value = column.values[i]
				buf.writeInt32LE(value === null ? NULL_I32 : Math.round(value), i * 4)
			}
		}
		specs.push({ name: column.name, kind: column.kind, offset })
		buffers.push(buf)
		offset += buf.length
		// i32 columns are read as an aligned slice of wasm linear memory, so pad each column to a 4-byte boundary
		const pad = (4 - (offset % 4)) % 4
		if (pad > 0) {
			buffers.push(Buffer.alloc(pad))
			offset += pad
		}
	}

	const manifest = Buffer.from(JSON.stringify({ rowCount, columns: specs, layersVersion: args.layersVersion } satisfies Manifest))
	const header = Buffer.alloc(9)
	header.write(MAGIC, 0, 'ascii')
	header.writeUInt32LE(manifest.length, 5)
	const padding = Buffer.alloc((4 - ((header.length + manifest.length) % 4)) % 4)
	return Buffer.concat([header, manifest, padding, ...buffers])
}
