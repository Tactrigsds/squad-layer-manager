import { Mutex } from 'async-mutex'

import engineWasmUrl from '$root/assets/layer-engine.wasm?url'
import * as AR from '@/app-routes'
import * as Prom from '@/lib/promise-utils'
import * as CS from '@/models/context-shared'
import type * as F from '@/models/filter.models'
import * as L from '@/models/layer'
import * as LC from '@/models/layer-columns'
import type * as LE from '@/models/layer-engine'
import type * as LQY from '@/models/layer-queries.models'
import type * as LOGS from '@/models/logs'
import * as ATTRS from '@/models/otel-attrs'
import { LayerEngine } from '@/systems/layer-engine.shared'
import { queries, type QueryLayersResponsePart, queryLayersStreamed } from '@/systems/layer-queries.shared'
import * as LoggerClient from '@/systems/logger.client'
// must match the loader variant the bundler resolves for 'sql.js' (browser export condition)

export type ToWorker = RequestInner & Sequenced & Prioritized

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

export type InitRequest = {
	type: 'init'
	// the worker doesn't share module state with the main thread, so layer data is passed along
	// rather than fetched a second time. the column config is derived from it here.
	input: LC.Ctx.Generation &
		BackgroundQueryState & {
			layerData: L.LayerData
			// the content hash of that layer data (see layer-data.client.ts), or null where the page could not learn it
			layerDataHash: string | null
			cacheLayerArtifact: boolean
		}
}

export type InitResponse = {
	type: 'init'
	// stale: the page loaded a layer-data.json the server no longer serves, so its layer data cannot be run against
	// the artifact the server does. Nothing about the worker changes; the page reloads.
	payload: { code: 'ok' } | { code: 'err:stale-layer-data' }
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

export type SignalLoadingLayersStarted = {
	type: 'layer-download-started'
}

export type WorkerLog = {
	type: 'worker-log'
	payload: LOGS.LogEvent
}

export type Sequenced = {
	seqId: number
}
export type Prioritized = {
	priority: number
}

type State = {
	ctx: LE.Ctx & CS.Log & LC.Ctx.Generation
	filters: Map<string, F.FilterEntity>
	// what the engine and L's layer data were built from, so a later init can tell whether it is asking for the same
	layerDataHash: string | null
	artifactHash: string | null
}

const mutex = new Mutex()
let state: State | undefined

// empty in a dedicated worker, where broadcasts fall back to the global postMessage
const ports = new Set<MessagePort>()
function broadcast(msg: SignalLoadingLayersStarted | WorkerLog) {
	if (ports.size === 0) return postMessage(msg)
	for (const port of ports) port.postMessage(msg)
}

const log = LoggerClient.createLogger((event) => broadcast({ type: 'worker-log', payload: event })).child({
	[ATTRS.Module.NAME]: 'layer-queries.worker',
})

function makeMessageHandler(reply: (msg: unknown) => void) {
	return withErrorResponse(reply, async (e) => {
		using _lock = await Prom.acquireInBlock(mutex)

		const msg = e.data as RequestInner & Sequenced & Prioritized
		function post(response: ResponseInner) {
			reply({ ...response, seqId: msg.seqId })
		}
		if (msg.type === 'init') {
			const result = await init(msg, state)
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
			}
			post({ type: 'queryLayers', payload: { code: 'end' } })
			return
		}
		const payload = await queries[msg.type]({ ctx: queryCtx, input: msg.input as any })
		post({ type: msg.type, payload } as unknown as OtherQueryResponse)
	})
}

// the same entry runs as a shared worker, or as a dedicated worker where SharedWorker is unavailable
if ('onconnect' in self) {
	;(self as { onconnect: (e: MessageEvent) => void }).onconnect = (e) => {
		const port = e.ports[0]
		ports.add(port)
		// assigning onmessage starts the port implicitly
		port.onmessage = makeMessageHandler((msg) => port.postMessage(msg))
	}
} else {
	onmessage = makeMessageHandler((msg) => postMessage(msg))
}

