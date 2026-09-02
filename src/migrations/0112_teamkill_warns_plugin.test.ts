import DatabaseConstructor from 'better-sqlite3'
import superjson from 'superjson'
import { describe, expect, test } from 'vitest'

import { up } from './0112_teamkill_warns_plugin'

function makeDb() {
	const db = new DatabaseConstructor(':memory:')
	db.exec(`
		CREATE TABLE servers (id TEXT PRIMARY KEY, settings TEXT);
		CREATE TABLE plugins (id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0, config TEXT NOT NULL DEFAULT '{"json":{}}');
	`)
	return db
}

function addServer(db: DatabaseConstructor.Database, id: string, settings: Record<string, unknown>) {
	db.prepare(`INSERT INTO servers (id, settings) VALUES (?, ?)`).run(id, superjson.stringify(settings))
}

function readServer(db: DatabaseConstructor.Database, id: string) {
	const row = db.prepare(`SELECT settings FROM servers WHERE id = ?`).get(id) as { settings: string }
	return superjson.parse(row.settings) as Record<string, unknown>
}

function readPlugin(db: DatabaseConstructor.Database) {
	const row = db.prepare(`SELECT enabled, config FROM plugins WHERE id = 'teamkill-warns'`).get() as
		| { enabled: number; config: string }
		| undefined
	return row && { enabled: row.enabled, config: superjson.parse(row.config) as Record<string, unknown> }
}

describe('0112_teamkill_warns_plugin', () => {
	test('lifts the enabled servers and their template into the plugin config', async () => {
		const db = makeDb()
		addServer(db, 'off', { rconCacheTTL: {}, teamkillNotifications: { enabled: false, template: 'ignored' } })
		addServer(db, 'on', { teamkillNotifications: { enabled: true, template: 'tk by {{attacker}}' } })
		addServer(db, 'also-on', { teamkillNotifications: { enabled: true, template: 'a second, losing template' } })
		addServer(db, 'never-set', { rconCacheTTL: {} })

		await up(db)

		expect(readPlugin(db)).toEqual({ enabled: 1, config: { enabledServers: ['on', 'also-on'], template: 'tk by {{attacker}}' } })
		// the key is gone wherever it was set, and nothing else in the blob moved
		expect(readServer(db, 'off')).toEqual({ rconCacheTTL: {} })
		expect(readServer(db, 'on')).toEqual({})
		expect(readServer(db, 'never-set')).toEqual({ rconCacheTTL: {} })
	})

	test('leaves the plugin unregistered when no server had it on', async () => {
		const db = makeDb()
		addServer(db, 'off', { teamkillNotifications: { enabled: false } })

		await up(db)

		expect(readPlugin(db)).toBeUndefined()
		expect(readServer(db, 'off')).toEqual({})
	})
})
