import DatabaseConstructor from 'better-sqlite3'
import { describe, expect, test } from 'vitest'
import * as SETTINGS from '../models/settings.models'
import { up } from './0085_pool_config_single_pool_filter'

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

const OLD_QUEUE = {
	mainPool: {
		filters: [
			// legacy bare-string entry, predates the per-filter config object
			'legacy-filter',
			{ filterId: 'the-pool', inPool: 'regular', showIndicator: 'both', defaultApplyDuringLayerSelection: 'hidden' },
			{ filterId: 'other-pool', inPool: 'inverted' },
			{ filterId: 'select-me', defaultApplyDuringLayerSelection: 'inverted', showIndicator: 'regular', warn: 'regular' },
			{ filterId: 'warn-only', showIndicator: 'inverted', warn: 'inverted', defaultApplyDuringLayerSelection: 'disabled' },
		],
		repeatRules: [{ label: 'Map', field: 'Map', within: 4, warn: true }],
	},
	generationPool: {
		filters: [
			{ filterId: 'gen-a', applyAs: 'regular' },
			{ filterId: 'gen-b', applyAs: 'inverted' },
			{ filterId: 'gen-off', applyAs: 'disabled' },
		],
		repeatRules: [{ label: 'Gen', field: 'Layer', within: 2 }],
		applyMainPoolRepeatRules: true,
	},
}

describe('0085_pool_config_single_pool_filter', () => {
	test('maps the old per-filter flags onto the pool filter and role lists', async () => {
		const db = makeDb({ queue: structuredClone(OLD_QUEUE) })
		await up(db as any)
		const queue = readSettings(db).queue

		expect(queue.mainPool.filters).toBeUndefined()
		expect(queue.generationPool).toBeUndefined()

		// the first active inPool entry wins; later ones are dropped
		expect(queue.mainPool.poolFilter).toEqual({ filterId: 'the-pool', mode: 'include' })
		expect(queue.mainPool.indicateMatches).toEqual(['the-pool', 'select-me'])
		expect(queue.mainPool.indicateMisses).toEqual(['the-pool', 'warn-only'])
		// 'disabled' carries over (offered but unchecked); 'hidden' is dropped
		expect(queue.mainPool.defaultSelectable).toEqual([
			{ filterId: 'select-me', applyAs: 'inverted' },
			{ filterId: 'warn-only', applyAs: 'disabled' },
		])
		expect(queue.mainPool.warnFor).toEqual([
			{ filterId: 'select-me', applyAs: 'regular' },
			{ filterId: 'warn-only', applyAs: 'inverted' },
		])
		expect(queue.mainPool.constrainGeneration).toEqual([
			{ filterId: 'gen-a', applyAs: 'regular' },
			{ filterId: 'gen-b', applyAs: 'inverted' },
		])

		// applyMainPoolRepeatRules=true marks the main rule autogen; the generation rule merges in as autogen
		expect(queue.mainPool.repeatRules).toEqual([
			{ label: 'Map', field: 'Map', within: 4, warn: true, autogen: true },
			{ label: 'Gen', field: 'Layer', within: 2, autogen: true },
		])

		// the migrated shape must parse under the live schema
		expect(() => SETTINGS.QueueSettingsSchema.parse(queue)).not.toThrow()
		db.close()
	})

	test('inverted inPool becomes an exclude-mode pool filter', async () => {
		const db = makeDb({ queue: { mainPool: { filters: [{ filterId: 'not-these', inPool: 'inverted' }], repeatRules: [] } } })
		await up(db as any)
		expect(readSettings(db).queue.mainPool.poolFilter).toEqual({ filterId: 'not-these', mode: 'exclude' })
		db.close()
	})

	test('is idempotent and skips rows without pool config', async () => {
		const db = makeDb({ queue: structuredClone(OLD_QUEUE) })
		await up(db as any)
		const once = readSettings(db)
		await up(db as any)
		expect(readSettings(db)).toEqual(once)
		db.close()

		const nullDb = makeDb(null)
		await up(nullDb as any)
		const row = nullDb.prepare(`SELECT settings FROM servers WHERE id = 's1'`).get() as { settings: string | null }
		expect(row.settings).toBeNull()
		nullDb.close()
	})
})
