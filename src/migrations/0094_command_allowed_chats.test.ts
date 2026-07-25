import DatabaseConstructor from 'better-sqlite3'
import { describe, expect, test } from 'vitest'
import { up } from './0094_command_allowed_chats'

function makeDb(commands: unknown) {
	const db = new DatabaseConstructor(':memory:')
	db.exec(`CREATE TABLE globalSettings (id INTEGER PRIMARY KEY, settings TEXT)`)
	db.prepare(`INSERT INTO globalSettings (id, settings) VALUES (1, ?)`).run(
		JSON.stringify({ json: { commands }, meta: undefined }),
	)
	return db
}

function readCommands(db: InstanceType<typeof DatabaseConstructor>) {
	const row = db.prepare(`SELECT settings FROM globalSettings WHERE id = 1`).get() as { settings: string }
	return JSON.parse(row.settings).json.commands
}

describe('0094_command_allowed_chats', () => {
	test('renames scopes to allowedChats, values untouched', async () => {
		const db = makeDb({
			timeout: { triggers: ['/timeout'], scopes: ['admin'], enabled: true },
			shownext: { triggers: ['/sn'], scopes: ['admin', 'public'], enabled: true },
		})
		await up(db)
		const commands = readCommands(db)
		expect(commands.timeout.allowedChats).toEqual(['admin'])
		expect(commands.shownext.allowedChats).toEqual(['admin', 'public'])
		expect(commands.timeout.scopes).toBeUndefined()
		expect(commands.shownext.scopes).toBeUndefined()
	})

	test('leaves the rest of a command alone', async () => {
		const db = makeDb({ timeout: { triggers: ['/timeout', { string: '/to2h', args: '{{arg1}} 2h' }], scopes: ['admin'], enabled: false } })
		await up(db)
		expect(readCommands(db).timeout).toEqual({
			triggers: ['/timeout', { string: '/to2h', args: '{{arg1}} 2h' }],
			allowedChats: ['admin'],
			enabled: false,
		})
	})

	test('drops values that are not chat groups', async () => {
		const db = makeDb({ timeout: { triggers: ['/timeout'], scopes: ['admin', 'nonsense', null] } })
		await up(db)
		expect(readCommands(db).timeout.allowedChats).toEqual(['admin'])
	})

	test('is a noop for a command that already has no scopes', async () => {
		const db = makeDb({ timeout: { triggers: ['/timeout'], allowedChats: ['public'] } })
		await up(db)
		expect(readCommands(db).timeout.allowedChats).toEqual(['public'])
	})
})
