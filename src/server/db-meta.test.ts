import DatabaseConstructor from 'better-sqlite3'
import { describe, expect, test } from 'vitest'
import * as DbMeta from './db-meta'

describe('db-meta build stamp', () => {
	test('round-trips a stamp', () => {
		const db = new DatabaseConstructor(':memory:')
		DbMeta.writeBuildStamp(db, { gitSha: 'abc1234def', gitBranch: 'main' })
		expect(DbMeta.readBuildStamp(db)).toEqual({ gitSha: 'abc1234def', gitBranch: 'main' })
	})

	test('reads null from a database that was never stamped', () => {
		const db = new DatabaseConstructor(':memory:')
		expect(DbMeta.readBuildStamp(db)).toBeNull()
	})

	test('overwrites on the next stamp rather than appending', () => {
		const db = new DatabaseConstructor(':memory:')
		DbMeta.writeBuildStamp(db, { gitSha: 'old', gitBranch: 'main' })
		DbMeta.writeBuildStamp(db, { gitSha: 'new', gitBranch: 'release' })
		expect(DbMeta.readBuildStamp(db)).toEqual({ gitSha: 'new', gitBranch: 'release' })
	})

	test('reads null when the table exists but a key is missing', () => {
		const db = new DatabaseConstructor(':memory:')
		db.exec(`CREATE TABLE "_slm_meta" (key TEXT PRIMARY KEY, value TEXT NOT NULL)`)
		db.prepare(`INSERT INTO "_slm_meta" (key, value) VALUES ('git_sha', 'abc')`).run()
		expect(DbMeta.readBuildStamp(db)).toBeNull()
	})
})
