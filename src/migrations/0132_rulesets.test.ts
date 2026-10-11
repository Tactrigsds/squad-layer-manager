import DatabaseConstructor from 'better-sqlite3'
import superjson from 'superjson'
import { describe, expect, test } from 'vitest'

import * as RS from '@/models/rulesets.models'
import * as SETTINGS from '@/models/settings.models'

import { up } from './0132_rulesets'

// the tables as they stood before 0132, trimmed to what it reads
function makeDb(globalSettings: Record<string, unknown> | null) {
	const db = new DatabaseConstructor(':memory:')
	db.exec(`
		CREATE TABLE globalSettings (id integer PRIMARY KEY DEFAULT 1, settings text NOT NULL);
		CREATE TABLE servers (id text PRIMARY KEY, displayName text NOT NULL, visibility text NOT NULL DEFAULT 'public', settings text);
	`)
	if (globalSettings) db.prepare(`INSERT INTO globalSettings (id, settings) VALUES (1, ?)`).run(superjson.stringify(globalSettings))
	return db
}

function addServer(db: DatabaseConstructor.Database, id: string, displayName: string, settings: unknown, visibility = 'public') {
	db.prepare(`INSERT INTO servers (id, displayName, visibility, settings) VALUES (?, ?, ?, ?)`).run(
		id,
		displayName,
		visibility,
		settings === null ? null : superjson.stringify(settings),
	)
}

function readGlobal(db: DatabaseConstructor.Database): Record<string, any> {
	const row = db.prepare(`SELECT settings FROM globalSettings WHERE id = 1`).get() as { settings: string }
	return superjson.parse(row.settings)
}

function readServer(db: DatabaseConstructor.Database, id: string): Record<string, any> {
	const row = db.prepare(`SELECT settings FROM servers WHERE id = ?`).get(id) as { settings: string }
	return superjson.parse(row.settings)
}

describe('0132_rulesets', () => {
	test('each public server gets its own ruleset holding its rules, and points at it', async () => {
		const db = makeDb({ topBarColor: 'green' })
		const rules = [{ field: 'Map', within: 6, warn: true, indicate: false }]
		addServer(db, 'Main Server', 'Main', { queue: { mainPool: { repeatRules: rules, poolFilter: null } } })
		addServer(db, 'second', 'Main', { queue: { mainPool: {} } })
		await up(db)

		const global = readGlobal(db)
		expect(global.topBarColor).toBe('green')
		expect(global.rulesets).toEqual([
			{ id: 'main-server', name: 'Main', ownerServerId: 'Main Server', rules },
			// a server that said nothing had the default rules, and the second "Main" gets a free name
			{
				id: 'second',
				name: 'Main (2)',
				ownerServerId: 'second',
				rules: expect.arrayContaining([expect.objectContaining({ field: 'Map' })]),
			},
		])
		expect(readServer(db, 'Main Server').queue.mainPool).toEqual({ rulesetId: 'main-server', poolFilter: null })
		expect(readServer(db, 'second').queue.mainPool).toEqual({ rulesetId: 'second' })
	})

	test('the result parses with the current schemas', async () => {
		const db = makeDb({})
		addServer(db, 'emu', 'Emulated Server', { queue: { mainPool: { repeatRules: [{ field: 'Layer', within: 7 }] } } })
		addServer(db, 'tutorial-1', 'SLM Tutorial', { queue: { mainPool: {} } }, 'scoped')
		await up(db)

		const global = SETTINGS.parseGlobalSettings(readGlobal(db))
		expect(global.success).toBe(true)
		const server = SETTINGS.ServerSettingsSchema.safeParse({ ...readServer(db, 'emu'), connections: { type: 'sandbox' } })
		expect(server.success && server.data.queue.mainPool.rulesetId).toBe('emu')
		expect(RS.rulesFor(global.success ? global.data.rulesets : [], 'emu')).toMatchObject([{ field: 'Layer', within: 7 }])
	})

	test('tutorial servers share one ruleset', async () => {
		const db = makeDb({})
		addServer(db, 'tutorial-1', 'SLM Tutorial', { queue: { mainPool: {} } }, 'scoped')
		addServer(db, 'tutorial-2', 'SLM Tutorial', { queue: { mainPool: {} } }, 'scoped')
		await up(db)

		expect(readGlobal(db).rulesets.map((r: RS.Ruleset) => r.id)).toEqual(['slm-tutorial'])
		expect(readServer(db, 'tutorial-1').queue.mainPool.rulesetId).toBe('slm-tutorial')
		expect(readServer(db, 'tutorial-2').queue.mainPool.rulesetId).toBe('slm-tutorial')
	})

	test("comments on a server's rules move to its ruleset", async () => {
		const db = makeDb({})
		addServer(db, 'emu', 'Emulated Server', {
			queue: { mainPool: { repeatRules: [{ field: 'Map', within: 4 }] } },
			comments: { 'queue.mainPool.repeatRules.0.within': 'four is enough', 'queue.mainPool.poolFilter': 'kept here' },
		})
		await up(db)

		expect(readGlobal(db).comments).toEqual({ 'rulesets.0.rules.0.within': 'four is enough' })
		expect(readServer(db, 'emu').comments).toEqual({ 'queue.mainPool.poolFilter': 'kept here' })
	})

	test('running twice changes nothing more', async () => {
		const db = makeDb({})
		addServer(db, 'emu', 'Emulated Server', { queue: { mainPool: { repeatRules: [] } } })
		await up(db)
		const once = readGlobal(db)
		await up(db)
		expect(readGlobal(db)).toEqual(once)
	})

	test('without a global settings row there is nothing to write into', async () => {
		const db = makeDb(null)
		addServer(db, 'emu', 'Emulated Server', { queue: { mainPool: { repeatRules: [] } } })
		await up(db)
		expect(readServer(db, 'emu').queue.mainPool).toEqual({ repeatRules: [] })
	})
})
