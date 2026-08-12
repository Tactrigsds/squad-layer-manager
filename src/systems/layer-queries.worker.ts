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
import * as ATTRS from '@/models/otel-attrs'
import { LayerEngine } from '@/systems/layer-engine.shared'
import { queries, type QueryLayersResponsePart, queryLayersStreamed } from '@/systems/layer-queries.shared'
import { baseLogger } from '@/systems/logger.client'
// must match the loader variant the bundler resolves for 'sql.js' (browser export condition)

export type ToWorker = RequestInner & Sequenced & Prioritized

export type FromWorker = (ResponseInner | { type: 'worker-error'; error: string } | SignalLoadingLayersStarted) & Sequenced

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
	input: LC.Ctx.Generation & BackgroundQueryState & { layerData: L.LayerData; cacheLayerArtifact: boolean }
}

export type InitResponse = {
	type: 'init'
	payload?: undefined
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

export type Sequenced = {
	seqId: number
}
export type Prioritized = {
	priority: number
}

type State = {
	ctx: LE.Ctx & CS.Log & LC.Ctx.Generation
	filters: Map<string, F.FilterEntity>
}

const log = baseLogger.child({ [ATTRS.Module.NAME]: 'layer-queries.worker' })

const mutex = new Mutex()
let state: State | undefined

// empty in a dedicated worker, where broadcasts fall back to the global postMessage
const ports = new Set<MessagePort>()
function broadcast(msg: SignalLoadingLayersStarted) {
	if (ports.size === 0) return postMessage(msg)
	for (const port of ports) port.postMessage(msg)
}

function makeMessageHandler(reply: (msg: unknown) => void) {
	return withErrorResponse(reply, async (e) => {
		using _lock = await Prom.acquireInBlock(mutex)

		const msg = e.data as RequestInner & Sequenced & Prioritized
		function post(response: ResponseInner) {
			reply({ ...response, seqId: msg.seqId })
		}
		if (msg.type === 'init') {
			// in a shared worker every tab sends init; the first one wins and the rest are acks
			if (!state) state = await init(msg)
			post({ type: 'init' })
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

async function init(initRequest: InitRequest): Promise<State> {
	L.setLayerData(initRequest.input.layerData)

	const [wasm, artifact] = await Promise.all([
		fetch(engineWasmUrl).then((res) => res.arrayBuffer()),
		fetchLayerArtifact(initRequest.input.cacheLayerArtifact),
	])
	const engine = await LayerEngine.create(wasm, new Uint8Array(artifact))
	log.info('layer engine ready: %s layers', engine.rowCount)

	return {
		ctx: {
			...CS.init(),
			effectiveColsConfig: LC.getEffectiveColumnConfig(),
			generationConfig: initRequest.input.generationConfig,
			log,
			engine,
		},
		filters: initRequest.input.filters,
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
			let errorMessage: string
			if (error instanceof Error) {
				console.error(error)
				errorMessage = error.message
			} else {
				errorMessage = String(error)
			}
			console.error(error)
			reply({ type: 'worker-error', error: errorMessage, seqId: e.data.seqId })
		}
	}
}

async function fetchLayerArtifact(cache: boolean) {
	// Nothing will read the copy back (see cacheLayerArtifact in config.server.ts), so skip OPFS entirely rather
	// than pay a 235MB write -- which costs more than the fetch and the inflate together -- to fill a directory
	// that is discarded when this profile is.
	if (!cache) return await inflateArtifact(await fetch(AR.link('/layers.bin.gz')))

	try {
		return await fetchLayerArtifactViaOpfs()
	} catch (error) {
		// OPFS handles are lock-contended across contexts (e.g. an older worker instance mid-write); the cache is
		// optional, the artifact is not
		log.warn('layer artifact OPFS cache unavailable, fetching directly: %s', error)
		return await inflateArtifact(await fetch(AR.link('/layers.bin.gz')))
	}
}

async function fetchLayerArtifactViaOpfs() {
	const opfsRoot = await navigator.storage.getDirectory()
	const artifactFileName = 'layers.bin'
	const hashFileName = 'layers.bin.hash'

	let dbHandle: FileSystemFileHandle
	let hashHandle: FileSystemFileHandle
	let storedHash: string | null = null

	try {
		const dbHandlePromise = opfsRoot.getFileHandle(artifactFileName).then((handle) => {
			return handle
		})
		const hashHandlePromise = opfsRoot.getFileHandle(hashFileName).then((handle) => {
			return handle
		})
		const storedHashPromise = hashHandlePromise
			.then((hashHandle) => hashHandle.getFile())
			.then((hashFile) => hashFile.text())
			.then((text) => {
				return text
			})
		;[dbHandle, hashHandle, storedHash] = await Promise.all([dbHandlePromise, hashHandlePromise, storedHashPromise])
	} catch {
		;[dbHandle, hashHandle] = await Promise.all([
			opfsRoot.getFileHandle(artifactFileName, { create: true }),
			opfsRoot.getFileHandle(hashFileName, { create: true }),
		])
	}

	const headers = storedHash ? { 'If-None-Match': storedHash } : undefined

	const res = await fetch(AR.link('/layers.bin.gz'), { headers })

	let buffer: ArrayBuffer

	if (res.status === 304) {
		const cachedFile = await dbHandle.getFile()
		buffer = await cachedFile.arrayBuffer()
	} else {
		buffer = await inflateArtifact(res)

		// Store in OPFS
		const writable = await dbHandle.createWritable()
		await writable.write(buffer)
		await writable.close()

		// Store hash
		const etag = res.headers.get('ETag')
		if (etag) {
			const hashWritable = await hashHandle.createWritable()
			await hashWritable.write(etag)
			await hashWritable.close()
		}
	}

	return buffer
}

// the endpoint always serves gzip, and inflating it here rather than letting the browser decode a
// Content-Encoding is what leaves the decompressed artifact to store in OPFS
async function inflateArtifact(res: Response) {
	broadcast({ type: 'layer-download-started' })
	if (!res.body) throw new Error('No body on the layer artifact response')
	return await new Response(res.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer()
}
