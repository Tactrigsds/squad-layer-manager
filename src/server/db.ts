import type * as CS from '@/models/context-shared'
import * as Otel from '@opentelemetry/api'
import type { MySql2Database } from 'drizzle-orm/mysql2';
import { drizzle } from 'drizzle-orm/mysql2'
import type { Pool } from 'mysql2'
import type { FieldPacket, QueryOptions, QueryResult } from 'mysql2/promise';
import MySQL from 'mysql2/promise'
import { EventEmitter } from 'node:events'
import type * as C from './context.ts'
import * as Env from './env.ts'

export type Db = MySql2Database<Record<string, never>>

export let pool: MySQL.Pool

const envBuilder = Env.getEnvBuilder({ ...Env.groups.general, ...Env.groups.db })
let ENV!: ReturnType<typeof envBuilder>

export async function setup() {
	ENV = envBuilder()
	pool = MySQL.createPool({
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
}

// try to use the getter instead of passing the db instance around by itself. that way the logger is always up-to-date. not expensive.
export function addPooledDb<T extends CS.Log>(ctx: T) {
	if ('db' in ctx) return ctx as T & C.Db
	return {
		...ctx,
		db(opts?: { redactParams?: boolean }) {
			const redactParams = opts?.redactParams ?? false
			const tracedPool = new TracedPool(this, pool) as unknown as MySQL.Pool
			const db = drizzle(tracedPool, {
				logger: {
					logQuery: (query: string, params: unknown[]) => {
						if (redactParams) {
							this.log.debug('DB: %s', query)
						} else {
							this.log.debug({ params }, 'DB: %s', query)
						}
					},
				},
			})
			return db
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
		private ctx: CS.Log,
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
			this.ctx.log.error(error, 'DB: getConnection failed')
			throw error
		}
	}
	releaseConnection(connection: MySQL.PoolConnection): void {
		try {
			connection.release()
		} catch (error) {
			this.ctx.log.error(error, 'DB: releaseConnection failed')
			throw error
		}
	}
	async end(): Promise<void> {
		try {
			await this.basePool.end()
		} catch (error) {
			this.ctx.log.error(error, 'DB: end failed')
			throw error
		}
	}
	async connect(): Promise<void> {
		try {
			await this.basePool.connect()
		} catch (error) {
			this.ctx.log.error(error, 'DB: connect failed')
			throw error
		}
	}

	async ping(): Promise<void> {
		try {
			await this.basePool.ping()
		} catch (error) {
			this.ctx.log.error(error, 'DB: ping failed')
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
			this.ctx.log.error(error, 'DB: commit failed')
			throw error
		}
	}

	async rollback(): Promise<void> {
		try {
			await this.basePool.rollback()
		} catch (error) {
			this.ctx.log.error(error, 'DB: rollback failed')
			throw error
		}
	}

	async changeUser(options: MySQL.ConnectionOptions): Promise<void> {
		try {
			await this.basePool.changeUser(options)
		} catch (error) {
			this.ctx.log.error(error, 'DB: changeUser failed')
			throw error
		}
	}

	async prepare(options: string | MySQL.QueryOptions): Promise<MySQL.PreparedStatementInfo> {
		try {
			return await this.basePool.prepare(options)
		} catch (error) {
			this.ctx.log.error(error, 'DB: prepare failed')
			throw error
		}
	}

	unprepare(sql: string | MySQL.QueryOptions): void {
		try {
			this.basePool.unprepare(sql)
		} catch (error) {
			this.ctx.log.error(error, 'DB: unprepare failed')
			throw error
		}
	}

	destroy(): void {
		try {
			this.basePool.destroy()
		} catch (error) {
			this.ctx.log.error(error, 'DB: destroy failed')
			throw error
		}
	}

	pause(): void {
		try {
			this.basePool.pause()
		} catch (error) {
			this.ctx.log.error(error, 'DB: pause failed')
			throw error
		}
	}

	resume(): void {
		try {
			this.basePool.resume()
		} catch (error) {
			this.ctx.log.error(error, 'DB: resume failed')
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
			this.ctx.log.error(error, 'DB: query failed')
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
			this.ctx.log.error(error, 'DB: execute failed')
			throw error
		}
	}
}
