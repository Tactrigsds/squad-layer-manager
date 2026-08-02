import DatabaseConstructor from 'better-sqlite3'
import { describe, expect, test } from 'vitest'

import { up } from './0097_community_collection_into_owi'

const COLLECTION = { type: 'column', column: 'Collection' }

function makeDb() {
	const db = new DatabaseConstructor(':memory:')
	db.exec(`
		CREATE TABLE filters (id TEXT PRIMARY KEY, filter TEXT);
		CREATE TABLE servers (id TEXT PRIMARY KEY, layerQueue TEXT, backburner TEXT, settings TEXT);
		CREATE TABLE globalSettings (id INTEGER PRIMARY KEY, settings TEXT);
		CREATE TABLE matchHistory (id INTEGER PRIMARY KEY, layerId TEXT);
	`)
	return db
}

function wrap(json: unknown) {
	return JSON.stringify({ json, meta: undefined })
}

describe('0097_community_collection_into_owi', () => {
	test('folds Collection comparisons and rewrites the CL segment out of layer ids', async () => {
		const db = makeDb()
		db.prepare(`INSERT INTO filters (id, filter) VALUES (?, ?)`).run(
			'f1',
			JSON.stringify({
				type: 'and',
				children: [
					{ type: 'in', neg: false, args: [COLLECTION, { type: 'values', values: ['OWI', 'Community', 'SuperMod'] }] },
					{ type: 'eq', neg: true, args: [COLLECTION, { type: 'value', value: 'Community' }] },
					{
						type: 'eq',
						neg: false,
						args: [
							{ type: 'column', column: 'Map' },
							{ type: 'value', value: 'Community' },
						],
					},
					{
						type: 'in',
						neg: false,
						args: [
							{ type: 'column', column: 'id' },
							{
								type: 'values',
								values: ['FL-INV-V3-CL:ADF-MZ:BAF-AR', 'GD-RAAS-V1:USA-CA:RGF-CA'],
							},
						],
					},
				],
			}),
		)
		db.prepare(`INSERT INTO servers (id, layerQueue, backburner, settings) VALUES (?, ?, ?, ?)`).run(
			's1',
			wrap([{ layerId: 'HJ-RAAS-V3-CL:USA-CA:RGF-CA' }]),
			wrap([{ filter: { type: 'eq', neg: false, args: [COLLECTION, { type: 'value', value: 'Community' }] } }]),
			wrap({ queue: { note: 'the community pool' } }),
		)
		db.prepare(`INSERT INTO globalSettings (id, settings) VALUES (1, ?)`).run(
			wrap({ layerTable: { defaultSortBy: 'AB-AAS-V3-CL:USA-CA:MEI-CA' } }),
		)
		db.prepare(`INSERT INTO matchHistory (id, layerId) VALUES (?, ?)`).run(1, 'SX-RAAS-V3-CL:USA-CA:PLA-CA')
		db.prepare(`INSERT INTO matchHistory (id, layerId) VALUES (?, ?)`).run(2, 'RAW:Sanxian_RAAS_v3_CL USA+CombinedArms PLA+CombinedArms')

		await up(db as never)

		const filter = JSON.parse((db.prepare(`SELECT filter FROM filters WHERE id = 'f1'`).get() as { filter: string }).filter)
		expect(filter.children[0].args[1].values).toEqual(['OWI', 'SuperMod'])
		expect(filter.children[1].args[1].value).toBe('OWI')
		expect(filter.children[1].neg).toBe(true)
		// only the Collection column is folded; another column's value that happens to read "Community" is untouched
		expect(filter.children[2].args[1].value).toBe('Community')
		expect(filter.children[3].args[1].values).toEqual(['FL-INV-V3:ADF-MZ:BAF-AR', 'GD-RAAS-V1:USA-CA:RGF-CA'])

		const server = db.prepare(`SELECT layerQueue, backburner, settings FROM servers WHERE id = 's1'`).get() as Record<string, string>
		expect(JSON.parse(server.layerQueue).json[0].layerId).toBe('HJ-RAAS-V3:USA-CA:RGF-CA')
		expect(JSON.parse(server.backburner).json[0].filter.args[1].value).toBe('OWI')
		expect(JSON.parse(server.settings).json.queue.note).toBe('the community pool')

		const global = db.prepare(`SELECT settings FROM globalSettings WHERE id = 1`).get() as { settings: string }
		expect(JSON.parse(global.settings).json.layerTable.defaultSortBy).toBe('AB-AAS-V3:USA-CA:MEI-CA')

		const matches = db.prepare(`SELECT id, layerId FROM matchHistory ORDER BY id`).all() as { id: number; layerId: string }[]
		expect(matches[0].layerId).toBe('SX-RAAS-V3:USA-CA:PLA-CA')
		// the Layer column value never changed, so raw command text is left as it was sent
		expect(matches[1].layerId).toBe('RAW:Sanxian_RAAS_v3_CL USA+CombinedArms PLA+CombinedArms')
	})
})
