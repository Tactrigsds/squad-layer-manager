import * as AR from '@/app-routes'
import { acquireInBlock } from '@/lib/async'
import * as CS from '@/models/context-shared'
import { LayerDb } from '@/models/layer-db'
import { baseLogger } from '@/server/systems/logger.client'
import { queries } from '@/systems.shared/layer-queries.shared'
import { Mutex } from 'async-mutex'
import { drizzle } from 'drizzle-orm/sql-js'
import initSqlJs from 'sql.js'

export type QueryType = keyof typeof queries

export type DynamicQueryCtx = CS.Filters & CS.LayerItemsState

export type QueryRequest<Q extends QueryType = QueryType> = Sequenced & {
	type: Q
	input: Parameters<typeof queries[Q]>[0]['input']
}

export type Response<Q extends { type: string }, Payload = undefined> = Sequenced & {
	type: Q['type']
	error?: string
	payload?: Payload
}

export type QueryResponse<Q extends QueryType = QueryType> = Response<{ type: Q }, Awaited<ReturnType<typeof queries[Q]>>>

export type InitRequest = Sequenced & {
	type: 'init'
	ctx: CS.EffectiveColumnConfig & DynamicQueryCtx
}

export type InitResponse = Response<InitRequest>

export type ContextUpdateRequest = Sequenced & {
	type: 'context-update'
	ctx: Partial<DynamicQueryCtx>
}

export type ContextUpdateResponse = Sequenced & { type: 'context-update'; error?: string }

export type Sequenced = { seqId: number }

type State = {
	ctx: CS.LayerQuery
}

export type GenericRequest = QueryRequest | InitRequest | ContextUpdateRequest

let state!: State

const mutex = new Mutex()

onmessage = withErrorResponse(async (e) => {
	using _lock = await acquireInBlock(mutex)
	const msg = e.data as GenericRequest
	if (msg.type === 'init') {
		await init(msg)
		postMessage({ type: 'init', seqId: msg.seqId } satisfies InitResponse)
		return
	}
	if (msg.type === 'context-update') {
		const msg = e.data as ContextUpdateRequest
		updateContext(msg)
		postMessage({ type: 'context-update', seqId: msg.seqId } satisfies ContextUpdateResponse)
		return
	}

	// @ts-expect-error idgaf
	const response = await queries[msg.type]({ ctx: state.ctx, input: msg.input })
	type MsgType = typeof msg.type
	const sequencedResponse: QueryResponse<MsgType> = {
		type: msg.type,
		payload: response as unknown as QueryResponse<MsgType>['payload'],
		seqId: msg.seqId,
	}
	postMessage(sequencedResponse)
})

async function init(initRequest: InitRequest) {
	const opfsRoot = await navigator.storage.getDirectory()
	const dbFileName = 'layers.sqlite3'
	const hashFileName = 'layers.sqlite3.hash'

	let dbHandle: FileSystemFileHandle
	let hashHandle: FileSystemFileHandle
	let storedHash: string | null = null

	try {
		const dbHandlePromise = opfsRoot.getFileHandle(dbFileName)
		const hashHandlePromise = opfsRoot.getFileHandle(hashFileName)
		const storedHashPromise = hashHandlePromise.then(hashHandle => hashHandle.getFile()).then(hashFile => hashFile.text())
		;[dbHandle, hashHandle, storedHash] = await Promise.all([dbHandlePromise, hashHandlePromise, storedHashPromise])
	} catch {
		;[dbHandle, hashHandle] = await Promise.all([
			opfsRoot.getFileHandle(dbFileName, { create: true }),
			opfsRoot.getFileHandle(hashFileName, { create: true }),
		])
	}

	const headers = storedHash ? { 'If-None-Match': storedHash } : undefined

	const [res, SQL] = await Promise.all([
		fetch(AR.link('/layers.sqlite3'), { headers }),
		initSqlJs({
			locateFile: (file) => `https://sql.js.org/dist/${file}`,
		}),
	])

	let buffer: ArrayBuffer

	if (res.status === 304) {
		const cachedFile = await dbHandle.getFile()
		buffer = await cachedFile.arrayBuffer()
	} else {
		buffer = await res.arrayBuffer()

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
			...initRequest.ctx,
			log: baseLogger,
			layerDb: () => db,
		},
	}
}

function updateContext(msg: ContextUpdateRequest) {
	state.ctx = {
		...state.ctx,
		...msg.ctx,
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
