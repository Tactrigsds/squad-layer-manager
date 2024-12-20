import { TRPCError } from '@trpc/server'
import { drizzle, MySql2Database } from 'drizzle-orm/mysql2'
import MySQL from 'mysql2/promise'
import * as Schema from './schema.ts'
import { EventEmitter } from 'node:events'

import * as C from './context.ts'
import { ENV } from './env.ts'

export type Db = MySql2Database<Record<string, never>>

let pool: MySQL.Pool

export function setupDatabase() {
	const env: Parameters<typeof MySQL.createPool>[0] = {
		host: ENV.DB_HOST,
		port: ENV.DB_PORT,
		user: ENV.DB_USER,
		password: ENV.DB_PASSWORD,
		database: ENV.DB_DATABASE,
	}
	pool = MySQL.createPool(env)
}

// try to use the getter instead of passing the db instance around by itself. that way the logger is always up-to-date
export function addPooledDb<T extends C.Log>(ctx: T & { db?: never }) {
	if (ctx.db) throw new Error('db already exists')
	return {
		...ctx,
		db() {
			const tracedPool = new TracedPool(this, pool) as unknown as MySQL.Pool
			const db = drizzle(tracedPool, {
				logger: {
					logQuery: (query: string, params: unknown[]) => {
						this.log.debug('DB: %s, %o', query, params)
					},
				},
			})
			return db
		},
	}
}

// I hate OOP
class TracedPool extends EventEmitter implements MySQL.Pool {
	constructor(
		private ctx: C.Log,
		private basePool: MySQL.Pool
	) {
		super()
		Object.assign(this, basePool)
	}

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

	escapeId(value: string): string {
		return this.basePool.escapeId(value)
	}

	format(sql: string, values?: any | any[] | { [param: string]: any }): string {
		return this.basePool.format(sql, values)
	}

	async query<T extends [MySQL.RowDataPacket[], MySQL.ResultSetHeader]>(
		options: string | MySQL.QueryOptions,
		values?: any
	): Promise<[T, MySQL.FieldPacket[]]> {
		try {
			return await this.basePool.query<T>(options as MySQL.QueryOptions, values)
		} catch (error) {
			this.ctx.log.error(error, 'DB: query failed')
			throw error
		}
	}

	async execute<T>(options: string | MySQL.QueryOptions, values?: any): Promise<[T, MySQL.FieldPacket[]]> {
		try {
			return await this.basePool.execute<T>(options, values)
		} catch (error) {
			this.ctx.log.error(error, 'DB: execute failed')
			throw error
		}
	}
}
