import DatabaseConstructor from 'better-sqlite3'
import superjson from 'superjson'
import { describe, expect, test } from 'vitest'

import { up } from './0118_layer_request_filters'

function makeDb(servers: Record<string, unknown>) {
	const db = new DatabaseConstructor(':memory:')
	db.exec(`CREATE TABLE servers (id TEXT PRIMARY KEY, settings TEXT)`)
	for (const [id, settings] of Object.entries(servers)) {
		db.prepare(`INSERT INTO servers (id, settings) VALUES (?, ?)`).run(id, settings === null ? null : superjson.stringify(settings))
	}
	return db
}

function readMainPool(db: DatabaseConstructor.Database, id: string) {
	const row = db.prepare(`SELECT settings FROM servers WHERE id = ?`).get(id) as { settings: string }
	return (superjson.parse(row.settings) as any).queue?.mainPool
}

describe('0118_layer_request_filters', () => {
	test('takes the generation constraints, else the pool filter, else nothing', async () => {
		const db = makeDb({
			gen: {
				queue: {
					mainPool: {
						poolFilter: { filterId: 'pool', mode: 'include' },
						constrainGeneration: [
							{ filterId: 'gen-a', applyAs: 'regular' },
							{ filterId: 'gen-b', applyAs: 'inverted' },
						],
					},
				},
			},
			pool: { queue: { mainPool: { poolFilter: { filterId: 'pool', mode: 'exclude' }, constrainGeneration: [] } } },
			none: { queue: { mainPool: { poolFilter: null, constrainGeneration: [] } } },
			existing: { queue: { mainPool: { poolFilter: { filterId: 'pool', mode: 'include' }, layerRequestFilters: [] } } },
			defaults: { queue: {} },
			empty: null,
		})
		await up(db as any)

		expect(readMainPool(db, 'gen').layerRequestFilters).toEqual([
			{ filterId: 'gen-a', applyAs: 'regular' },
			{ filterId: 'gen-b', applyAs: 'inverted' },
		])
		expect(readMainPool(db, 'pool').layerRequestFilters).toEqual([{ filterId: 'pool', applyAs: 'inverted' }])
		expect(readMainPool(db, 'none').layerRequestFilters).toEqual([])
		expect(readMainPool(db, 'existing').layerRequestFilters).toEqual([])
		expect(readMainPool(db, 'defaults')).toBeUndefined()
	})
})
