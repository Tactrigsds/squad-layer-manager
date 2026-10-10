import engineWasmUrl from '$root/assets/layer-engine.wasm?url'
import * as AR from '@/app-routes'
import { TaskScheduler } from '@/lib/task-scheduler'
import * as CS from '@/models/context-shared'
import type * as F from '@/models/filter.models'
import * as L from '@/models/layer'
import * as LC from '@/models/layer-columns'
import type * as LE from '@/models/layer-engine'
import type * as LQY from '@/models/layer-queries.models'
import type * as LOG from '@/models/logs'
import * as ATTRS from '@/models/otel-attrs'
import { LayerEngine } from '@/systems/layer-engine.shared'
import { queries, type QueryLayersResponsePart, queryLayersStreamed } from '@/systems/layer-queries.shared'
import * as LoggerClient from '@/systems/logger.client'

export type ToWorker = (RequestInner & Sequenced & Prioritized) | CancelRequest | DisconnectRequest

export type FromWorker = ((ResponseInner | { type: 'worker-error'; error: string }) & Sequenced) | SignalLoadingLayersStarted | WorkerLog

export type RequestInner = OtherQueryRequest | QueryLayersRequest | InitRequest | FilterUpdateRequest | GenerationUpdateRequest
export type ResponseInner = OtherQueryResponse | QueryLayersResponse | InitResponse | FilterUpdateResponse | GenerationUpdateResponse

export type OtherQueries = typeof queries
export type OtherQueryType = keyof OtherQueries

export type BackgroundQueryState = { filters: Map<F.FilterEntityId, F.FilterEntity> }

type OtherQueryRequests = { [k in OtherQueryType]: { type: k; input: Parameters<OtherQueries[k]>[0]['input'] } }
export type OtherQueryRequest = OtherQueryRequests[OtherQueryType]

type OtherQueryResponses = {
	[k in OtherQueryType]: { type: k; payload: Awaited<ReturnType<OtherQueries[k]>> | { code: 'err:missing-item-states' } }
}
export type OtherQueryResponse = OtherQueryResponses[OtherQueryType]

export type QueryLayersRequest = {
	type: 'queryLayers'
	input: LQY.LayersQueryInput
}

export type QueryLayersResponse = {
	type: 'queryLayers'
	payload: QueryLayersResponsePart | { code: 'end' } | { code: 'err:missing-item-states' }
}

// no worker code reads factionUnits, which is 7.2MB of the 12.9MB layer data and most of the cost of cloning it
export type WorkerLayerData = Omit<L.LayerData, 'factionUnits'>

export type InitRequest = {
	type: 'init'
	input: LC.Ctx.Generation &
		BackgroundQueryState & {
			// the worker doesn't share module state with the main thread, so the page passes its layer data along rather
			// than having it fetched a second time. Null asks whether the worker already holds the data under
			// layerDataHash, and the worker answers need-layer-data when it does not.
			layerData: WorkerLayerData | null
			// the content hash of that layer data (see layer-data.client.ts), or null where the page could not learn it
			layerDataHash: string | null
			// the layer data the server runs on, from the config stream. Not taken from a header on the artifact: a CDN
			// can cache the artifact and keep serving the header it was first sent with, after a deploy changed it
			serverLayerDataHash: string
			cacheLayerArtifact: boolean
		}
}

export type InitResponse = {
	type: 'init'
	// stale: the page loaded a layer-data.json the server no longer serves, so its layer data cannot be run against
	// the artifact the server does. Nothing about the worker changes; the page reloads.
	payload: { code: 'ok' } | { code: 'err:stale-layer-data' } | { code: 'need-layer-data' }
}

export type FilterUpdateRequest = {
	type: 'filter-update'
	input: Map<string, F.FilterEntity>
}

export type FilterUpdateResponse = {
	type: 'filter-update'
	payload?: undefined
}

// generation weights are admin-editable at runtime, so the worker's copy has to be refreshed rather than
// baked in at init
export type GenerationUpdateRequest = {
	type: 'generation-update'
	input: LC.LayerGenerationConfig
}

export type GenerationUpdateResponse = {
	type: 'generation-update'
	payload?: undefined
}

// drops the request with this seqId from the queue, or stops a running queryLayers stream before its next packet
export type CancelRequest = {
	type: 'cancel'
} & Sequenced

// sent by a tab as it unloads: the shared worker drops its port and every request it still has queued
export type DisconnectRequest = {
	type: 'disconnect'
}

export type SignalLoadingLayersStarted = {
	type: 'layer-download-started'
}

export type WorkerLog = {
	type: 'worker-log'
	payload: LOG.LogEvent
}

export type Sequenced = {
	seqId: number
}
export type Prioritized = {
	// lower runs first
	priority: number
}

