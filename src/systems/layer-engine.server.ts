import crypto from 'crypto'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import zlib from 'node:zlib'

import * as Paths from '$root/paths'
import type * as CS from '@/models/context-shared'
import { initModule } from '@/server/logger'
import * as LayerArtifacts from '@/systems/layer-artifacts.server'
import { LayerEngine } from '@/systems/layer-engine.shared'

const gunzip = promisify(zlib.gunzip)
const module = initModule('layer-engine')
let log!: CS.Logger

// The server's copy of the query engine. Unlike the SQLite layer db it replaced, the artifact is just bytes: it loads
// straight into wasm memory, so there is no decompress-to-disk step, no file handle, and no schema.

export let hash!: string
export let layersVersion!: string
/// resolves once the artifact is loaded and its etag known. `hash` and the engine are only available after this settles.
export let ready!: Promise<void>
let artifactPath!: string
let engine: LayerEngine | undefined

export function setup(): Promise<void> {
	log = module.getLogger()
	const pair = LayerArtifacts.resolvePair()
	artifactPath = pair.tablePath
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
	// the artifact is served to clients as it sits on disk, so the etag hashes the on-disk bytes rather than anything
	// the engine derives from them
	const fileBytes = await fs.promises.readFile(artifactPath)
	hash = crypto.createHash('sha256').update(fileBytes).digest('hex')

	// create() only reads `artifact` to copy it into wasm memory, and a Buffer is already a Uint8Array: wrapping it in
	// `new Uint8Array(...)` copies all 62MB a second time for nothing.
	const artifact = artifactPath.endsWith('.gz') ? await gunzip(fileBytes) : fileBytes
	const wasm = await fs.promises.readFile(path.join(Paths.ASSETS, 'layer-engine.wasm'))
	engine = await LayerEngine.create(wasm, artifact)
	log.info('Loaded the layer engine from %s: %s layers', artifactPath, engine.rowCount)
}

export function readFilestream(): [fs.ReadStream, string] {
	if (!fs.existsSync(artifactPath)) throw new Error('File does not exist: ' + artifactPath)
	const contentType = artifactPath.endsWith('.gz') ? 'application/gzip' : 'application/octet-stream'
	return [fs.createReadStream(artifactPath), contentType]
}
