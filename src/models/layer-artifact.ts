import type * as LC from '@/models/layer-columns'

// The factored layer artifact the query engine reads (layer-engine/src/store.rs).
//
// Layout: "SLMC3", a u32 manifest length, the manifest as JSON, padding to a 4-byte boundary, then the sections back
// to back. Section offsets are relative to the start of that data, so the manifest's own length never feeds back into
// them, and every section is padded to a 4-byte boundary because the engine borrows u32/i32 sections as aligned
// slices of wasm linear memory.
//
// The table is not stored row by row. Rows are packed-id order, which groups them into one contiguous block per
// layer, and within a block the row set is the cross product of that layer's faction/unit availability. Two facts
// make that hugely redundant: a layer's non-team columns are constant across its whole block, and the per-team
// columns repeat verbatim across every layer sharing an availability list (986 layers draw on 314 distinct
// patterns). So each column is stored once per block, once per pattern row, or not at all:
//
//   block    Map, Layer, Size, Gamemode, LayerVersion, Collection - one value per block
//   pattern  Faction_1/2, Unit_1/2, UnitRecord_1/2 - one value per pattern row, shared by every block using it
//   alliance Alliance_1/2 - a lookup from the row's faction, so nothing is stored per row
//   id       the mixed-radix packing of (Layer, Faction_1, Unit_1, Faction_2, Unit_2), recomputed
//   score    an extra column that is a function of (Layer, Faction, Unit) for one team - one value per side record
//   diff     an extra column that is the difference of two score columns
//   bitmap   a boolean extra column - one bit per row
//   dict     any remaining extra column - a u16 code per row into a table of its distinct values
//
// Extra columns are deployment config (layer-db.json), so nothing here recognises them by name. `factorArtifact`
// classifies each one against the data and falls back to `dict`, which always works.

export const MAGIC = 'SLMC3'
export const ARTIFACT_EXT = '.bin'
export const NULL_U8 = 255
export const NULL_U16 = 65535
export const NULL_I32 = -2147483648

export type SectionKind = 'u8' | 'u16' | 'u32' | 'i32'
export type Section = { kind: SectionKind; offset: number; len: number }

export type ColumnSpec =
	| { name: string; scope: 'id' }
	| { name: string; scope: 'block'; section: number }
	| { name: string; scope: 'pattern'; section: number }
	| { name: string; scope: 'alliance'; team: 1 | 2 }
	| { name: string; scope: 'score'; team: 1 | 2; metric: number }
	| { name: string; scope: 'alias'; of: number }
	| { name: string; scope: 'diff'; a: number; b: number; correction: number | null }
	| { name: string; scope: 'bitmap'; section: number; nulls: number | null }
	| { name: string; scope: 'dict'; codes: number; dict: number }

// A `diff` column's correction, two bits per row: 0 leaves the difference alone, 1 adds one, 2 subtracts one.
// The source sheet computes a difference from unrounded floats and we store each side rounded, so the two can
// disagree by one in the last place. Carrying the trit costs 2 bits a row where storing the column costs 16.
export const DIFF_CORRECTION = [0, 1, -1] as const

export type Manifest = {
	rowCount: number
	layersVersion: string
	blockCount: number
	patternCount: number
	patternRowCount: number
	scoreCount: number
	scoreMetrics: number
	// enum sizes the id packing and the side-record key need
	layerCount: number
	factionCount: number
	unitCount: number
	columns: ColumnSpec[]
	sections: Section[]
	// fixed sections, by index into `sections`
	blockRowStart: number
	blockPattern: number
	patternRowStart: number
	factionAlliance: number
	scoreKey: number
	scoreLayerStart: number
	scoreVals: number
}

