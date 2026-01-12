import { initModule } from '@/server/logger'
import type * as CS from '@/models/context-shared'
import * as LOG from '@/models/logs'
import { instrumentDrizzleClient } from '@kubiks/otel-drizzle'
import * as Otel from '@opentelemetry/api'
import type { MySql2Database } from 'drizzle-orm/mysql2'
import { drizzle } from 'drizzle-orm/mysql2'
import type { Pool } from 'mysql2'
import type { FieldPacket, QueryOptions, QueryResult } from 'mysql2/promise'
import MySQL from 'mysql2/promise'
import { EventEmitter } from 'node:events'
import type * as C from './context.ts'
import * as Env from './env.ts'
import { baseLogger } from './logger.ts'

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

// I hate OOP
class TracedPool extends EventEmitter implements MySQL.Pool {
	constructor(
		private basePool: MySQL.Pool,
	) {
		super()
		Object.assign(this, basePool)
	}
	pool!: Pool
	config!: MySQL.ConnectionOptions
	threadId!: number

	getConnection(): Promise<MySQL.PoolConnection> {
		try {
			return this.basePool.getConnection()
		} catch (error) {
			log.error(error, 'getConnection failed')
			throw error
		}
	}
	releaseConnection(connection: MySQL.PoolConnection): void {
		try {
			connection.release()
		} catch (error) {
			log.error(error, 'releaseConnection failed')
			throw error
		}
	}
	async end(): Promise<void> {
		try {
			await this.basePool.end()
		} catch (error) {
			log.error(error, 'end failed')
			throw error
		}
	}
	async connect(): Promise<void> {
		try {
			await this.basePool.connect()
		} catch (error) {
			log.error(error, 'connect failed')
			throw error
		}
	}

	async ping(): Promise<void> {
		try {
			await this.basePool.ping()
		} catch (error) {
			log.error(error, 'ping failed')
			throw error
		}
	}

	async beginTransaction(): Promise<void> {
		await this.basePool.beginTransaction()
	}

	async commit(): Promise<void> {
		try {
			await this.basePool.commit()
		} catch (error) {
			log.error(error, 'commit failed')
			throw error
		}
	}

	async rollback(): Promise<void> {
		try {
			await this.basePool.rollback()
		} catch (error) {
			log.error(error, 'rollback failed')
			throw error
		}
	}

	async changeUser(options: MySQL.ConnectionOptions): Promise<void> {
		try {
			await this.basePool.changeUser(options)
		} catch (error) {
			log.error(error, 'changeUser failed')
			throw error
		}
	}

	async prepare(options: string | MySQL.QueryOptions): Promise<MySQL.PreparedStatementInfo> {
		try {
			return await this.basePool.prepare(options)
		} catch (error) {
			log.error(error, 'prepare failed')
			throw error
		}
	}

	unprepare(sql: string | MySQL.QueryOptions): void {
		try {
			this.basePool.unprepare(sql)
		} catch (error) {
			log.error(error, 'unprepare failed')
			throw error
		}
	}

	destroy(): void {
		try {
			this.basePool.destroy()
		} catch (error) {
			log.error(error, 'destroy failed')
			throw error
		}
	}

	pause(): void {
		try {
			this.basePool.pause()
		} catch (error) {
			log.error(error, 'pause failed')
			throw error
		}
	}

	resume(): void {
		try {
			this.basePool.resume()
		} catch (error) {
			log.error(error, 'resume failed')
			throw error
		}
	}

	escape(value: any): string {
		return this.basePool.escape(value)
	}

	escapeId(value: string): string
	escapeId(values: string[]): string
	escapeId(values: any): string {
		return this.basePool.escapeId(values)
	}

	format(sql: string, values?: any[] | { [param: string]: any }): string {
		return this.basePool.format(sql, values)
	}

	async query<T extends [MySQL.RowDataPacket[], MySQL.ResultSetHeader]>(
		options: string | MySQL.QueryOptions,
		values?: any,
	): Promise<[T, MySQL.FieldPacket[]]> {
		try {
			return await this.basePool.query<T>(options as MySQL.QueryOptions, values)
		} catch (error) {
			log.error(error, 'query failed')
			throw error
		}
	}

	execute<T extends QueryResult>(sql: string): Promise<[T, FieldPacket[]]>
	execute<T extends QueryResult>(sql: string, values: any): Promise<[T, FieldPacket[]]>
	execute<T extends QueryResult>(options: QueryOptions): Promise<[T, FieldPacket[]]>
	execute<T extends QueryResult>(options: QueryOptions, values: any): Promise<[T, FieldPacket[]]>
	async execute<T extends QueryResult>(options: any, values?: any): Promise<[T, MySQL.FieldPacket[]]> {
		try {
			return await this.basePool.execute<T>(options, values)
		} catch (error) {
			log.error(error, 'execute failed')
			throw error
		}
	}
}
