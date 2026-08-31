import DatabaseConstructor from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { parentPort, workerData } from 'node:worker_threads'

import * as CS from '@/models/context-shared'
import * as HistoryQuery from '@/systems/history-query.server'

// The history query engine on its own thread, so a heavy scan never stalls the main event loop (which is
// also the rcon and websocket loop; better-sqlite3 is synchronous). It opens its own read-only connection:
// WAL lets readers run beside the main connection's writes. Booted and messaged by history.server.ts, which
// also holds the in-process fallback -- the same runEngineRequest call, minus the thread.

export type Request = { seq: number; req: HistoryQuery.EngineRequest }
export type Response = { seq: number; res?: HistoryQuery.EngineResponse | HistoryQuery.QueryError; err?: { message: string; stack?: string } }

const { dbPath } = workerData as { dbPath: string }

const driver = new DatabaseConstructor(dbPath, { readonly: true })
driver.pragma('busy_timeout = 5000')
const db = drizzle(driver)

const ctx = { ...CS.init(), db: () => db, signal: new AbortController().signal }

parentPort!.on('message', ({ seq, req }: Request) => {
	void (async (): Promise<Response> => {
		try {
			return { seq, res: await HistoryQuery.runEngineRequest(ctx, req) }
		} catch (err) {
			const e = err instanceof Error ? { message: err.message, stack: err.stack } : { message: String(err) }
			return { seq, err: e }
		}
	})().then((msg) => parentPort!.postMessage(msg))
})
