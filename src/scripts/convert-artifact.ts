import * as fs from 'fs'
import * as fsPromise from 'fs/promises'
import { promisify } from 'node:util'
import zlib from 'node:zlib'
import path from 'path'

import * as Paths from '$root/paths'
import type * as L from '@/models/layer'
import * as LA from '@/models/layer-artifact'
import * as LC from '@/models/layer-columns'
import * as LayerArtifacts from '@/systems/layer-artifacts.server'

// Rewrites an SLMC2 artifact (one column per row) as an SLMC3 one (block/pattern/side-record scopes), then verifies
// the rewrite by expanding every column back and comparing it to the source, row for row.
//
// This exists because the csv preprocess ingests is per-deployment and too big to ship, so the artifacts checked in
// under assets/layers cannot be rebuilt from source here. Converting them is exact and checkable; regenerating them
// without their csv is not. Preprocess writes SLMC3 directly and shares the same factoring code.

const gunzip = promisify(zlib.gunzip)
const gzip = promisify(zlib.gzip)

const LEGACY_MAGICS = ['SLMC1', 'SLMC2']
const LEGACY_NULL = { u8: 255, u16: 65535, i32: -2147483648 } as const

type LegacyColumn = { name: string; kind: keyof typeof LEGACY_NULL; values: ArrayLike<number>; nullValue: number }

function readLegacyArtifact(bytes: Buffer): { rowCount: number; layersVersion: string; columns: LegacyColumn[] } {
	const magic = bytes.toString('ascii', 0, 5)
	if (!LEGACY_MAGICS.includes(magic)) throw new Error(`not a legacy layer artifact (magic ${magic})`)
	const manifestLen = bytes.readUInt32LE(5)
	const manifest = JSON.parse(bytes.toString('utf8', 9, 9 + manifestLen)) as {
		rowCount: number
		layersVersion: string
		columns: { name: string; kind: keyof typeof LEGACY_NULL; offset: number }[]
	}
	const header = 9 + manifestLen
	const dataStart = header + ((4 - (header % 4)) % 4)
	const columns = manifest.columns.map((spec): LegacyColumn => {
		const offset = bytes.byteOffset + dataStart + spec.offset
		const values =
			spec.kind === 'u8'
				? new Uint8Array(bytes.buffer, offset, manifest.rowCount)
				: spec.kind === 'u16'
					? new Uint16Array(bytes.buffer, offset, manifest.rowCount)
					: new Int32Array(bytes.buffer, offset, manifest.rowCount)
		return { name: spec.name, kind: spec.kind, values, nullValue: LEGACY_NULL[spec.kind] }
	})
	return { rowCount: manifest.rowCount, layersVersion: manifest.layersVersion, columns }
}

async function readArtifactBytes(filePath: string): Promise<Buffer> {
	const raw = await fsPromise.readFile(filePath)
	return filePath.endsWith('.gz') ? await gunzip(raw) : raw
}

async function main() {
	const version = process.argv[2]
	if (!version) {
		throw new Error('usage: pnpm tsx src/scripts/convert-artifact.ts <version> [inputDir] [outputDir]')
	}
	const inputDir = process.argv[3] ?? Paths.LAYERS
	const outputDir = process.argv[4] ?? inputDir

	const layerDataPath = path.join(inputDir, LayerArtifacts.layerDataFileName(version))
	const file = JSON.parse(await fsPromise.readFile(layerDataPath, 'utf-8')) as L.LayerDataFile
	const components = LC.buildFullLayerComponents(file.components)

	const compressed = path.join(inputDir, LayerArtifacts.tableFileName(version, { compressed: true }))
	const raw = path.join(inputDir, LayerArtifacts.tableFileName(version))
	const sourcePath = fs.existsSync(raw) ? raw : compressed
	console.log(`reading ${sourcePath}`)
	const legacy = readLegacyArtifact(await readArtifactBytes(sourcePath))
	console.log(`  ${legacy.rowCount.toLocaleString()} rows, ${legacy.columns.length} columns, version ${legacy.layersVersion}`)

	const factionAlliance = new Uint8Array(components.factions.length)
	for (let i = 0; i < components.factions.length; i++) {
		const alliance = components.factionToAlliance[components.factions[i]]
		const index = components.alliances.indexOf(alliance)
		if (index < 0) throw new Error(`faction ${components.factions[i]} has no alliance in the components`)
		factionAlliance[i] = index
	}

	const booleanColumns = new Set(file.extraColumns.filter((def) => def.type === 'boolean').map((def) => def.name))

	console.log('factoring...')
	const started = Date.now()
	const out = LA.factorArtifact({
		rowCount: legacy.rowCount,
		layersVersion: legacy.layersVersion,
		columns: legacy.columns,
		layerCount: components.layers.length,
		factionCount: components.factions.length,
		unitCount: components.units.length,
		factionAlliance,
		booleanColumns,
	})
	console.log(`  ${((Date.now() - started) / 1000).toFixed(1)}s -> ${(out.length / 1e6).toFixed(2)} MB`)

	verify(out, legacy)

	const outPath = path.join(outputDir, LayerArtifacts.tableFileName(version))
	await fsPromise.mkdir(outputDir, { recursive: true })
	await fsPromise.writeFile(outPath, out)
	const gz = await gzip(out, { level: 5 })
	await fsPromise.writeFile(`${outPath}.gz`, gz)
	console.log(`wrote ${outPath} (${(out.length / 1e6).toFixed(2)} MB) and .gz (${(gz.length / 1e6).toFixed(2)} MB)`)
}

// Every column, every row. A factoring bug that only shows up on one scope or one null would otherwise reach the
// engine as silently wrong data rather than a failure.
function verify(bytes: Buffer, legacy: { rowCount: number; columns: LegacyColumn[] }) {
	const art = LA.readArtifact(bytes)
	const { manifest } = art
	if (manifest.rowCount !== legacy.rowCount) {
		throw new Error(`row count changed: ${legacy.rowCount} -> ${manifest.rowCount}`)
	}
	console.log(
		`verifying ${manifest.columns.length} columns x ${manifest.rowCount.toLocaleString()} rows ` +
			`(${manifest.blockCount} blocks, ${manifest.patternCount} patterns, ${manifest.scoreCount} side records)`,
	)
	const scopes = new Map<string, number>()
	for (const spec of manifest.columns) scopes.set(spec.scope, (scopes.get(spec.scope) ?? 0) + 1)
	console.log('  scopes:', [...scopes].map(([k, n]) => `${k}=${n}`).join(' '))

	for (let c = 0; c < manifest.columns.length; c++) {
		const spec = manifest.columns[c]
		const source = legacy.columns.find((column) => column.name === spec.name)
		if (!source) throw new Error(`column ${spec.name} is not in the source artifact`)
		const expanded = LA.expandColumn(art, c)
		for (let i = 0; i < legacy.rowCount; i++) {
			const want = source.values[i] === source.nullValue ? LA.NULL_I32 : source.values[i]
			if (expanded[i] !== want) {
				throw new Error(`column ${spec.name} (${spec.scope}) row ${i}: expected ${want}, got ${expanded[i]}`)
			}
		}
		console.log(`  ${spec.name.padEnd(22)} ${spec.scope.padEnd(9)} exact`)
	}
	console.log('all columns reproduce the source artifact exactly')
}

await main()

process.exit(0)