type State = {
	ctx: LE.Ctx & CS.Log & LC.Ctx.Generation
	filters: Map<string, F.FilterEntity>
	// what the engine and L's layer data were built from, so a later init can tell whether it is asking for the same
	layerDataHash: string | null
	artifactHash: string | null
}

let state: State | undefined

const isShared = 'onconnect' in self
const ports = new Set<MessagePort>()
function broadcast(msg: SignalLoadingLayersStarted | WorkerLog) {
	if (!isShared) return postMessage(msg)
	for (const port of ports) port.postMessage(msg)
}

const log = LoggerClient.createLogger((event) => broadcast({ type: 'worker-log', payload: event })).child({
	[ATTRS.Module.NAME]: 'layer-queries.worker',
})

// One scheduler serves every tab connected to the shared worker. State changes are barriers, so every query runs
// against the filters and generation weights that were current when it was sent.
const scheduler = new TaskScheduler((error, task) => log.error(error, 'layer query worker task %s failed', task.id))

function isBarrier(type: RequestInner['type']) {
	return type === 'init' || type === 'filter-update' || type === 'generation-update'
}

function makeMessageHandler(portId: number, reply: (msg: FromWorker) => void, release: () => void) {
	return (e: MessageEvent<ToWorker>) => {
		const msg = e.data
		if (msg.type === 'disconnect') {
			release()
			return
		}
		const taskId = `${portId}:${msg.seqId}`
		if (msg.type === 'cancel') {
			scheduler.cancel(taskId)
			return
		}
		scheduler.enqueue({
			id: taskId,
			priority: msg.priority,
			barrier: isBarrier(msg.type),
			run: (signal) => handleRequest(msg, signal, reply),
		})
	}
}

async function handleRequest(msg: RequestInner & Sequenced, signal: AbortSignal, reply: (msg: FromWorker) => void) {
	function post(response: ResponseInner) {
		reply({ ...response, seqId: msg.seqId } as FromWorker)
	}
	try {
		if (msg.type === 'init') {
			const result = await init(msg.input, state)
			if (result.code === 'ok') state = result.state
			post({ type: 'init', payload: { code: result.code } })
			return
		}
		if (!state) throw new Error(`received ${msg.type} before init`)
		if (msg.type === 'filter-update') {
			state.filters = msg.input
			post({ type: 'filter-update' })
			return
		}
		if (msg.type === 'generation-update') {
			state.ctx = { ...state.ctx, generationConfig: msg.input }
			post({ type: 'generation-update' })
			return
		}

		const queryCtx = {
			...state.ctx,
			filters: state.filters,
		}
		if (msg.type === 'queryLayers') {
			for await (const packet of queryLayersStreamed({ ctx: queryCtx, input: msg.input })) {
				post({ type: 'queryLayers', payload: packet })
				// the engine runs synchronously, so a cancel can only be read between packets
				await yieldToEventLoop()
				if (signal.aborted) return
			}
			post({ type: 'queryLayers', payload: { code: 'end' } })
			return
		}
		const payload = await queries[msg.type]({ ctx: queryCtx, input: msg.input as any })
		post({ type: msg.type, payload } as OtherQueryResponse)
	} catch (error) {
		log.error(error, 'layer query worker request failed')
		const errorMessage = error instanceof Error ? error.message : String(error)
		reply({ type: 'worker-error', error: errorMessage, seqId: msg.seqId })
	}
}

function yieldToEventLoop() {
	return new Promise<void>((resolve) => setTimeout(resolve, 0))
}

// In a shared worker every tab sends init, and the worker outlives any one of them: a tab that connects after an
// upgrade, or after a new layer pool was dropped in, finds a worker built for the old one. So an init is only an
// ack when it names the layer data the worker already runs on and the server still serves the artifact the engine
// holds; otherwise the state is rebuilt from what this tab sent. The artifact check is a conditional request, so
// the common case costs a 304.
async function init(
	input: InitRequest['input'],
	prev: State | undefined,
): Promise<{ code: 'ok'; state: State } | { code: 'err:stale-layer-data' } | { code: 'need-layer-data' }> {
	const holdsLayerData = !!prev && input.layerDataHash !== null && prev.layerDataHash === input.layerDataHash
	if (!input.layerData && !holdsLayerData) return { code: 'need-layer-data' }

	// the artifact and the layer data are halves of one pair, and the page fetched its half separately. A page that
	// loaded layer data the server has since replaced cannot be served by any engine; it has to reload.
	if (input.layerDataHash && input.layerDataHash !== input.serverLayerDataHash) {
		log.warn('page is on layer data %s but the server serves %s', input.layerDataHash, input.serverLayerDataHash)
		return { code: 'err:stale-layer-data' }
	}

	const artifact = await takeLayerArtifact(prev?.artifactHash ?? null)

	if (holdsLayerData && artifact.code === 'unchanged') return { code: 'ok', state: prev! }

	let engine: LE.EngineHandle
	let artifactHash: string | null
	if (artifact.code === 'unchanged') {
		engine = prev!.ctx.engine
		artifactHash = prev!.artifactHash
	} else {
		if (input.cacheLayerArtifact && !artifact.fromCache) await cacheArtifact(artifact)
		;[engine, artifactHash] = await createEngine(artifact)
	}

	if (input.layerData) L.setLayerData(input.layerData)
	log.info('layer engine ready: %s layers%s', engine.rowCount, prev ? ' (rebuilt for a new layer pool)' : '')

	return {
		code: 'ok',
		state: {
			ctx: {
				...CS.init(),
				effectiveColsConfig: LC.getEffectiveColumnConfig(),
				generationConfig: input.generationConfig,
				log,
				engine,
			},
			filters: input.filters,
			layerDataHash: input.layerDataHash,
			artifactHash,
		},
	}
}

