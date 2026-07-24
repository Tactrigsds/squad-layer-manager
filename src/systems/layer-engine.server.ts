import * as Paths from '$root/paths'
import type * as CS from '@/models/context-shared'
import { initModule } from '@/server/logger'
import * as LayerArtifacts from '@/systems/layer-artifacts.server'
import { LayerEngine } from '@/systems/layer-engine.shared'
import crypto from 'crypto'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const module = initModule('layer-engine')
let log!: CS.Logger

// The server's copy of the query engine. Unlike the SQLite layer db it replaced, the artifact is just bytes: it loads
// straight into wasm memory, so there is no decompress-to-disk step, no file handle, and no schema.

export let hash!: string
export let layersVersion!: string
/// resolves once the artifact's etag is known. `hash` is only populated after this settles.
export let ready!: Promise<void>
let artifactPath!: string
let engine: LayerEngine | undefined

export function setup(): Promise<void> {
	log = module.getLogger()
	const pair = LayerArtifacts.resolvePair()
	artifactPath = pair.tablePath
	layersVersion = pair.version
	ready = hashArtifact()
	return ready
}

async function hashArtifact() {
	// the artifact is served to clients as it sits on disk, so the etag hashes the on-disk bytes. Kept off the
	// engine load so serving `/layers.bin` -- which every client does on page load -- never pulls the 62MB in.
	const fileBytes = await fs.promises.readFile(artifactPath)
	hash = crypto.createHash('sha256').update(fileBytes).digest('hex')
}

// Decompressing the artifact into wasm memory costs ~190ms and ~64MB resident for the life of the process, and most
// of what the server does with layers (serving the artifact, resolving ids, reading settings) needs none of it. So
// the first actual query pays for it. See "The layer engine" in docs/architecture.md.
//
// Synchronous on purpose: the first query can arrive from inside a db transaction (queue autogen during a roll), and
// yielding to the event loop there trips runTransaction's guard. One ~190ms stall per process, in place of the same
// work on every boot.
export function getEngine(): LayerEngine {
	engine ??= load()
	return engine
}

function load(): LayerEngine {
	const fileBytes = fs.readFileSync(artifactPath)
	const artifact = artifactPath.endsWith('.gz') ? zlib.gunzipSync(fileBytes) : fileBytes

	const wasm = fs.readFileSync(path.join(Paths.ASSETS, 'layer-engine.wasm'))
	const loaded = LayerEngine.createSync(wasm, new Uint8Array(artifact))
	log.info('Loaded the layer engine from %s: %s layers', artifactPath, loaded.rowCount)
	return loaded
}

export function readFilestream(): [fs.ReadStream, string] {
	if (!fs.existsSync(artifactPath)) throw new Error('File does not exist: ' + artifactPath)
	const contentType = artifactPath.endsWith('.gz') ? 'application/gzip' : 'application/octet-stream'
	return [fs.createReadStream(artifactPath), contentType]
}
