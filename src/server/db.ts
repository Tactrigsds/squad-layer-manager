import { drizzle } from 'drizzle-orm/mysql2'
import mysql from 'mysql2/promise'
import { Logger } from 'pino'

import { ENV } from './env'

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

export function get(ctx: { log: Logger }) {
	return drizzle(pool, {
		logger: {
			logQuery(query: string, params: unknown[]) {
				ctx.log.debug('DB: %s', query)
			},
		},
	})
}

export type Db = ReturnType<typeof get>
