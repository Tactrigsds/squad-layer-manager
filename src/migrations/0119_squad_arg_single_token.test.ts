import DatabaseConstructor from 'better-sqlite3'
import superjson from 'superjson'
import { describe, expect, test } from 'vitest'

import { rewriteTemplate, up } from './0119_squad_arg_single_token'

function makeDb(commands: unknown) {
	const db = new DatabaseConstructor(':memory:')
	db.exec(`CREATE TABLE globalSettings (id INTEGER PRIMARY KEY, settings TEXT)`)
	db.prepare(`INSERT INTO globalSettings (id, settings) VALUES (1, ?)`).run(superjson.stringify({ commands }))
	return db
}

function readCommands(db: InstanceType<typeof DatabaseConstructor>) {
	const row = db.prepare(`SELECT settings FROM globalSettings WHERE id = 1`).get() as { settings: string }
	return (superjson.parse(row.settings) as { commands: any }).commands
}

describe('0119_squad_arg_single_token', () => {
	test.each([
		['2 {{arg1}}', '2:{{arg1}}'],
		['B cmd {{rest1}}', 'B:cmd {{rest1}}'],
		['usmc 3 1h', 'usmc:3 1h'],
		['1 {{arg1}} {{arg2}} spam', '1:{{arg1}} {{arg2}} spam'],
	])('pairs a pinned team with the squad after it: %s', (template, expected) => {
		expect(rewriteTemplate(template)).toBe(expected)
	})

	test.each([
		// the squad is typed, so callers type team:squad themselves
		['{{arg1}} {{arg2}} spam'],
		// a squad name followed by a reason
		['alpha {{rest1}}'],
		['alpha {{arg1}}'],
		// not a team, so it was already the squad
		['3 2h'],
		['2:3 {{rest1}}'],
		['3'],
	])('leaves %s alone', (template) => {
		expect(rewriteTemplate(template)).toBeUndefined()
	})

	test('rewrites only squad commands, and leaves plain triggers alone', async () => {
		const db = makeDb({
			kickSquad: { triggers: ['/kicksquad', { string: '/ks2', args: '2 {{arg1}}' }], enabled: true },
			timeout: { triggers: [{ string: '/to2', args: '2 {{arg1}}' }], enabled: true },
		})
		await up(db)
		const commands = readCommands(db)
		expect(commands.kickSquad.triggers).toEqual(['/kicksquad', { string: '/ks2', args: '2:{{arg1}}' }])
		expect(commands.timeout.triggers).toEqual([{ string: '/to2', args: '2 {{arg1}}' }])
	})
})
