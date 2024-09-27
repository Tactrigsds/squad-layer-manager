import * as sqlite from 'sqlite'
import sqlite3 from 'sqlite3'

export async function openConnection() {
	const conn = await sqlite.open({
		filename: './db.sqlite',
		driver: sqlite3.Database,
	})

	// Enable WAL mode
	await conn.run('PRAGMA journal_mode = WAL;')

	// Optionally, you can set other related PRAGMA statements
	await conn.run('PRAGMA synchronous = NORMAL;')

	return conn
}
