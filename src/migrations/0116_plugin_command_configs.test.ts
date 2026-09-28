import DatabaseConstructor from 'better-sqlite3'
import superjson from 'superjson'
import { describe, expect, test } from 'vitest'

import { up } from './0116_plugin_command_configs'

function makeDb(settings: Record<string, unknown>) {
	const db = new DatabaseConstructor(':memory:')
	db.exec(`
		CREATE TABLE globalSettings (id INTEGER PRIMARY KEY DEFAULT 1, settings TEXT NOT NULL);
		CREATE TABLE plugins (id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0, config TEXT NOT NULL DEFAULT '{"json":{}}');
	`)
	db.prepare(`INSERT INTO globalSettings (id, settings) VALUES (1, ?)`).run(superjson.stringify(settings))
	return db
}

function readPlugins(db: DatabaseConstructor.Database) {
	const rows = db.prepare(`SELECT id, enabled, config, commands FROM plugins ORDER BY id`).all() as {
		id: string
		enabled: number
		config: string
		commands: string
	}[]
	return rows.map((r) => ({ id: r.id, enabled: r.enabled, config: superjson.parse(r.config), commands: superjson.parse(r.commands) }))
}

const tkConfig = { triggers: ['!tk'], allowedChats: ['admin'], enabled: true, quickReference: false }
const seedConfig = { triggers: ['!seed'], allowedChats: ['all'], enabled: false, quickReference: true }

describe('0116_plugin_command_configs', () => {
	test('moves each override onto its plugin row and drops the setting', async () => {
		const db = makeDb({ defaultPrefix: '!', pluginCommands: { 'plugin:teamkill-warns:tk': tkConfig, 'plugin:seeding:seed': seedConfig } })
		db.prepare(`INSERT INTO plugins (id, enabled, config) VALUES ('teamkill-warns', 1, ?)`).run(superjson.stringify({ template: 'x' }))

		await up(db)

		expect(readPlugins(db)).toEqual([
			{ id: 'seeding', enabled: 0, config: {}, commands: { seed: seedConfig } },
			{ id: 'teamkill-warns', enabled: 1, config: { template: 'x' }, commands: { tk: tkConfig } },
		])
		const settings = superjson.parse((db.prepare(`SELECT settings FROM globalSettings`).get() as { settings: string }).settings)
		expect(settings).toEqual({ defaultPrefix: '!' })
	})

	test('leaves rows empty when nothing was configured', async () => {
		const db = makeDb({ defaultPrefix: '!' })
		db.prepare(`INSERT INTO plugins (id, enabled) VALUES ('balance-triggers', 1)`).run()

		await up(db)

		expect(readPlugins(db)).toEqual([{ id: 'balance-triggers', enabled: 1, config: {}, commands: {} }])
	})
})
