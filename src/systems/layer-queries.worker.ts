import * as AR from '@/app-routes'
import { acquireInBlock } from '@/lib/async'
import * as CS from '@/models/context-shared'
import type * as F from '@/models/filter.models'
import * as L from '@/models/layer'
import * as LC from '@/models/layer-columns'
import type { LayerDb } from '@/models/layer-db'
import type * as LQY from '@/models/layer-queries.models'
import * as ATTRS from '@/models/otel-attrs'
import { queries, type QueryLayersResponsePart, queryLayersStreamed } from '@/systems/layer-queries.shared'
import { baseLogger } from '@/systems/logger.client'
import { Mutex } from 'async-mutex'
import { drizzle } from 'drizzle-orm/sql-js'
import initSqlJs from 'sql.js'
// must match the loader variant the bundler resolves for 'sql.js' (browser export condition)
import sqlJsWasmUrl from 'sql.js/dist/sql-wasm-browser.wasm?url'

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
	input: CS.LayerGeneration & BackgroundQueryState & { layerData: L.LayerData }
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
	ctx: CS.LayerDb & CS.Log & CS.LayerGeneration
	filters: Map<string, F.FilterEntity>
}

const log = baseLogger.child({ [ATTRS.Module.NAME]: 'layer-queries.worker' })

const mutex = new Mutex()
let state!: State

onmessage = withErrorResponse(async (e) => {
	using _lock = await acquireInBlock(mutex)

	const msg = e.data as RequestInner & Sequenced & Prioritized
	function post(response: ResponseInner) {
		postMessage({ ...response, seqId: msg.seqId })
	}
	if (msg.type === 'init') {
		await init(msg)
		post({ type: 'init' })
		return
	}
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
	const response = (await queries[msg.type]({ ctx: queryCtx, input: msg.input as any })) as OtherQueryResponse
	post({ type: msg.type, payload: response } as any)
})

async function init(initRequest: InitRequest) {
	L.setLayerData(initRequest.input.layerData)
	const SQL = await initSqlJs({ locateFile: () => sqlJsWasmUrl })

	const buffer = await fetchDatabaseBuffer()
	const driver = new SQL.Database(new Uint8Array(buffer))
	const db = drizzle(driver, {
		logger: {
			logQuery(query, params) {
				log.debug({ params }, 'LDB: %s', query)
			},
		},
	}) as unknown as LayerDb
	state = {
		ctx: {
			...CS.init(),
			effectiveColsConfig: LC.getEffectiveColumnConfig(),
			generationConfig: initRequest.input.generationConfig,
			log,
			layerDb: () => db,
		},
		filters: initRequest.input.filters,
	}
}

function withErrorResponse<Msg extends { type: string } & Sequenced>(cb: (e: { data: Msg }) => Promise<void>) {
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
			postMessage({ type: e.data.type, error: errorMessage, seqId: e.data.seqId })
		}
	}
}

async function fetchDatabaseBuffer() {
	try {
		// Check if SharedArrayBuffer is available
		if (typeof SharedArrayBuffer === 'undefined') {
			throw new Error('SharedArrayBuffer is not available. This requires a secure context (HTTPS) and appropriate headers.')
		}

		const opfsRoot = await navigator.storage.getDirectory()
		const dbFileName = 'layers.sqlite3'
		const hashFileName = 'layers.sqlite3.hash'

		let dbHandle: FileSystemFileHandle
		let hashHandle: FileSystemFileHandle
		let storedHash: string | null = null

		try {
			const dbHandlePromise = opfsRoot.getFileHandle(dbFileName).then(handle => {
				return handle
			})
			const hashHandlePromise = opfsRoot.getFileHandle(hashFileName).then(handle => {
				return handle
			})
			const storedHashPromise = hashHandlePromise.then(hashHandle => hashHandle.getFile()).then(hashFile => hashFile.text()).then(text => {
				return text
			})
			;[dbHandle, hashHandle, storedHash] = await Promise.all([dbHandlePromise, hashHandlePromise, storedHashPromise])
		} catch {
			;[dbHandle, hashHandle] = await Promise.all([
				opfsRoot.getFileHandle(dbFileName, { create: true }),
				opfsRoot.getFileHandle(hashFileName, { create: true }),
			])
		}

		const headers = storedHash ? { 'If-None-Match': storedHash } : undefined

		const res = await fetch(AR.link('/layers.sqlite3'), { headers })

		let buffer: ArrayBuffer

		if (res.status === 304) {
			const cachedFile = await dbHandle.getFile()
			buffer = await cachedFile.arrayBuffer()
		} else {
			postMessage({ type: 'layer-download-started' })
			const isGzipped = res.headers.get('Content-Type') === 'application/gzip'
			// Decompress if gzipped
			if (isGzipped && res.body) {
				const decompressedStream = res.body.pipeThrough(new DecompressionStream('gzip'))
				const decompressedResponse = new Response(decompressedStream)
				buffer = await decompressedResponse.arrayBuffer()
			} else {
				buffer = await res.arrayBuffer()
			}

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

		// Convert to SharedArrayBuffer to minimize cloning overhead
		return buffer
	} finally {
	}
}