// In a shared worker every tab sends init, and the worker outlives any one of them: a tab that connects after an
// upgrade, or after a new layer pool was dropped in, finds a worker built for the old one. So an init is only an
// ack when it names the layer data the worker already runs on and the server still serves the artifact the engine
// holds; otherwise the state is rebuilt from what this tab sent. The artifact check is a conditional request, so
// the common case costs a 304.
async function init(
	initRequest: InitRequest,
	prev: State | undefined,
): Promise<{ code: 'ok'; state: State } | { code: 'err:stale-layer-data' }> {
	const input = initRequest.input
	const artifact = await fetchLayerArtifact(input.cacheLayerArtifact, prev?.artifactHash ?? null)

	// the artifact and the layer data are halves of one pair, and the page fetched its half separately. A page that
	// loaded layer data the server has since replaced cannot be served by any engine; it has to reload.
	if (artifact.layerDataHash && input.layerDataHash && artifact.layerDataHash !== input.layerDataHash) {
		log.warn('page is on layer data %s but the server serves %s', input.layerDataHash, artifact.layerDataHash)
		return { code: 'err:stale-layer-data' }
	}

	if (prev && artifact.code === 'unchanged' && input.layerDataHash !== null && prev.layerDataHash === input.layerDataHash) {
		return { code: 'ok', state: prev }
	}

	let engine: LE.EngineHandle
	let artifactHash: string | null
	if (artifact.code === 'unchanged') {
		engine = prev!.ctx.engine
		artifactHash = prev!.artifactHash
	} else {
		;[engine, artifactHash] = await createEngine(artifact)
	}

	L.setLayerData(input.layerData)
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

function withErrorResponse<Msg extends { type: string } & Sequenced>(
	reply: (msg: unknown) => void,
	cb: (e: { data: Msg }) => Promise<void>,
) {
	return async (e: { data: Msg }) => {
		try {
			return await cb(e)
		} catch (error) {
			log.error(error, 'layer query worker request failed')
			const errorMessage = error instanceof Error ? error.message : String(error)
			reply({ type: 'worker-error', error: errorMessage, seqId: e.data.seqId })
		}
	}
}

let wasm: Promise<ArrayBuffer> | undefined
async function createEngine(artifact: FetchedArtifact): Promise<[LayerEngine, string | null]> {
	wasm ??= fetch(engineWasmUrl).then((res) => res.arrayBuffer())
	try {
		return [await LayerEngine.create(await wasm, new Uint8Array(artifact.buffer)), artifact.hash]
	} catch (error) {
		// a cached copy the engine rejects is worse than none: with it in place every page load would come back to it
		if (!artifact.fromCache) throw error
		log.warn(error, 'discarding the cached layer artifact, the engine rejected it')
		await discardCachedArtifacts()
		const fresh = await fetchLayerArtifactDirect(null)
		if (fresh.code === 'unchanged') throw new Error('unconditional artifact request answered 304', { cause: error })
		return [await LayerEngine.create(await wasm, new Uint8Array(fresh.buffer)), fresh.hash]
	}
}

type FetchedArtifact = {
	code: 'fetched'
	buffer: ArrayBuffer
	hash: string | null
	fromCache: boolean
	layerDataHash: string | null
}
type ArtifactResult = FetchedArtifact | { code: 'unchanged'; layerDataHash: string | null }

// `knownHash` is the artifact the caller already holds, whose validity is all it needs to know
async function fetchLayerArtifact(cache: boolean, knownHash: string | null): Promise<ArtifactResult> {
	// Nothing will read the copy back (see cacheLayerArtifact in config.server.ts), so skip OPFS entirely rather
	// than write the whole artifact into a directory that is discarded when this profile is.
	if (!cache) return await fetchLayerArtifactDirect(knownHash)

	try {
		return await fetchLayerArtifactViaOpfs(knownHash)
	} catch (error) {
		// OPFS handles are lock-contended across contexts (e.g. an older worker instance mid-write); the cache is
		// optional, the artifact is not
		log.warn(error, 'layer artifact OPFS cache unavailable, fetching directly')
		return await fetchLayerArtifactDirect(knownHash)
	}
}

async function fetchLayerArtifactDirect(knownHash: string | null): Promise<ArtifactResult> {
	const res = await requestArtifact(knownHash)
	const layerDataHash = res.headers.get(AR.LAYER_DATA_HASH_HEADER)
	if (res.status === 304) return { code: 'unchanged', layerDataHash }
	const hash = AR.parseContentHashEtag(res.headers.get('ETag'))
	return { code: 'fetched', buffer: await inflateArtifact(res), hash, fromCache: false, layerDataHash }
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

async function fetchLayerArtifactViaOpfs(knownHash: string | null): Promise<ArtifactResult> {
	const root = await navigator.storage.getDirectory()
	const cached = await findCachedArtifact(root)

	const res = await requestArtifact(knownHash ?? cached?.hash ?? null)
	const layerDataHash = res.headers.get(AR.LAYER_DATA_HASH_HEADER)
	if (res.status === 304) {
		if (knownHash) return { code: 'unchanged', layerDataHash }
		const file = await cached!.handle.getFile()
		return { code: 'fetched', buffer: await file.arrayBuffer(), hash: cached!.hash, fromCache: true, layerDataHash }
	}

	const buffer = await inflateArtifact(res)
	const hash = AR.parseContentHashEtag(res.headers.get('ETag'))
	try {
		await storeArtifact(root, hash, buffer)
	} catch (error) {
		log.warn(error, 'failed to cache the layer artifact in OPFS')
	}
	return { code: 'fetched', buffer, hash, fromCache: false, layerDataHash }
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

async function storeArtifact(root: FileSystemDirectoryHandle, hash: string | null, buffer: ArrayBuffer) {
	if (hash) {
		const handle = await root.getFileHandle(cacheEntryName(hash), { create: true })
		const writable = await handle.createWritable()
		await writable.write(buffer)
		await writable.close()
	}
	await sweepCache(root, hash ? cacheEntryName(hash) : null)
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
	broadcast({ type: 'layer-download-started' })
	if (!res.body) throw new Error('No body on the layer artifact response')
	return await new Response(res.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer()
}
