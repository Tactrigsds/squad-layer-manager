import type * as CS from '@/models/context-shared'
import { initModule } from '@/server/logger'
import { instrumentDrizzleClient } from '@kubiks/otel-drizzle'
import * as Otel from '@opentelemetry/api'
import type { MySql2Database } from 'drizzle-orm/mysql2'
import { drizzle } from 'drizzle-orm/mysql2'
import MySQL from 'mysql2/promise'
import type * as C from './context.ts'
import * as Env from './env.ts'

export type Db = MySql2Database<Record<string, never>>

const module = initModule('db')
let log!: CS.Logger

let pool: MySQL.Pool

const envBuilder = Env.getEnvBuilder({ ...Env.groups.general, ...Env.groups.db })
let ENV!: ReturnType<typeof envBuilder>
let db: Db
let dbRedactParams: Db

export async function setup() {
	log = module.getLogger()
	ENV = envBuilder()
	const rawPool = MySQL.createPool({
		host: ENV.DB_HOST,
		port: ENV.DB_PORT,
		user: ENV.DB_USER,
		password: ENV.DB_PASSWORD,
		database: ENV.DB_DATABASE,
		connectionLimit: 10,

		// return big numbers as strings to avoid precision loss. without this queries against bigints will return incorrect values
		supportBigNumbers: true,
		bigNumberStrings: true,
	})

	pool = rawPool

	const instrumentOpts = { dbSystem: 'mysql', dbName: ENV.DB_DATABASE, peerName: ENV.DB_HOST, peerPort: ENV.DB_PORT }

	db = drizzle(pool, {
		logger: {
			logQuery: (query: string, params: unknown[]) => {
				log.debug({ params }, '%s', query)
			},
		},
	})
	instrumentDrizzleClient(db, instrumentOpts)

	dbRedactParams = drizzle(pool, {
		logger: {
			logQuery: (query: string, params: unknown[]) => {
				log.debug('%s', query)
			},
		},
	})
	instrumentDrizzleClient(dbRedactParams, instrumentOpts)
}

// try to use the getter instead of passing the db instance around by itself. that way the logger is always up-to-date. not expensive.
export function addPooledDb<T extends object>(ctx: T) {
	if ('db' in ctx) return ctx as T & C.Db
	return {
		...ctx,
		db(opts?: { redactParams?: boolean }) {
			const redactParams = opts?.redactParams ?? false
			if (redactParams) {
				return dbRedactParams
			} else {
				return db
			}
		},
	}
}

const tracer = Otel.trace.getTracer('db')
export async function runTransaction<T extends C.Db, V>(
	ctx: T & { tx?: { rollback: () => void } },
	callback: (ctx: T & C.Tx) => Promise<V>,
) {
	return await tracer.startActiveSpan('db.transaction', async (span) => {
		let res!: Awaited<V>
		let shouldRollback = false
		const unlockTasks: C.Tx['tx']['unlockTasks'] = []
		try {
			await ctx.db().transaction(async (tx) => {
				res = await callback({
					...ctx,
					tx: {
						rollback: () => {
							shouldRollback = true
						},
						unlockTasks,
					},
					db: () => tx,
				})
				if (shouldRollback) tx.rollback()
			})
			await Promise.all(unlockTasks.map((task) => task()))
			span.setStatus({ code: Otel.SpanStatusCode.OK })
			return res
		} catch (err) {
			if (shouldRollback) return res
			throw err
		} finally {
			span.end()
		}
	})
}
