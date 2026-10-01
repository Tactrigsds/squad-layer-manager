import DatabaseConstructor from 'better-sqlite3'
import superjson from 'superjson'
import { describe, expect, test } from 'vitest'

import { rewriteTemplate, up } from './0124_trigger_rest_inferred'

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

describe('0124_trigger_rest_inferred', () => {
	test.each([
		['{{arg1}} 2h {{rest2}}', '{{arg1}} 2h {{rest}}'],
		['{{arg1}} {{arg2}} {{rest3}}', '{{arg1}} {{arg2}} {{rest}}'],
		['{{rest1}}', '{{rest}}'],
		['{{arg1}} {{^rest2}}spam{{/rest2}}{{rest2}}', '{{arg1}} {{^rest}}spam{{/rest}}{{rest}}'],
		['{{arg1}} {{ rest2 }}', '{{arg1}} {{ rest }}'],
	])('rewrites %s', (template, expected) => {
		expect(rewriteTemplate(template)).toEqual({ args: expected, overlapped: false })
	})

	test.each([
		['{{arg1}} {{rest1}}', '{{arg1}} {{rest}}'],
		['{{arg1}} {{rest}}', '{{arg1}} {{rest}}'],
		['{{arg1}} {{arg2}} {{rest2}}', '{{arg1}} {{arg2}} {{rest}}'],
	])('flags an overlap in %s', (template, expected) => {
		expect(rewriteTemplate(template)).toEqual({ args: expected, overlapped: true })
	})

	test.each([['{{rest}}'], ['{{arg1}} 2h'], ['restore {{arg1}}']])('leaves %s alone', (template) => {
		expect(rewriteTemplate(template)).toBeUndefined()
	})

	test('rewrites every command, and leaves plain triggers alone', async () => {
		const db = makeDb({
			timeout: { triggers: ['/timeout', { string: '/to2h', args: '{{arg1}} 2h {{rest2}}' }], enabled: true },
			broadcast: { triggers: [{ string: '/say', args: '{{rest}}' }], enabled: true },
		})
		await up(db)
		const commands = readCommands(db)
		expect(commands.timeout.triggers).toEqual(['/timeout', { string: '/to2h', args: '{{arg1}} 2h {{rest}}' }])
		expect(commands.broadcast.triggers).toEqual([{ string: '/say', args: '{{rest}}' }])
	})
})