// Columns whose value is constant across a layer's whole block, and those that repeat per availability pattern.
// Both lists are the artifact's own structure rather than anything the filter language knows about.
export const BLOCK_SCOPE_COLUMNS = ['Map', 'Layer', 'Size', 'Gamemode', 'LayerVersion', 'Collection'] as const
export const PATTERN_SCOPE_COLUMNS = ['Faction_1', 'Faction_2', 'Unit_1', 'Unit_2', 'UnitRecord_1', 'UnitRecord_2'] as const
export const ALLIANCE_COLUMNS: Record<string, 1 | 2 | undefined> = { Alliance_1: 1, Alliance_2: 2 }

// Values arrive db-encoded in a typed array with the column's own null sentinel already written. A plain
// number|null array would cost hundreds of megabytes across 2.7M rows, so nulls travel as a sentinel throughout.
export type ArtifactColumn = { name: string; values: ArrayLike<number>; nullValue: number }

export type FactorInput = {
	rowCount: number
	layersVersion: string
	columns: ArtifactColumn[]
	layerCount: number
	factionCount: number
	unitCount: number
	// faction index -> alliance index, so Alliance_1/2 need no storage
	factionAlliance: ArrayLike<number>
	// boolean extras become bitmaps rather than dictionaries
	booleanColumns: ReadonlySet<string>
}

export function enumKind(size: number): 'u8' | 'u16' {
	return size > NULL_U8 ? 'u16' : 'u8'
}

export function sectionNull(kind: SectionKind): number {
	return kind === 'u8' ? NULL_U8 : kind === 'u16' ? NULL_U16 : NULL_I32
}

// the artifact carries every column of the effective config, in config order
export function artifactColumnDefs(cfg: LC.EffectiveColumnConfig) {
	return Object.values(cfg.defs).map((def) => ({ def }))
}

type PendingSection = { kind: SectionKind; values: ArrayLike<number> }

class SectionWriter {
	private pending: PendingSection[] = []

	push(kind: SectionKind, values: ArrayLike<number>): number {
		this.pending.push({ kind, values })
		return this.pending.length - 1
	}

	finish(): { sections: Section[]; buffers: Buffer[] } {
		const sections: Section[] = []
		const buffers: Buffer[] = []
		let offset = 0
		for (const { kind, values } of this.pending) {
			const width = kind === 'u8' ? 1 : kind === 'u16' ? 2 : 4
			const buf = Buffer.alloc(values.length * width)
			for (let i = 0; i < values.length; i++) {
				const v = values[i]
				if (kind === 'u8') buf.writeUInt8(v, i)
				else if (kind === 'u16') buf.writeUInt16LE(v, i * 2)
				else if (kind === 'u32') buf.writeUInt32LE(v, i * 4)
				else buf.writeInt32LE(v, i * 4)
			}
			sections.push({ kind, offset, len: values.length })
			buffers.push(buf)
			offset += buf.length
			const pad = (4 - (offset % 4)) % 4
			if (pad > 0) {
				buffers.push(Buffer.alloc(pad))
				offset += pad
			}
		}
		return { sections, buffers }
	}
}

// Rows are packed-id order, so every layer's rows are one contiguous run. Anything else means the caller built the
// table in the wrong order, and every scope below would silently store the wrong value.
function blockBoundaries(layer: ArrayLike<number>, rowCount: number): Uint32Array {
	const starts: number[] = []
	const seen = new Set<number>()
	for (let i = 0; i < rowCount; i++) {
		if (i === 0 || layer[i] !== layer[i - 1]) {
			if (seen.has(layer[i])) throw new Error(`layer ${layer[i]} appears in more than one run; rows are not in packed-id order`)
			seen.add(layer[i])
			starts.push(i)
		}
	}
	starts.push(rowCount)
	return Uint32Array.from(starts)
}

