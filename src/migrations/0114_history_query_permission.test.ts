import DatabaseConstructor from 'better-sqlite3'
import superjson from 'superjson'
import { describe, expect, test } from 'vitest'

import { up } from './0114_history_query_permission'

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

describe('0114_history_query_permission', () => {
	test('grants it to every role with site access, and to no other', async () => {
		const db = makeDb({
			admins: { permissions: ['site:authorized', 'queue:write'] },
			owners: { permissions: ['*'] },
			bots: { permissions: ['queue:write'] },
			withheld: { permissions: ['site:authorized', '!history:query'] },
		})
		await up(db)
		expect(readPermissions(db)).toEqual({
			admins: ['site:authorized', 'queue:write', 'history:query'],
			owners: ['*'],
			bots: ['queue:write'],
			withheld: ['site:authorized', '!history:query'],
		})

		await up(db)
		expect(readPermissions(db).admins).toEqual(['site:authorized', 'queue:write', 'history:query'])
	})
})
