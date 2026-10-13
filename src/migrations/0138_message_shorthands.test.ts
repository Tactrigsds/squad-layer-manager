import DatabaseConstructor from 'better-sqlite3'
import superjson from 'superjson'
import { describe, expect, test } from 'vitest'

import { up } from './0138_message_shorthands'

function makeDb(global: Record<string, unknown>) {
	const db = new DatabaseConstructor(':memory:')
	db.exec(`CREATE TABLE globalSettings (id INTEGER PRIMARY KEY, settings TEXT);`)
	db.prepare(`INSERT INTO globalSettings (id, settings) VALUES (1, ?)`).run(superjson.stringify(global))
	return db
}

function readGlobal(db: DatabaseConstructor.Database) {
	const row = db.prepare(`SELECT settings FROM globalSettings WHERE id = 1`).get() as { settings: string }
	return superjson.parse(row.settings) as Record<string, any>
}

describe('0138_message_shorthands', () => {
	test('renames the keys, their comments and their grant paths', async () => {
		const shorthands = [{ label: 'Teamkilling', keywords: ['tk'], actionTexts: { warn: 'Do not team kill.' } }]
		const listCommand = { triggers: ['warnreasons'], allowedChats: ['admin'], enabled: true, quickReference: false }
		const db = makeDb({
			adminActionReasons: shorthands,
			commands: { warn: { enabled: true }, listWarnReasons: listCommand },
			comments: {
				adminActionReasons: 'whole list',
				'adminActionReasons.0.label': 'one label',
				'commands.listWarnReasons.triggers': 'triggers',
				adminActionReasonsLike: 'unrelated key with the same prefix',
				navLinks: 'keep',
			},
			rbac: {
				roles: {
					staff: {
						permissions: [],
						globalSettingsGrants: ['adminActionReasons', 'commands.listWarnReasons.enabled', 'commands', 'navLinks'],
					},
					other: { permissions: [] },
				},
			},
		})
		const expected = {
			adminMessageShorthands: shorthands,
			commands: { warn: { enabled: true }, listMessageShorthands: listCommand },
			comments: {
				adminMessageShorthands: 'whole list',
				'adminMessageShorthands.0.label': 'one label',
				'commands.listMessageShorthands.triggers': 'triggers',
				adminActionReasonsLike: 'unrelated key with the same prefix',
				navLinks: 'keep',
			},
			rbac: {
				roles: {
					staff: {
						permissions: [],
						globalSettingsGrants: ['adminMessageShorthands', 'commands.listMessageShorthands.enabled', 'commands', 'navLinks'],
					},
					other: { permissions: [] },
				},
			},
		}
		await up(db)
		expect(readGlobal(db)).toEqual(expected)
		await up(db)
		expect(readGlobal(db)).toEqual(expected)
	})

	test('leaves settings without either key alone', async () => {
		const db = makeDb({ navLinks: [] })
		await up(db)
		expect(readGlobal(db)).toEqual({ navLinks: [] })
	})
})