export function factorArtifact(input: FactorInput): Buffer {
	const { rowCount, columns, layerCount, factionCount, unitCount } = input
	const byName = new Map(columns.map((c) => [c.name, c]))
	const need = (name: string) => {
		const column = byName.get(name)
		if (!column) throw new Error(`factorArtifact: missing column ${name}`)
		return column
	}

	const layerCol = need('Layer')
	const starts = blockBoundaries(layerCol.values, rowCount)
	const blockCount = starts.length - 1

	const writer = new SectionWriter()
	const blockRowStart = writer.push('u32', starts)

	// An older artifact can be missing a column the current build writes (UnitRecord arrived after the first ones
	// shipped), so both scope lists are filtered to what the caller actually handed over.
	const blockScope = BLOCK_SCOPE_COLUMNS.filter((name) => byName.has(name))
	const patternScope = PATTERN_SCOPE_COLUMNS.filter((name) => byName.has(name))

	// --- block-scope columns: one value per block, checked constant across it ---
	const blockSections = new Map<string, number>()
	for (const name of blockScope) {
		const { values, nullValue } = need(name)
		const kind = name === 'Layer' ? enumKind(layerCount) : 'u8'
		const out = kind === 'u16' ? new Uint16Array(blockCount) : new Uint8Array(blockCount)
		const outNull = sectionNull(kind)
		for (let b = 0; b < blockCount; b++) {
			const first = values[starts[b]]
			for (let i = starts[b] + 1; i < starts[b + 1]; i++) {
				if (values[i] !== first) throw new Error(`column ${name} is not constant across layer block ${b}`)
			}
			out[b] = first === nullValue ? outNull : first
		}
		blockSections.set(name, writer.push(kind, out))
	}

	// --- pattern-scope columns: a block's per-team run, deduped across every block that repeats it ---
	// Two passes over the row space, no per-row allocation: hash each block's run, then copy only the runs that turn
	// out to be new. Hash buckets hold candidate pattern ids and a collision falls through to a value comparison, so
	// the hash never has to be perfect.
	const patternCols = patternScope.map((name) => need(name))
	const blockPattern = new Uint16Array(blockCount)
	const patternOwner: number[] = [] // pattern id -> the block whose run defines it
	const buckets = new Map<number, number[]>()

	const hashBlock = (b: number) => {
		let hash = 2166136261
		for (let i = starts[b]; i < starts[b + 1]; i++) {
			for (let c = 0; c < patternCols.length; c++) hash = Math.imul(hash ^ patternCols[c].values[i], 16777619)
		}
		return hash >>> 0
	}
	const runsEqual = (a: number, b: number) => {
		const len = starts[a + 1] - starts[a]
		if (len !== starts[b + 1] - starts[b]) return false
		for (let j = 0; j < len; j++) {
			for (let c = 0; c < patternCols.length; c++) {
				if (patternCols[c].values[starts[a] + j] !== patternCols[c].values[starts[b] + j]) return false
			}
		}
		return true
	}

	for (let b = 0; b < blockCount; b++) {
		const hash = hashBlock(b)
		let bucket = buckets.get(hash)
		if (!bucket) buckets.set(hash, (bucket = []))
		let index = bucket.find((candidate) => runsEqual(patternOwner[candidate], b))
		if (index === undefined) {
			index = patternOwner.length
			patternOwner.push(b)
			bucket.push(index)
		}
		blockPattern[b] = index
	}
	const patternCount = patternOwner.length
	if (patternCount >= NULL_U16) throw new Error(`${patternCount} availability patterns overflows the u16 block index`)

	const patternStarts = new Uint32Array(patternCount + 1)
	for (let p = 0; p < patternCount; p++) {
		const owner = patternOwner[p]
		patternStarts[p + 1] = patternStarts[p] + (starts[owner + 1] - starts[owner])
	}
	const patternRowCount = patternStarts[patternCount]

	const blockPatternSection = writer.push('u16', blockPattern)
	const patternRowStart = writer.push('u32', patternStarts)
	const patternSections = new Map<string, number>()
	for (let c = 0; c < patternScope.length; c++) {
		const name = patternScope[c]
		const kind = name.startsWith('UnitRecord') ? 'u16' : enumKind(name.startsWith('Faction') ? factionCount : unitCount)
		const outNull = sectionNull(kind)
		const { values, nullValue } = patternCols[c]
		const out = kind === 'u16' ? new Uint16Array(patternRowCount) : new Uint8Array(patternRowCount)
		for (let p = 0; p < patternCount; p++) {
			const owner = patternOwner[p]
			let source = starts[owner]
			for (let i = patternStarts[p]; i < patternStarts[p + 1]; i++, source++) {
				out[i] = values[source] === nullValue ? outNull : values[source]
			}
		}
		patternSections.set(name, writer.push(kind, out))
	}

	const factionAlliance = writer.push('u8', input.factionAlliance)

	// Alliance_1/2 are dropped in favour of the faction lookup, so the two must already agree. If they ever don't,
	// the artifact would silently answer alliance queries with a different value than the caller handed in.
	for (const [name, team] of Object.entries(ALLIANCE_COLUMNS)) {
		const stored = byName.get(name)
		if (!stored) continue
		const source = need(`Faction_${team}`)
		for (let i = 0; i < rowCount; i++) {
			const f = source.values[i]
			const want = f === source.nullValue ? null : input.factionAlliance[f]
			const got = stored.values[i] === stored.nullValue ? null : stored.values[i]
			if (want !== got) {
				throw new Error(`${name} row ${i} is ${got}, but faction ${f} maps to alliance ${want}`)
			}
		}
	}

	// --- extra columns ---
	const baseNames = new Set<string>(['id', ...blockScope, ...patternScope, ...Object.keys(ALLIANCE_COLUMNS)])
	const extras = columns.filter((c) => !baseNames.has(c.name))

	const faction = [need('Faction_1'), need('Faction_2')] as const
	const unit = [need('Unit_1'), need('Unit_2')] as const
	// -1 when any component is null, which is a row whose side can hold no record
	const sideKey = (i: number, team: 1 | 2) => {
		const f = faction[team - 1]
		const u = unit[team - 1]
		if (layerCol.values[i] === layerCol.nullValue) return -1
		if (f.values[i] === f.nullValue || u.values[i] === u.nullValue) return -1
		return (layerCol.values[i] * factionCount + f.values[i]) * unitCount + u.values[i]
	}

	// A metric's team-1 and team-2 halves are the same function of (Layer, Faction, Unit), so they share one column
	// of the side table. Both halves must agree everywhere and be null in exactly the rows whose side has no record.
	const sideMetrics: Map<number, number>[] = []
	const sideMetricOf = new Map<string, { metric: number; team: 1 | 2 }>()
	const paired = new Map<string, { one?: ArtifactColumn; two?: ArtifactColumn }>()
	for (const column of extras) {
		const match = /^(.*)_([12])$/.exec(column.name)
		if (!match) continue
		let entry = paired.get(match[1])
		if (!entry) paired.set(match[1], (entry = {}))
		if (match[2] === '1') entry.one = column
		else entry.two = column
	}

	for (const { one, two } of paired.values()) {
		if (!one || !two) continue
		if (input.booleanColumns.has(one.name) || input.booleanColumns.has(two.name)) continue
		const table = new Map<number, number>()
		const halves = [one, two] as const
		let ok = true
		for (let i = 0; i < rowCount && ok; i++) {
			for (let t = 0; t < 2; t++) {
				const half = halves[t]
				const value = half.values[i]
				if (value === half.nullValue) continue
				const key = sideKey(i, (t + 1) as 1 | 2)
				if (key < 0) {
					ok = false
					break
				}
				const prev = table.get(key)
				if (prev === undefined) table.set(key, value)
				else if (prev !== value) {
					ok = false
					break
				}
			}
		}
		if (!ok) continue
		for (let i = 0; i < rowCount && ok; i++) {
			for (let t = 0; t < 2; t++) {
				const half = halves[t]
				const isNull = half.values[i] === half.nullValue
				if (isNull === table.has(sideKey(i, (t + 1) as 1 | 2))) {
					ok = false
					break
				}
			}
		}
		if (!ok) continue
		const metric = sideMetrics.length
		sideMetrics.push(table)
		sideMetricOf.set(one.name, { metric, team: 1 })
		sideMetricOf.set(two.name, { metric, team: 2 })
	}

	// one record serves every metric, so the key universe is their union
	const keySet = new Set<number>()
	for (const table of sideMetrics) for (const key of table.keys()) keySet.add(key)
	const scoreKeys = Uint32Array.from(Array.from(keySet).sort((a, b) => a - b))
	const scoreIndex = new Map<number, number>()
	scoreKeys.forEach((k, i) => scoreIndex.set(k, i))
	const scoreCount = scoreKeys.length
	const scoreMetrics = sideMetrics.length
	const scoreVals = new Int32Array(Math.max(1, scoreCount * scoreMetrics)).fill(NULL_I32)
	for (let m = 0; m < scoreMetrics; m++) {
		for (const [key, value] of sideMetrics[m]) scoreVals[scoreIndex.get(key)! * scoreMetrics + m] = value
	}
	// keys are layer-major and sorted, so a layer's records are contiguous: a block resolves its range once and
	// binary-searches only inside it
	const scoreLayerStart = new Uint32Array(layerCount + 1)
	{
		const perLayer = factionCount * unitCount
		let cursor = 0
		for (let layer = 0; layer <= layerCount; layer++) {
			while (cursor < scoreCount && Math.floor(scoreKeys[cursor] / perLayer) < layer) cursor++
			scoreLayerStart[layer] = cursor
		}
	}
	const scoreKeySection = writer.push('u32', scoreCount ? scoreKeys : new Uint32Array(1))
	const scoreLayerStartSection = writer.push('u32', scoreLayerStart)
	const scoreValsSection = writer.push('i32', scoreVals)

	// --- column specs, in the order the caller gave them ---
	const columnIndexOf = new Map(columns.map((c, i) => [c.name, i]))
	const specs: ColumnSpec[] = []
	for (let index = 0; index < columns.length; index++) {
		const column = columns[index]
		const name = column.name
		if (name === 'id') {
			specs.push({ name, scope: 'id' })
			continue
		}
		const block = blockSections.get(name)
		if (block !== undefined) {
			specs.push({ name, scope: 'block', section: block })
			continue
		}
		const pattern = patternSections.get(name)
		if (pattern !== undefined) {
			specs.push({ name, scope: 'pattern', section: pattern })
			continue
		}
		const alliance = ALLIANCE_COLUMNS[name]
		if (alliance !== undefined) {
			specs.push({ name, scope: 'alliance', team: alliance })
			continue
		}
		const side = sideMetricOf.get(name)
		if (side) {
			specs.push({ name, scope: 'score', team: side.team, metric: side.metric })
			continue
		}
		const alias = findAlias(column, columns, rowCount, index)
		if (alias !== undefined) {
			specs.push({ name, scope: 'alias', of: columnIndexOf.get(alias)! })
			continue
		}
		const diff = findDiff(column, columns, sideMetricOf, rowCount)
		if (diff) {
			specs.push({
				name,
				scope: 'diff',
				a: columnIndexOf.get(diff.a)!,
				b: columnIndexOf.get(diff.b)!,
				correction: diff.correction ? writer.push('u8', diff.correction) : null,
			})
			continue
		}
		if (input.booleanColumns.has(name)) {
			const bits = new Uint8Array(Math.ceil(rowCount / 8))
			const nulls = new Uint8Array(Math.ceil(rowCount / 8))
			let anyNull = false
			for (let i = 0; i < rowCount; i++) {
				const v = column.values[i]
				if (v === column.nullValue) {
					nulls[i >> 3] |= 1 << (i & 7)
					anyNull = true
				} else if (v !== 0) bits[i >> 3] |= 1 << (i & 7)
			}
			specs.push({
				name,
				scope: 'bitmap',
				section: writer.push('u8', bits),
				nulls: anyNull ? writer.push('u8', nulls) : null,
			})
			continue
		}
		const dict = buildDictionary(column, rowCount)
		specs.push({ name, scope: 'dict', codes: writer.push('u16', dict.codes), dict: writer.push('i32', dict.values) })
	}

	const { sections, buffers } = writer.finish()
	const manifest: Manifest = {
		rowCount,
		layersVersion: input.layersVersion,
		blockCount,
		patternCount,
		patternRowCount,
		scoreCount,
		scoreMetrics,
		layerCount,
		factionCount,
		unitCount,
		columns: specs,
		sections,
		blockRowStart,
		blockPattern: blockPatternSection,
		patternRowStart,
		factionAlliance,
		scoreKey: scoreKeySection,
		scoreLayerStart: scoreLayerStartSection,
		scoreVals: scoreValsSection,
	}
	const manifestBuf = Buffer.from(JSON.stringify(manifest))
	const header = Buffer.alloc(9)
	header.write(MAGIC, 0, 'ascii')
	header.writeUInt32LE(manifestBuf.length, 5)
	const padding = Buffer.alloc((4 - ((header.length + manifestBuf.length) % 4)) % 4)
	return Buffer.concat([header, manifestBuf, padding, ...buffers])
}

