import { drizzle } from 'drizzle-orm/mysql2'
import mysql from 'mysql2/promise'

import * as C from './context.ts'
import { ENV } from './env.ts'

let pool: mysql.Pool
export function setupDatabase() {
	const env = {
		host: ENV.DB_HOST,
		port: ENV.DB_PORT,
		user: ENV.DB_USER,
		password: ENV.DB_PASSWORD,
		database: ENV.DB_DATABASE,
	}
	pool = mysql.createPool(env)
}

export function get(ctx: C.Log) {
	return drizzle(pool, {
		logger: {
			logQuery(query: string, params: unknown[]) {
				if (ctx.log.level === 'trace') ctx.log.trace('DB: %s: %o', params)
				else ctx.log.debug('DB: %s, %o', query, params)
			},
		},
	})
}

export type Db = ReturnType<typeof get>
