import DatabaseConstructor from 'better-sqlite3'
import { describe, expect, test } from 'vitest'
import * as SETTINGS from '../models/settings.models'
import { up } from './0088_repeat_rules_constrain_generation'

function makeDb(settings: unknown) {
	const db = new DatabaseConstructor(':memory:')
	db.exec(`CREATE TABLE servers (id TEXT PRIMARY KEY, settings TEXT)`)
	db.prepare(`INSERT INTO servers (id, settings) VALUES ('s1', ?)`).run(
		settings === null ? null : JSON.stringify({ json: settings, meta: undefined }),
	)
	return db
}

function readSettings(db: InstanceType<typeof DatabaseConstructor>) {
	const row = db.prepare(`SELECT settings FROM servers WHERE id = 's1'`).get() as { settings: string }
	return JSON.parse(row.settings).json
}

describe('0088_repeat_rules_constrain_generation', () => {
	test('folds generation-pool rules into the single list and enables constrainGeneration on every rule', async () => {
		const db = makeDb({
			queue: {
				mainPool: {
					repeatRules: [
						{ label: 'Map', field: 'Map', within: 4, warn: true },
						{ label: 'Gen', field: 'Faction', within: 3 },
					],
				},
				generationPool: {
					repeatRules: [
						{ label: 'Gen', field: 'Layer', within: 2 },
						{ label: 'Distinct', field: 'Gamemode', within: 1 },
					],
					applyMainPoolRepeatRules: false,
				},
			},
		})
		await up(db as any)
		const queue = readSettings(db).queue

		expect(queue.generationPool).toBeUndefined()
		expect(queue.mainPool.repeatRules).toEqual([
			{ label: 'Map', field: 'Map', within: 4, warn: true, constrainGeneration: true },
			{ label: 'Gen', field: 'Faction', within: 3, constrainGeneration: true },
			// generation-pool rule whose label collided
			{ label: 'Gen (generation)', field: 'Layer', within: 2, constrainGeneration: true },
			{ label: 'Distinct', field: 'Gamemode', within: 1, constrainGeneration: true },
		])

		// the migrated shape parses under the current schema
		const parsed = SETTINGS.PoolConfigurationSchema.parse(queue.mainPool)
		expect(parsed.repeatRules).toHaveLength(4)
	})

	test('idempotent: a migrated server (no generationPool key) is untouched', async () => {
		const migrated = {
			queue: { mainPool: { repeatRules: [{ label: 'Map', field: 'Map', within: 4, constrainGeneration: false }] } },
		}
		const db = makeDb(structuredClone(migrated))
		await up(db as any)
		expect(readSettings(db)).toEqual(migrated)
	})

	test('tolerates null settings and a missing queue', async () => {
		const db = makeDb(null)
		await up(db as any)
		const db2 = makeDb({})
		await up(db2 as any)
		expect(readSettings(db2)).toEqual({})
	})
})