// A column that is another one verbatim needs no storage at all. Two of the sheet's outputs are the same number
// under different names, which is worth catching before anything is written.
//
// Only ever aliases backwards. Two identical columns each qualify as the other's alias, and a pair that points at
// each other is a cycle no reader can resolve.
function findAlias(column: ArtifactColumn, columns: ArtifactColumn[], rowCount: number, before: number): string | undefined {
	for (let c = 0; c < before; c++) {
		const other = columns[c]
		let ok = true
		for (let i = 0; i < rowCount; i++) {
			const a = column.values[i] === column.nullValue
			const b = other.values[i] === other.nullValue
			if (a !== b || (!a && column.values[i] !== other.values[i])) {
				ok = false
				break
			}
		}
		if (ok) return other.name
	}
	return undefined
}

// A column that is the difference of two side metrics needs no per-row value, only the trit reconciling our rounded
// sides with the sheet's unrounded subtraction. Nulls have to line up: the difference is null exactly where either
// side is. A correction outside +-1 is not rounding, so the column is left to another scope.
function findDiff(
	column: ArtifactColumn,
	columns: ArtifactColumn[],
	sideMetricOf: Map<string, { metric: number; team: 1 | 2 }>,
	rowCount: number,
): { a: string; b: string; correction: Uint8Array | null } | undefined {
	const candidates = columns.filter((c) => sideMetricOf.has(c.name))
	for (const a of candidates) {
		for (const b of candidates) {
			if (a.name === b.name) continue
			const correction = new Uint8Array(Math.ceil(rowCount / 4))
			let ok = true
			let corrected = false
			for (let i = 0; i < rowCount; i++) {
				const x = a.values[i]
				const y = b.values[i]
				const d = column.values[i]
				if (x === a.nullValue || y === b.nullValue) {
					if (d !== column.nullValue) {
						ok = false
						break
					}
					continue
				}
				if (d === column.nullValue) {
					ok = false
					break
				}
				const delta = d - (x - y)
				const trit = delta === 0 ? 0 : delta === 1 ? 1 : delta === -1 ? 2 : -1
				if (trit < 0) {
					ok = false
					break
				}
				if (trit !== 0) {
					correction[i >> 2] |= trit << ((i & 3) * 2)
					corrected = true
				}
			}
			if (ok) return { a: a.name, b: b.name, correction: corrected ? correction : null }
		}
	}
	return undefined
}

