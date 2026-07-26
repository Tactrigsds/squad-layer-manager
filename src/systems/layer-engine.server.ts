import crypto from 'crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import zlib from 'node:zlib'

import * as Paths from '$root/paths'
import type * as CS from '@/models/context-shared'
import * as LA from '@/models/layer-artifact'
import { initModule } from '@/server/logger'
import * as LayerArtifacts from '@/systems/layer-artifacts.server'
import { LayerEngine } from '@/systems/layer-engine.shared'

const gunzip = promisify(zlib.gunzip)
const gzip = promisify(zlib.gzip)
const module = initModule('layer-engine')
let log!: CS.Logger

// The server's copy of the query engine. Unlike the SQLite layer db it replaced, the artifact is just bytes: it loads
// straight into wasm memory, so there is no decompress-to-disk step, no file handle, and no schema.

export let hash!: string
export let layersVersion!: string
/// resolves once the artifact is loaded and its etag known. `hash` and the engine are only available after this settles.
export let ready!: Promise<void>
let loadPath!: string
let compressedPath: string | undefined
let servePath!: string
let engine: LayerEngine | undefined

export function setup(): Promise<void> {
	log = module.getLogger()
	const pair = LayerArtifacts.resolvePair()
	loadPath = pair.tableLoadPath
	compressedPath = pair.tableCompressedPath
	layersVersion = pair.version
	ready = load()
	return ready
}

export async function getEngine(): Promise<LayerEngine> {
	await ready
	return engine!
}

// Called once, from setup. A load holds the artifact more than once over on the way into wasm memory, costing
// 110-125MB of RSS while it runs, so the engine is held rather than dropped and reloaded. See "The layer engine" in
// docs/architecture.md.
async function load(): Promise<void> {
	const fileBytes = await fs.promises.readFile(loadPath)

	// create() only reads `artifact` to copy it into wasm memory, and a Buffer is already a Uint8Array: wrapping it in
	// `new Uint8Array(...)` copies all 62MB a second time for nothing.
	const artifact = loadPath.endsWith('.gz') ? await gunzip(fileBytes) : fileBytes
	const wasm = await fs.promises.readFile(path.join(Paths.ASSETS, 'layer-engine.wasm'))
	engine = await LayerEngine.create(wasm, artifact)
	log.info('Loaded the layer engine from %s: %s layers', loadPath, engine.rowCount)

	servePath = compressedPath ?? (await compressForServing(artifact))
	// the etag has to describe the file clients actually download, which is rarely the one loaded above
	hash = servePath === loadPath ? crypto.createHash('sha256').update(fileBytes).digest('hex') : await hashFile(servePath)
}

// streamed rather than read whole: a load already holds the artifact several times over, and this runs right after it
async function hashFile(filePath: string): Promise<string> {
	const hasher = crypto.createHash('sha256')
	for await (const chunk of fs.createReadStream(filePath)) hasher.update(chunk as Buffer)
	return hasher.digest('hex')
}

// Clients are only ever served gzip, so a deployment whose artifact directory holds only an uncompressed table needs
// one made. It goes to the temp dir rather than next to the table: the artifact directories are searched for pairs on
// boot, and a table written into one without its layer-data beside it is a hard error the next time round.
async function compressForServing(artifact: Buffer): Promise<string> {
	const out = path.join(os.tmpdir(), `slm-layers_v${layersVersion}${LA.ARTIFACT_EXT}.gz`)
	const started = performance.now()
	const compressed = await gzip(artifact)
	// written under a unique name and renamed into place, so instances sharing a temp dir cannot read a partial file
	const staging = `${out}.${process.pid}.tmp`
	await fs.promises.writeFile(staging, compressed)
	await fs.promises.rename(staging, out)
	log.info('Compressed the layer table for serving in %sms: %s', (performance.now() - started).toFixed(0), out)
	return out
}

// The compression is described by Content-Type rather than Content-Encoding because the client inflates it by hand:
// what it stores in OPFS is the decompressed artifact, so it wants the encoded bytes rather than a body the browser
// has already decoded. See fetchLayerArtifact in layer-queries.worker.ts.
export function servedArtifact(): { path: string; contentType: string } {
	if (!fs.existsSync(servePath)) throw new Error('File does not exist: ' + servePath)
	return { path: servePath, contentType: 'application/gzip' }
}
