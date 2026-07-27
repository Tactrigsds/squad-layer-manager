import DatabaseConstructor from 'better-sqlite3'
import { describe, expect, test } from 'vitest'

import { up } from './0095_slm_updates_disabled_reason'

function makeDb(servers: Record<string, unknown>) {
	const db = new DatabaseConstructor(':memory:')
	db.exec(`CREATE TABLE servers (id TEXT PRIMARY KEY, settings TEXT)`)
	for (const [id, settings] of Object.entries(servers)) {
		db.prepare(`INSERT INTO servers (id, settings) VALUES (?, ?)`).run(id, JSON.stringify({ json: settings, meta: undefined }))
	}
	return db
}

function readSettings(db: InstanceType<typeof DatabaseConstructor>, id: string) {
	const row = db.prepare(`SELECT settings FROM servers WHERE id = ?`).get(id) as { settings: string }
	return JSON.parse(row.settings).json
}

describe('0095_slm_updates_disabled_reason', () => {
	test('true becomes a manual reason with no recorded actor, false becomes null', async () => {
		const db = makeDb({
			a: { updatesToSquadServerDisabled: true },
			b: { updatesToSquadServerDisabled: false },
		})
		await up(db)
		expect(readSettings(db, 'a').updatesToSquadServerDisabled).toEqual({ type: 'manual', by: null })
		expect(readSettings(db, 'b').updatesToSquadServerDisabled).toBeNull()
	})

	test('leaves the rest of the settings alone', async () => {
		const db = makeDb({ a: { updatesToSquadServerDisabled: true, displayName: 'Server A', queue: { preferredLength: 6 } } })
		await up(db)
		expect(readSettings(db, 'a')).toEqual({
			updatesToSquadServerDisabled: { type: 'manual', by: null },
			displayName: 'Server A',
			queue: { preferredLength: 6 },
		})
	})

	test('is a noop for a row already carrying a reason', async () => {
		const db = makeDb({ a: { updatesToSquadServerDisabled: { type: 'ingame-vote' } }, b: { updatesToSquadServerDisabled: null } })
		await up(db)
		expect(readSettings(db, 'a').updatesToSquadServerDisabled).toEqual({ type: 'ingame-vote' })
		expect(readSettings(db, 'b').updatesToSquadServerDisabled).toBeNull()
	})

	test('skips a server whose settings are absent or unparseable as an object', async () => {
		const db = new DatabaseConstructor(':memory:')
		db.exec(`CREATE TABLE servers (id TEXT PRIMARY KEY, settings TEXT)`)
		db.prepare(`INSERT INTO servers (id, settings) VALUES ('a', NULL)`).run()
		db.prepare(`INSERT INTO servers (id, settings) VALUES ('b', ?)`).run(JSON.stringify({ json: null }))
		await expect(up(db)).resolves.toBeUndefined()
	})
})
