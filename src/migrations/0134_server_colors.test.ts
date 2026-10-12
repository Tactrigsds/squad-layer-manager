import DatabaseConstructor from 'better-sqlite3'
import superjson from 'superjson'
import { describe, expect, test } from 'vitest'

import { up } from './0134_server_colors'

function makeDb(global: Record<string, unknown>) {
	const db = new DatabaseConstructor(':memory:')
	db.exec(`
		CREATE TABLE servers (id TEXT PRIMARY KEY, settings TEXT, visibility TEXT NOT NULL DEFAULT 'public');
		CREATE TABLE globalSettings (id INTEGER PRIMARY KEY, settings TEXT);
	`)
	db.prepare(`INSERT INTO globalSettings (id, settings) VALUES (1, ?)`).run(superjson.stringify(global))
	return db
}

function addServer(db: DatabaseConstructor.Database, id: string, settings: Record<string, unknown>, visibility = 'public') {
	db.prepare(`INSERT INTO servers (id, settings, visibility) VALUES (?, ?, ?)`).run(id, superjson.stringify(settings), visibility)
}

function colors(db: DatabaseConstructor.Database) {
	const rows = db.prepare(`SELECT id, settings FROM servers`).all() as { id: string; settings: string }[]
	return Object.fromEntries(rows.map((row) => [row.id, (superjson.parse(row.settings) as { color?: string }).color]))
}

function readGlobal(db: DatabaseConstructor.Database) {
	const row = db.prepare(`SELECT settings FROM globalSettings WHERE id = 1`).get() as { settings: string }
	return superjson.parse(row.settings) as Record<string, any>
}

describe('0134_server_colors', () => {
	test('colours public servers first with swatches no server holds, and keeps existing colours', async () => {
		const db = makeDb({})
		addServer(db, 'tutorial', { locale: 'en' }, 'scoped')
		addServer(db, 'one', { locale: 'en' })
		addServer(db, 'two', { color: '#D1495B' })
		addServer(db, 'three', {})
		await up(db)
		expect(colors(db)).toEqual({ one: '#e08e45', two: '#D1495B', three: '#3d7dd9', tutorial: '#3f9e6b' })
		await up(db)
		expect(colors(db)).toEqual({ one: '#e08e45', two: '#D1495B', three: '#3d7dd9', tutorial: '#3f9e6b' })
	})

	test('drops topBarColor, its comments and its grant paths', async () => {
		const db = makeDb({
			topBarColor: 'green',
			navLinks: [],
			comments: { topBarColor: 'staging is green', navLinks: 'keep' },
			rbac: {
				roles: {
					staff: { permissions: [], globalSettingsGrants: ['topBarColor', 'navLinks'] },
					other: { permissions: [] },
				},
			},
		})
		await up(db)
		expect(readGlobal(db)).toEqual({
			navLinks: [],
			comments: { navLinks: 'keep' },
			rbac: { roles: { staff: { permissions: [], globalSettingsGrants: ['navLinks'] }, other: { permissions: [] } } },
		})
	})
})
