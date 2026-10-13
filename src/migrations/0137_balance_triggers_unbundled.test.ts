import DatabaseConstructor from 'better-sqlite3'
import { describe, expect, test } from 'vitest'

import { up } from './0137_balance_triggers_unbundled'

function makeDb() {
	const db = new DatabaseConstructor(':memory:')
	db.exec(`
		CREATE TABLE plugins (id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0, config TEXT NOT NULL DEFAULT '{"json":{}}');
		CREATE TABLE _plugin_migrations (pluginId TEXT NOT NULL, name TEXT NOT NULL);
		CREATE TABLE p_balance_triggers_events (id INTEGER PRIMARY KEY AUTOINCREMENT, triggerId TEXT NOT NULL);
		CREATE INDEX p_balance_triggers_events_match ON p_balance_triggers_events (triggerId);
		INSERT INTO plugins (id, enabled) VALUES ('balance-triggers', 1), ('teamkill-warns', 1);
		INSERT INTO _plugin_migrations (pluginId, name) VALUES ('balance-triggers', '0001_init'), ('teamkill-warns', '0001_init');
	`)
	return db
}

function names(db: DatabaseConstructor.Database, query: string) {
	return (db.prepare(query).all() as { v: string }[]).map((r) => r.v)
}

describe('0137_balance_triggers_unbundled', () => {
	test('removes the settings row, ledger rows and table when no event was recorded', async () => {
		const db = makeDb()
		await up(db)
		expect(names(db, `SELECT id AS v FROM plugins`)).toEqual(['teamkill-warns'])
		expect(names(db, `SELECT pluginId AS v FROM _plugin_migrations`)).toEqual(['teamkill-warns'])
		expect(names(db, `SELECT name AS v FROM sqlite_master WHERE name LIKE 'p_balance_triggers%'`)).toEqual([])
	})

	test('keeps everything when events were recorded', async () => {
		const db = makeDb()
		db.exec(`INSERT INTO p_balance_triggers_events (triggerId) VALUES ('150x2')`)
		await up(db)
		expect(names(db, `SELECT id AS v FROM plugins ORDER BY id`)).toEqual(['balance-triggers', 'teamkill-warns'])
		expect(names(db, `SELECT pluginId AS v FROM _plugin_migrations ORDER BY pluginId`)).toEqual(['balance-triggers', 'teamkill-warns'])
		expect(names(db, `SELECT COUNT(*) AS v FROM p_balance_triggers_events`)).toEqual([1])
	})

	test('runs before any plugin migration has created the ledger', async () => {
		const db = makeDb()
		db.exec(`DROP TABLE _plugin_migrations`)
		await up(db)
		expect(names(db, `SELECT id AS v FROM plugins`)).toEqual(['teamkill-warns'])
	})
})