let downloadsInFlight = 0

// the same entry runs as a shared worker, or as a dedicated worker where SharedWorker is unavailable
if (isShared) {
	let nextPortId = 0
	;(self as unknown as { onconnect: (e: MessageEvent) => void }).onconnect = (e) => {
		const port = e.ports[0]
		const portId = nextPortId++
		ports.add(port)
		// The worker outlives the tabs that connect to it, so a closed tab's port would otherwise be broadcast to for as
		// long as any tab stays open, and its queued queries would still run. Chromium fires `close` on the port. In every
		// browser the tab also sends `disconnect` as it unloads.
		const release = () => {
			if (!ports.delete(port)) return
			port.close()
			const prefix = `${portId}:`
			scheduler.cancelWhere((id) => id.startsWith(prefix))
		}
		port.addEventListener('close', release)
		// assigning onmessage starts the port implicitly
		port.onmessage = makeMessageHandler(portId, (msg) => port.postMessage(msg), release)
		if (downloadsInFlight > 0) port.postMessage({ type: 'layer-download-started' } satisfies SignalLoadingLayersStarted)
	}
} else {
	onmessage = makeMessageHandler(
		0,
		(msg) => postMessage(msg),
		() => {},
	)
}

// Both downloads start when the worker loads rather than when the first init arrives, which waits on the page's
// config, filters and layer data. A worker loads with no state, so the prefetch has no artifact to revalidate.
const engineModule = compileEngine()
let artifactPrefetch: Promise<ArtifactResult> | null = fetchLayerArtifact(null)
// observed here so a failure surfaces through init rather than as an unhandled rejection
engineModule.catch(() => {})
artifactPrefetch.catch(() => {})

async function compileEngine() {
	try {
		return await WebAssembly.compileStreaming(fetch(engineWasmUrl))
	} catch (error) {
		// compileStreaming rejects a response that is not served as application/wasm
		log.warn(error, 'streaming compile of the layer engine failed, compiling from a buffer')
		const res = await fetch(engineWasmUrl)
		return await WebAssembly.compile(await res.arrayBuffer())
	}
}

function takeLayerArtifact(knownHash: string | null): Promise<ArtifactResult> {
	const prefetch = artifactPrefetch
	artifactPrefetch = null
	if (!prefetch || knownHash !== null) return fetchLayerArtifact(knownHash)
	return prefetch.catch((error) => {
		log.warn(error, 'layer artifact prefetch failed, fetching again')
		return fetchLayerArtifact(null)
	})
}

async function createEngine(artifact: FetchedArtifact): Promise<[LayerEngine, string | null]> {
	const module = await engineModule
	try {
		return [await LayerEngine.create(module, new Uint8Array(artifact.buffer)), artifact.hash]
	} catch (error) {
		// a cached copy the engine rejects is worse than none: with it in place every page load would come back to it
		if (!artifact.fromCache) throw error
		log.warn(error, 'discarding the cached layer artifact, the engine rejected it')
		await discardCachedArtifacts()
		const fresh = await fetchLayerArtifactDirect(null)
		if (fresh.code === 'unchanged') throw new Error('unconditional artifact request answered 304', { cause: error })
		return [await LayerEngine.create(module, new Uint8Array(fresh.buffer)), fresh.hash]
	}
}

type FetchedArtifact = {
	code: 'fetched'
	buffer: ArrayBuffer
	hash: string | null
	fromCache: boolean
}
type ArtifactResult = FetchedArtifact | { code: 'unchanged' }

