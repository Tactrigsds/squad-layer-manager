import DatabaseConstructor from 'better-sqlite3'
import superjson from 'superjson'
import { describe, expect, test } from 'vitest'

import { up } from './0128_drop_rcon_cache_ttl'

type Grant = { access?: string; serverIds?: string[]; paths?: string[] }

function makeDb(roles: Record<string, { permissions: string[]; serverSettingsGrants?: Grant[] }>) {
	const db = new DatabaseConstructor(':memory:')
	db.exec(`
		CREATE TABLE servers (id TEXT PRIMARY KEY, settings TEXT);
		CREATE TABLE globalSettings (id INTEGER PRIMARY KEY, settings TEXT);
	`)
	db.prepare(`INSERT INTO globalSettings (id, settings) VALUES (1, ?)`).run(superjson.stringify({ rbac: { roles } }))
	return db
}

function addServer(db: DatabaseConstructor.Database, id: string, settings: Record<string, unknown>) {
	db.prepare(`INSERT INTO servers (id, settings) VALUES (?, ?)`).run(id, superjson.stringify(settings))
}

function readServer(db: DatabaseConstructor.Database, id: string) {
	const row = db.prepare(`SELECT settings FROM servers WHERE id = ?`).get(id) as { settings: string }
	return superjson.parse(row.settings) as Record<string, unknown>
}

function readGrants(db: DatabaseConstructor.Database) {
	const row = db.prepare(`SELECT settings FROM globalSettings WHERE id = 1`).get() as { settings: string }
	const roles = (superjson.parse(row.settings) as { rbac: { roles: Record<string, { serverSettingsGrants?: Grant[] }> } }).rbac.roles
	return Object.fromEntries(Object.entries(roles).map(([id, cfg]) => [id, cfg.serverSettingsGrants]))
}

describe('0128_drop_rcon_cache_ttl', () => {
	test('drops the setting, its comments and its grant paths, and touches nothing else', async () => {
		const db = makeDb({
			mixed: {
				permissions: ['site:authorized'],
				serverSettingsGrants: [{ access: 'write', serverIds: ['a'], paths: ['queue', 'rconCacheTTL.teams', 'vote'] }],
			},
			onlyTtl: {
				permissions: [],
				serverSettingsGrants: [{ serverIds: ['a', 'b'], paths: ['rconCacheTTL'] }],
			},
			unrelated: {
				permissions: [],
				serverSettingsGrants: [
					{ access: 'read', serverIds: [], paths: [] },
					{ access: 'write', serverIds: [], paths: ['rconCacheTTLish'] },
				],
			},
			noGrants: { permissions: ['*'] },
		})
		addServer(db, 'a', {
			rconCacheTTL: { teams: '2s' },
			queue: { mainPool: {} },
			comments: { rconCacheTTL: 'tuned for a slow host', 'rconCacheTTL.teams': 'x', queue: 'kept' },
		})
		addServer(db, 'b', { rconCacheTTL: {}, comments: { 'rconCacheTTL.serverInfo': 'only comment' } })
		addServer(db, 'c', { queue: {} })

		await up(db)

		expect(readServer(db, 'a')).toEqual({ queue: { mainPool: {} }, comments: { queue: 'kept' } })
		expect(readServer(db, 'b')).toEqual({})
		expect(readServer(db, 'c')).toEqual({ queue: {} })
		const expectedGrants = {
			mixed: [{ access: 'write', serverIds: ['a'], paths: ['queue', 'vote'] }],
			// an emptied write grant would cover every setting, so the role keeps only the view access the grant implied
			onlyTtl: [{ access: 'read', serverIds: ['a', 'b'], paths: [] }],
			unrelated: [
				{ access: 'read', serverIds: [], paths: [] },
				{ access: 'write', serverIds: [], paths: ['rconCacheTTLish'] },
			],
			noGrants: undefined,
		}
		expect(readGrants(db)).toEqual(expectedGrants)

		await up(db)
		expect(readServer(db, 'a')).toEqual({ queue: { mainPool: {} }, comments: { queue: 'kept' } })
		expect(readGrants(db)).toEqual(expectedGrants)
	})
})
