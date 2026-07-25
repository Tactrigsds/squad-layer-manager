import crypto from 'crypto'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import v8 from 'node:v8'
import vm from 'node:vm'
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
/// resolves once the artifact's etag is known. `hash` is only populated after this settles.
export let ready!: Promise<void>
let artifactPath!: string
// strong for as long as the engine is in use, so a burst of queries shares one load
let held: LayerEngine | undefined
// outlives `held`, so a caller still holding the engine on its ctx when the timer fires gets that same engine back
// rather than a second 64MB copy of it
let engineRef: WeakRef<LayerEngine> | undefined
let releaseTimer: NodeJS.Timeout | undefined
let loading: Promise<LayerEngine> | undefined
let loadedOnce = false

// `gc()` without launching node under --expose-gc. Exposed into a throwaway context and immediately unset, so
// nothing is added to this process's globals.
const forceGc = (() => {
	try {
		v8.setFlagsFromString('--expose_gc')
		return vm.runInNewContext('gc') as () => void
	} catch {
		return undefined
	} finally {
		v8.setFlagsFromString('--no-expose_gc')
	}
})()

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

// Decompressing the artifact into wasm memory costs ~120ms and ~64MB resident, and most of what the server does with
// layers (serving the artifact, resolving ids, reading settings) needs none of it. So a query loads it, and going
// this long without one drops it again. See "The layer engine" in docs/architecture.md.
export const IDLE_RELEASE_MS = 30_000

export async function getEngine(): Promise<LayerEngine> {
	const resident = held ?? engineRef?.deref()
	if (resident) return keep(resident)
	// shared so concurrent callers arriving during a load do not each decompress their own copy
	loading ??= load().finally(() => {
		loading = undefined
	})
	return keep(await loading)
}

function keep(engine: LayerEngine): LayerEngine {
	held = engine
	engineRef = new WeakRef(engine)
	if (releaseTimer) clearTimeout(releaseTimer)
	// unref'd: an idle engine is not a reason to keep the process alive
	releaseTimer = setTimeout(release, IDLE_RELEASE_MS).unref()
	return engine
}

function release() {
	releaseTimer = undefined
	held = undefined
	// Dropping the reference reclaims nothing on its own. Wasm linear memory is external to the JS heap, so it barely
	// moves V8's heap-limit heuristics, and ordinary request churn is absorbed by scavenges: measured, the engine
	// survived 20s of both idling and steady allocation with only a WeakRef holding it. A major GC is what frees it,
	// and this asks for one -- ~15ms against the ~60MB it returns.
	forceGc?.()
	log.debug('released the layer engine after %dms idle', IDLE_RELEASE_MS)
}

async function load(): Promise<LayerEngine> {
	const fileBytes = await fs.promises.readFile(artifactPath)
	const artifact = artifactPath.endsWith('.gz') ? await gunzip(fileBytes) : fileBytes

	const wasm = await fs.promises.readFile(path.join(Paths.ASSETS, 'layer-engine.wasm'))
	const loaded = await LayerEngine.create(wasm, new Uint8Array(artifact))
	// reloads are routine and would otherwise put a line in the log every few minutes
	if (loadedOnce) log.debug('reloaded the layer engine: %s layers', loaded.rowCount)
	else log.info('Loaded the layer engine from %s: %s layers', artifactPath, loaded.rowCount)
	loadedOnce = true
	return loaded
}

export function readFilestream(): [fs.ReadStream, string] {
	if (!fs.existsSync(artifactPath)) throw new Error('File does not exist: ' + artifactPath)
	const contentType = artifactPath.endsWith('.gz') ? 'application/gzip' : 'application/octet-stream'
	return [fs.createReadStream(artifactPath), contentType]
}