function buildDictionary(column: ArtifactColumn, rowCount: number): { codes: Uint16Array; values: Int32Array } {
	const index = new Map<number, number>()
	const values: number[] = []
	const codes = new Uint16Array(rowCount)
	for (let i = 0; i < rowCount; i++) {
		const v = column.values[i]
		if (v === column.nullValue) {
			codes[i] = NULL_U16
			continue
		}
		let code = index.get(v)
		if (code === undefined) {
			code = values.length
			if (code >= NULL_U16) {
				throw new Error(`column ${column.name} has more than ${NULL_U16} distinct values; it needs a wider dictionary`)
			}
			index.set(v, code)
			values.push(v)
		}
		codes[i] = code
	}
	return { codes, values: Int32Array.from(values.length ? values : [0]) }
}

// ---------------------------------------------------------------------------
// Reader. The engine reads the artifact in Rust; this side exists so preprocess can verify what it just wrote and so
// tests can assert against the row-wise table without a wasm round trip.

export type SectionData = Uint8Array | Uint16Array | Uint32Array | Int32Array

export type Artifact = {
	manifest: Manifest
	sections: SectionData[]
	blockRowStart: Uint32Array
	blockPattern: Uint16Array
	patternRowStart: Uint32Array
	factionAlliance: Uint8Array
	scoreKey: Uint32Array
	scoreLayerStart: Uint32Array
	scoreVals: Int32Array
	columnIndex: Map<string, number>
}