// `knownHash` is the artifact the caller already holds, whose validity is all it needs to know. A copy in OPFS is read
// whether or not this deployment caches the artifact: cacheLayerArtifact (see config.server.ts) only decides whether
// a fresh download is written there.
async function fetchLayerArtifact(knownHash: string | null): Promise<ArtifactResult> {
	let cached: Awaited<ReturnType<typeof findCachedArtifact>> = null
	try {
		cached = await findCachedArtifact(await navigator.storage.getDirectory())
	} catch (error) {
		// OPFS handles are lock-contended across contexts (e.g. an older worker instance mid-write); the cache is
		// optional, the artifact is not
		log.warn(error, 'layer artifact OPFS cache unavailable, fetching directly')
	}

	const res = await requestArtifact(knownHash ?? cached?.hash ?? null)
	if (res.status === 304) {
		if (knownHash) return { code: 'unchanged' }
		try {
			const file = await cached!.handle.getFile()
			return { code: 'fetched', buffer: await file.arrayBuffer(), hash: cached!.hash, fromCache: true }
		} catch (error) {
			log.warn(error, 'failed to read the cached layer artifact, fetching directly')
			return await fetchLayerArtifactDirect(null)
		}
	}

	const hash = AR.parseContentHashEtag(res.headers.get('ETag'))
	return { code: 'fetched', buffer: await inflateArtifact(res), hash, fromCache: false }
}

async function fetchLayerArtifactDirect(knownHash: string | null): Promise<ArtifactResult> {
	const res = await requestArtifact(knownHash)
	if (res.status === 304) return { code: 'unchanged' }
	const hash = AR.parseContentHashEtag(res.headers.get('ETag'))
	return { code: 'fetched', buffer: await inflateArtifact(res), hash, fromCache: false }
}

async function requestArtifact(knownHash: string | null) {
	const headers = knownHash ? { 'If-None-Match': `"${knownHash}"` } : undefined
	const res = await fetch(AR.link('/layers.bin.gz'), { headers })
	if (res.status === 304 && !knownHash) throw new Error('unconditional artifact request answered 304')
	if (res.status !== 304 && !res.ok) throw new Error(`layer artifact request failed: ${res.status} ${res.statusText}`)
	return res
}

// The cache is one file in the OPFS root named by the artifact's hash, `layers-<sha256>.bin`, so a copy can only
// ever be read back under the hash of its own bytes. The earlier layouts kept the hash in a second file beside the
// artifact, which two writers could leave disagreeing, and a stale artifact under a current hash is served on
// every page load until the server's artifact changes again. Anything else under the prefix is one of those
// earlier layouts (layers.sqlite3, layers.bin, and their .hash files) and is swept.
const CACHE_ENTRY_PREFIX = 'layers'
const CACHE_ENTRY_REGEX = /^layers-([0-9a-f]{64})\.bin$/
function cacheEntryName(hash: string) {
	return `layers-${hash}.bin`
}

async function findCachedArtifact(root: FileSystemDirectoryHandle) {
	for await (const name of root.keys()) {
		const match = name.match(CACHE_ENTRY_REGEX)
		if (!match) continue
		const handle = await root.getFileHandle(name)
		// getFileHandle({ create: true }) leaves an empty entry until the write that fills it closes, and a write that
		// never closed leaves it that way
		if ((await handle.getFile()).size === 0) continue
		return { handle, hash: match[1] }
	}
	return null
}

async function cacheArtifact(artifact: FetchedArtifact) {
	try {
		const root = await navigator.storage.getDirectory()
		if (artifact.hash) {
			const handle = await root.getFileHandle(cacheEntryName(artifact.hash), { create: true })
			const writable = await handle.createWritable()
			await writable.write(artifact.buffer)
			await writable.close()
		}
		await sweepCache(root, artifact.hash ? cacheEntryName(artifact.hash) : null)
	} catch (error) {
		log.warn(error, 'failed to cache the layer artifact in OPFS')
	}
}

async function discardCachedArtifacts() {
	try {
		await sweepCache(await navigator.storage.getDirectory(), null)
	} catch (error) {
		log.warn(error, 'failed to discard the cached layer artifact')
	}
}

async function sweepCache(root: FileSystemDirectoryHandle, keep: string | null) {
	for await (const name of root.keys()) {
		if (name === keep || !name.startsWith(CACHE_ENTRY_PREFIX)) continue
		await root.removeEntry(name)
	}
}

// the endpoint serves the pre-gzipped file as opaque bytes rather than a Content-Encoding (see the
// /layers.bin.gz route for why), so the browser does not decode the body and inflating falls to us
async function inflateArtifact(res: Response) {
	downloadsInFlight++
	try {
		broadcast({ type: 'layer-download-started' })
		if (!res.body) throw new Error('No body on the layer artifact response')
		return await new Response(res.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer()
	} finally {
		downloadsInFlight--
	}
}
