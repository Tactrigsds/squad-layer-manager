import * as AR from '@/app-routes'
import * as CS from '@/models/context-shared'
import * as LC from '@/models/layer-columns'
import { LayerDb } from '@/models/layer-db'
import * as LQY from '@/models/layer-queries.models'
import { baseLogger } from '@/server/systems/logger.client'
import { queries } from '@/systems.shared/layer-queries.shared'
import { drizzle } from 'drizzle-orm/sql-js'
import initSqlJs from 'sql.js'

export type QueryType = keyof typeof queries

export type DynamicQueryCtx = CS.Filters & CS.MatchHistory

export type Incoming<Q extends QueryType = QueryType> = Sequenced & {
	type: Q
	args: {
		input: Parameters<typeof queries[Q]>[0]['input']
		ctx: DynamicQueryCtx
	}
}

export type InitIncoming = {
	type: 'init'
	args: LC.EffectiveColumnConfig
} & Sequenced

export type Outbound<Q extends QueryType = QueryType> = Sequenced & {
	type: Q
	response: ReturnType<typeof queries[Q]>
}

export type InitOutbound = Sequenced & { type: 'init' }

export type Sequenced = { seqId: number }

let baseCtx!: CS.Layers & CS.Log

onmessage = async (e) => {
	if (e.data.type === 'init') {
		const msg = e.data as InitIncoming
		await init(msg.args)
		postMessage({ type: 'init', response: true, seqId: msg.seqId })
		return
	}
	const msg = e.data as Incoming

	const args = {
		ctx: { ...baseCtx, ...msg.args.ctx },
		input: msg.args.input,
	}

	// @ts-expect-error idgaf
	const response = await queries[msg.type](args)
	type MsgType = typeof msg.type
	const sequencedResponse: Outbound<MsgType> = {
		type: msg.type,
		response: response as unknown as Outbound<MsgType>['response'],
		seqId: msg.seqId,
	}
	postMessage(sequencedResponse)
}

async function init(config: LC.EffectiveColumnConfig) {
	const opfsRoot = await navigator.storage.getDirectory()
	const dbFileName = 'layers.sqlite3'
	const hashFileName = 'layers.sqlite3.hash'

	let dbHandle: FileSystemFileHandle
	let hashHandle: FileSystemFileHandle
	let storedHash: string | null = null

	try {
		dbHandle = await opfsRoot.getFileHandle(dbFileName)
		hashHandle = await opfsRoot.getFileHandle(hashFileName)
		const hashFile = await hashHandle.getFile()
		storedHash = await hashFile.text()
	} catch {
		// Files don't exist yet
		dbHandle = await opfsRoot.getFileHandle(dbFileName, { create: true })
		hashHandle = await opfsRoot.getFileHandle(hashFileName, { create: true })
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
		// Not modified, use cached version
		const cachedFile = await dbHandle.getFile()
		buffer = await cachedFile.arrayBuffer()
	} else {
		// New or updated data
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
	baseCtx = {
		log: baseLogger,
		layerDb: () => db,
		effectiveColsConfig: config,
	}
}