export function readArtifact(bytes: Buffer): Artifact {
	if (bytes.length < 9 || bytes.toString('ascii', 0, 5) !== MAGIC) {
		throw new Error(`not a ${MAGIC} layer artifact`)
	}
	const manifestLen = bytes.readUInt32LE(5)
	const manifest: Manifest = JSON.parse(bytes.toString('utf8', 9, 9 + manifestLen))
	const header = 9 + manifestLen
	const dataStart = header + ((4 - (header % 4)) % 4)
	const sections = manifest.sections.map((s): SectionData => {
		const offset = bytes.byteOffset + dataStart + s.offset
		switch (s.kind) {
			case 'u8':
				return new Uint8Array(bytes.buffer, offset, s.len)
			case 'u16':
				return new Uint16Array(bytes.buffer, offset, s.len)
			case 'u32':
				return new Uint32Array(bytes.buffer, offset, s.len)
			case 'i32':
				return new Int32Array(bytes.buffer, offset, s.len)
		}
	})
	return {
		manifest,
		sections,
		blockRowStart: sections[manifest.blockRowStart] as Uint32Array,
		blockPattern: sections[manifest.blockPattern] as Uint16Array,
		patternRowStart: sections[manifest.patternRowStart] as Uint32Array,
		factionAlliance: sections[manifest.factionAlliance] as Uint8Array,
		scoreKey: sections[manifest.scoreKey] as Uint32Array,
		scoreLayerStart: sections[manifest.scoreLayerStart] as Uint32Array,
		scoreVals: sections[manifest.scoreVals] as Int32Array,
		columnIndex: new Map(manifest.columns.map((c, i) => [c.name, i])),
	}
}

