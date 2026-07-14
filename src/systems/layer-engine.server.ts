import * as Paths from '$root/paths'
import type * as CS from '@/models/context-shared'
import { initModule } from '@/server/logger'
import * as LayerArtifacts from '@/systems/layer-artifacts.server'
import { LayerEngine } from '@/systems/layer-engine.shared'
import crypto from 'crypto'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import zlib from 'node:zlib'

const gunzip = promisify(zlib.gunzip)
const module = initModule('layer-engine')
let log!: CS.Logger

// The server's copy of the query engine. Unlike the SQLite layer db it replaced, the artifact is just bytes: it loads
// straight into wasm memory, so there is no decompress-to-disk step, no file handle, and no schema.

export let engine!: LayerEngine
export let hash!: string
export let layersVersion!: string
/// resolves once the artifact is loaded. `engine` and `hash` are only populated after this settles.
export let ready!: Promise<void>
let artifactPath!: string

export function setup(): Promise<void> {
	log = module.getLogger()
	const pair = LayerArtifacts.resolvePair()
	artifactPath = pair.tablePath
	layersVersion = pair.version
	ready = load()
	return ready
}

async function load() {
	const fileBytes = await fs.promises.readFile(artifactPath)
	// the artifact is served to clients as it sits on disk, so the etag hashes the on-disk bytes
	hash = crypto.createHash('sha256').update(fileBytes).digest('hex')
	const artifact = artifactPath.endsWith('.gz') ? await gunzip(fileBytes) : fileBytes

	const wasm = await fs.promises.readFile(path.join(Paths.ASSETS, 'layer-engine.wasm'))
	engine = await LayerEngine.create(wasm, new Uint8Array(artifact))
	log.info('Loaded the layer engine from %s: %s layers', artifactPath, engine.rowCount)
}

export function readFilestream(): [fs.ReadStream, string] {
	if (!fs.existsSync(artifactPath)) throw new Error('File does not exist: ' + artifactPath)
	const contentType = artifactPath.endsWith('.gz') ? 'application/gzip' : 'application/octet-stream'
	return [fs.createReadStream(artifactPath), contentType]
}
