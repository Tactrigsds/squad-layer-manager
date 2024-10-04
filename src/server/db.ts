import { MySql2Database, drizzle } from 'drizzle-orm/mysql2'
import mysql from 'mysql2/promise'

import { ENV } from './env'

export let db!: MySql2Database
export function setupDatabase() {
	const env = {
		host: ENV.DB_HOST,
		port: ENV.DB_PORT,
		user: ENV.DB_USER,
		password: ENV.DB_PASSWORD,
		database: ENV.DB_DATABASE,
	}
	const pool = mysql.createPool(env)
	db = drizzle(pool)
}
