import DatabaseConstructor from 'better-sqlite3'
import superjson from 'superjson'
import { describe, expect, test } from 'vitest'

import { up } from './0125_bm_write_notes_permission'

function makeDb(roles: Record<string, { permissions: string[] }>) {
	const db = new DatabaseConstructor(':memory:')
	db.exec(`CREATE TABLE globalSettings (id INTEGER PRIMARY KEY, settings TEXT)`)
	db.prepare(`INSERT INTO globalSettings (id, settings) VALUES (1, ?)`).run(superjson.stringify({ rbac: { roles } }))
	return db
}

function readPermissions(db: DatabaseConstructor.Database) {
	const row = db.prepare(`SELECT settings FROM globalSettings WHERE id = 1`).get() as { settings: string }
	const roles = (superjson.parse(row.settings) as { rbac: { roles: Record<string, { permissions: string[] }> } }).rbac.roles
	return Object.fromEntries(Object.entries(roles).map(([id, cfg]) => [id, cfg.permissions]))
}

describe('0125_bm_write_notes_permission', () => {
	test('mirrors write-flags grants and denials, and touches nothing else', async () => {
		const db = makeDb({
			admins: { permissions: ['site:authorized', 'battlemetrics:write-flags'] },
			owners: { permissions: ['*'] },
			viewers: { permissions: ['site:authorized'] },
			noFlagging: { permissions: ['!battlemetrics:write-flags'] },
			alreadyDecided: { permissions: ['battlemetrics:write-flags', '!battlemetrics:write-notes'] },
		})
		await up(db)
		expect(readPermissions(db)).toEqual({
			admins: ['site:authorized', 'battlemetrics:write-flags', 'battlemetrics:write-notes'],
			owners: ['*'],
			viewers: ['site:authorized'],
			noFlagging: ['!battlemetrics:write-flags', '!battlemetrics:write-notes'],
			alreadyDecided: ['battlemetrics:write-flags', '!battlemetrics:write-notes'],
		})

		await up(db)
		expect(readPermissions(db).admins).toEqual(['site:authorized', 'battlemetrics:write-flags', 'battlemetrics:write-notes'])
	})
})