// Resolves a (layer, faction, unit) side record, or -1. Records are sorted and layer-major, so the layer's range
// comes straight off scoreLayerStart and only that range is searched.
export function sideRecord(art: Artifact, layer: number, faction: number, unit: number): number {
	if (layer < 0 || faction < 0 || unit < 0) return -1
	const key = (layer * art.manifest.factionCount + faction) * art.manifest.unitCount + unit
	let lo = art.scoreLayerStart[layer]
	let hi = art.scoreLayerStart[layer + 1] - 1
	while (lo <= hi) {
		const mid = (lo + hi) >> 1
		const v = art.scoreKey[mid]
		if (v === key) return mid
		if (v < key) lo = mid + 1
		else hi = mid - 1
	}
	return -1
}

// Expands one column across the whole row space, with NULL_I32 for null. Walks block by block, so a block-scope
// value is read once per block and a pattern-scope value once per pattern row: the same shape the engine scans in.
export function expandColumn(art: Artifact, columnIndex: number): Int32Array {
	const { manifest } = art
	const spec = manifest.columns[columnIndex]
	const out = new Int32Array(manifest.rowCount).fill(NULL_I32)
	const blockCount = manifest.blockCount

	switch (spec.scope) {
		case 'block': {
			const data = art.sections[spec.section]
			const nullValue = sectionNull(manifest.sections[spec.section].kind)
			for (let b = 0; b < blockCount; b++) {
				out.fill(data[b] === nullValue ? NULL_I32 : data[b], art.blockRowStart[b], art.blockRowStart[b + 1])
			}
			return out
		}
		case 'pattern': {
			const data = art.sections[spec.section]
			const nullValue = sectionNull(manifest.sections[spec.section].kind)
			for (let b = 0; b < blockCount; b++) {
				const end = art.blockRowStart[b + 1]
				let p = art.patternRowStart[art.blockPattern[b]]
				for (let i = art.blockRowStart[b]; i < end; i++, p++) out[i] = data[p] === nullValue ? NULL_I32 : data[p]
			}
			return out
		}
		case 'alliance': {
			const faction = expandColumn(art, art.columnIndex.get(`Faction_${spec.team}`)!)
			for (let i = 0; i < manifest.rowCount; i++) {
				out[i] = faction[i] === NULL_I32 ? NULL_I32 : art.factionAlliance[faction[i]]
			}
			return out
		}
		case 'id': {
			const layer = expandColumn(art, art.columnIndex.get('Layer')!)
			const f1 = expandColumn(art, art.columnIndex.get('Faction_1')!)
			const u1 = expandColumn(art, art.columnIndex.get('Unit_1')!)
			const f2 = expandColumn(art, art.columnIndex.get('Faction_2')!)
			const u2 = expandColumn(art, art.columnIndex.get('Unit_2')!)
			const { factionCount, unitCount } = manifest
			for (let i = 0; i < manifest.rowCount; i++) {
				out[i] = (((layer[i] * factionCount + f1[i]) * unitCount + u1[i]) * factionCount + f2[i]) * unitCount + u2[i]
			}
			return out
		}
		case 'score': {
			const layer = expandColumn(art, art.columnIndex.get('Layer')!)
			const faction = expandColumn(art, art.columnIndex.get(`Faction_${spec.team}`)!)
			const unit = expandColumn(art, art.columnIndex.get(`Unit_${spec.team}`)!)
			for (let i = 0; i < manifest.rowCount; i++) {
				const record = sideRecord(art, layer[i], faction[i], unit[i])
				out[i] = record < 0 ? NULL_I32 : art.scoreVals[record * manifest.scoreMetrics + spec.metric]
			}
			return out
		}
		case 'alias':
			return expandColumn(art, spec.of)
		case 'diff': {
			const a = expandColumn(art, spec.a)
			const b = expandColumn(art, spec.b)
			const correction = spec.correction === null ? null : (art.sections[spec.correction] as Uint8Array)
			for (let i = 0; i < manifest.rowCount; i++) {
				if (a[i] === NULL_I32 || b[i] === NULL_I32) continue
				const trit = correction === null ? 0 : (correction[i >> 2] >> ((i & 3) * 2)) & 3
				out[i] = a[i] - b[i] + DIFF_CORRECTION[trit]
			}
			return out
		}
		case 'bitmap': {
			const bits = art.sections[spec.section] as Uint8Array
			const nulls = spec.nulls === null ? null : (art.sections[spec.nulls] as Uint8Array)
			for (let i = 0; i < manifest.rowCount; i++) {
				if (nulls !== null && (nulls[i >> 3] >> (i & 7)) & 1) continue
				out[i] = (bits[i >> 3] >> (i & 7)) & 1
			}
			return out
		}
		case 'dict': {
			const codes = art.sections[spec.codes] as Uint16Array
			const values = art.sections[spec.dict] as Int32Array
			for (let i = 0; i < manifest.rowCount; i++) out[i] = codes[i] === NULL_U16 ? NULL_I32 : values[codes[i]]
			return out
		}
	}
}
