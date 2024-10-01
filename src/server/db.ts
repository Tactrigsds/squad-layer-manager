import * as sqlite from 'sqlite'
import _sqlite3 from 'sqlite3'

import logger from './logger'

let sqlite3 = _sqlite3
if (process.env['NODE_ENV'] === 'development') {
	sqlite3 = sqlite3.verbose()
}

export async function openConnection() {
	const db = await sqlite.open({
		filename: './db.sqlite',
		driver: sqlite3.Database,
	})
	if (process.env['NODE_ENV'] === 'development') {
		db.getDatabaseInstance().on('trace', (sql) => {
			console.log('query: ', sql)
		})
		db.getDatabaseInstance().on('profile', (sql: string, time: number) => {
			console.log('query: ', sql, 'took', time, 'ms')
		})
	}

	// Enable WAL mode
	await db.run('PRAGMA journal_mode = WAL;')

	// Optionally, you can set other related PRAGMA statements
	await db.run('PRAGMA synchronous = NORMAL;')
	return db
}
