import dotenv from 'dotenv'
import { MySql2Database, drizzle } from 'drizzle-orm/mysql2'
import mysql from 'mysql2/promise'

export let db!: MySql2Database
export function setupDatabase() {
	const env = {
		host: process.env.DB_HOST!,
		port: parseInt(process.env.DB_PORT!),
		user: process.env.DB_USER!,
		password: process.env.DB_PASSWORD!,
		database: process.env.DB_DATABASE!,
	}
	const pool = mysql.createPool(env)
	db = drizzle(pool)
}
