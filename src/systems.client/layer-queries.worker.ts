import * as AR from '@/app-routes'
import { acquireInBlock } from '@/lib/async'
import type * as CS from '@/models/context-shared'
import type { LayerDb } from '@/models/layer-db'
import type * as LQY from '@/models/layer-queries.models'
import { baseLogger } from '@/server/systems/logger.client'
import { queries, type QueryLayersResponsePart, queryLayersStreamed } from '@/systems.shared/layer-queries.shared'
import { Mutex } from 'async-mutex'
import { drizzle } from 'drizzle-orm/sql-js'
import initSqlJs from 'sql.js'

export type ToWorker = RequestInner & Sequenced & Prioritized

export type FromWorker = (ResponseInner | { type: 'worker-error'; error: string } | SignalLoadingLayersStarted) & Sequenced

export type RequestInner = OtherQueryRequest | QueryLayersRequest | InitRequest | ContextUpdateRequest
export type ResponseInner = OtherQueryResponse | QueryLayersResponsePacket | InitResponse | ContextUpdateResponse

export type OtherQueries = typeof queries
export type OtherQueryType = keyof OtherQueries

export type DynamicQueryCtx = CS.Filters & CS.LayerItemsState

type OtherQueryRequests = { [k in OtherQueryType]: { type: k; input: Parameters<OtherQueries[k]>[0]['input'] } }
export type OtherQueryRequest = OtherQueryRequests[OtherQueryType]

type OtherQueryResponses = { [k in OtherQueryType]: { type: k; payload: Awaited<ReturnType<OtherQueries[k]>> } }
export type OtherQueryResponse = OtherQueryResponses[OtherQueryType]

export type QueryLayersRequest = {
	type: 'queryLayers'
	input: LQY.LayersQueryInput
}

export type QueryLayersResponsePacket = { type: 'queryLayers'; payload: QueryLayersResponsePart | { code: 'end' } }

export type InitRequest = {
	type: 'init'
	input: CS.EffectiveColumnConfig & DynamicQueryCtx
}

export type InitResponse = {
	type: 'init'
	payload?: undefined
}

export type ContextUpdateRequest = {
	type: 'context-update'
	input: Partial<DynamicQueryCtx>
}

export type ContextUpdateResponse = { type: 'context-update'; payload?: undefined }

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
	ctx: CS.LayerQuery
}

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
	if (msg.type === 'context-update') {
		updateContext(msg)
		post({ type: 'context-update' })
		return
	}

	if (msg.type === 'queryLayers') {
		for await (const packet of queryLayersStreamed({ ctx: state.ctx, input: msg.input })) {
			post({ type: 'queryLayers', payload: packet })
		}
		post({ type: 'queryLayers', payload: { code: 'end' } })
		return
	}
	const response = (await queries[msg.type]({ ctx: state.ctx, input: msg.input as any })) as OtherQueryResponse
	post({ type: msg.type, payload: response } as any)
})

async function init(initRequest: InitRequest) {
	const SQL = await initSqlJs({ locateFile: (file) => `https://sql.js.org/dist/${file}` })

	const buffer = await fetchDatabaseBuffer()
	const driver = new SQL.Database(new Uint8Array(buffer))
	const db = drizzle(driver, {
		logger: {
			logQuery(query, params) {
				baseLogger.debug({ params }, 'LDB: %s', query)
			},
		},
	}) as unknown as LayerDb
	state = {
		ctx: {
			...initRequest.input,
			log: baseLogger,
			layerDb: () => db,
		},
	}
}

function updateContext(msg: ContextUpdateRequest) {
	state.ctx = {
		...state.ctx,
		...msg.input,
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
