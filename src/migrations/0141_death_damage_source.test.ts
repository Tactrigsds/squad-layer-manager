import DatabaseConstructor from 'better-sqlite3'
import superjson from 'superjson'
import { describe, expect, test } from 'vitest'

import * as SE from '@/models/server-events.models'

import { up } from './0141_death_damage_source'

type Row = { id: number; type: string; data: string }

const PLAYERS = { victim: 'eos-1', attacker: 'eos-2', variant: 'normal' }
const ROWS: Row[] = [
	{ id: 1, type: 'PLAYER_DIED', data: superjson.stringify({ ...PLAYERS, damage: 300, weapon: 'BP_Soldier_RU_Medic' }) },
	{ id: 2, type: 'PLAYER_DIED', data: superjson.stringify({ ...PLAYERS, damage: 300, weapon: 'BP_RPG7_Tandem_Heat_Proj2' }) },
	{ id: 3, type: 'PLAYER_DIED', data: superjson.stringify({ ...PLAYERS, damage: 100, weapon: null }) },
	{ id: 4, type: 'PLAYER_WOUNDED', data: superjson.stringify({ ...PLAYERS, damage: 60, weapon: 'BP_M4_M68' }) },
	{
		id: 5,
		type: 'PLAYER_DIED',
		data: superjson.stringify({ ...PLAYERS, damage: -300, damageSource: 'BP_Soldier_RU_Medic', deathVariant: 'diedOfWounds' }),
	},
]

function migrate() {
	const db = new DatabaseConstructor(':memory:')
	db.exec(`CREATE TABLE serverEvents (id INTEGER PRIMARY KEY, type TEXT NOT NULL, data TEXT NOT NULL)`)
	const insert = db.prepare(`INSERT INTO serverEvents (id, type, data) VALUES (?, ?, ?)`)
	for (const row of ROWS) insert.run(row.id, row.type, row.data)
	return { db, run: () => up(db as any) }
}

function parse(row: Row) {
	const res = SE.parseEventRow({
		...row,
		type: row.type as SE.Event['type'],
		time: new Date(1),
		matchId: 1,
		appEventId: null,
		version: 1,
		data: JSON.parse(row.data),
	})
	if (res.code !== 'ok') throw new Error(res.error)
	return res.event
}

describe('0141_death_damage_source', () => {
	test('rewrites each row to what reading the original row gives', async () => {
		const { db, run } = migrate()
		await run()
		const migrated = db.prepare(`SELECT id, type, data FROM serverEvents ORDER BY id`).all() as Row[]

		for (const [i, row] of migrated.entries()) {
			expect(JSON.parse(row.data).json).not.toHaveProperty('weapon')
			expect(parse(row)).toEqual(parse(ROWS[i]))
		}
		expect(migrated.map((r) => parse(r))).toMatchObject([
			{ damage: -300, deathVariant: 'diedOfWounds', damageSource: 'BP_Soldier_RU_Medic' },
			{ damage: 300, deathVariant: 'killed', damageSource: 'BP_RPG7_Tandem_Heat_Proj2' },
			{ damage: 100, deathVariant: 'killed', damageSource: null },
			{ damage: 60, damageSource: 'BP_M4_M68' },
			{ damage: -300, deathVariant: 'diedOfWounds', damageSource: 'BP_Soldier_RU_Medic' },
		])
	})

	test('leaves rows already in the current shape untouched', async () => {
		const { db, run } = migrate()
		await run()
		expect((db.prepare(`SELECT data FROM serverEvents WHERE id = 5`).get() as Row).data).toBe(ROWS[4].data)
	})
})
