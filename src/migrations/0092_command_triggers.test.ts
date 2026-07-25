import DatabaseConstructor from 'better-sqlite3'
import { describe, expect, test } from 'vitest'
import { up } from './0092_command_triggers'

function makeDb(commands: unknown, commandAliases: unknown) {
	const db = new DatabaseConstructor(':memory:')
	db.exec(`CREATE TABLE globalSettings (id INTEGER PRIMARY KEY, settings TEXT)`)
	db.prepare(`INSERT INTO globalSettings (id, settings) VALUES (1, ?)`).run(
		JSON.stringify({ json: { commands, commandAliases }, meta: undefined }),
	)
	return db
}

function readSettings(db: InstanceType<typeof DatabaseConstructor>) {
	const row = db.prepare(`SELECT settings FROM globalSettings WHERE id = 1`).get() as { settings: string }
	return JSON.parse(row.settings).json
}

const commands = () => ({
	timeout: { strings: ['/timeout', '/to'], scopes: ['admin'], enabled: true },
	broadcast: { strings: ['/broadcast'], scopes: ['admin'], enabled: true },
	startVote: { strings: ['/startvote'], scopes: ['admin'], enabled: true },
})

describe('0092_command_triggers', () => {
	test('turns command strings into plain triggers', async () => {
		const db = makeDb(commands(), [])
		await up(db)
		const settings = readSettings(db)
		expect(settings.commands.timeout.triggers).toEqual(['/timeout', '/to'])
		expect(settings.commands.timeout.strings).toBeUndefined()
		expect(settings.commandAliases).toBeUndefined()
	})

	// the case this whole model change exists for: the pinned argument sits between two the caller types
	test('folds an alias into its target as a trigger with pinned args', async () => {
		const db = makeDb(commands(), [{ alias: '/to2h', command: '/timeout {{arg1}} 2h {{rest2}}' }])
		await up(db)
		expect(readSettings(db).commands.timeout.triggers).toEqual([
			'/timeout',
			'/to',
			{ string: '/to2h', args: '{{arg1}} 2h {{rest2}}' },
		])
	})

	// the command word is what identified the target, so an alias with nothing after it is exactly a plain trigger
	test('folds an argument-less alias in as a plain trigger', async () => {
		const db = makeDb(commands(), [{ alias: '/sv', command: '/startvote' }])
		await up(db)
		expect(readSettings(db).commands.startVote.triggers).toEqual(['/startvote', '/sv'])
	})

	test('matches the target command string case-insensitively', async () => {
		const db = makeDb(commands(), [{ alias: '/rules', command: '/BROADCAST Read the rules' }])
		await up(db)
		expect(readSettings(db).commands.broadcast.triggers).toEqual(['/broadcast', { string: '/rules', args: 'Read the rules' }])
	})

	// it could not run before the migration either, so dropping it loses nothing that worked
	test('drops an alias whose command string does not resolve', async () => {
		const db = makeDb(commands(), [{ alias: '/gone', command: '/nosuchcommand x' }, { alias: '/rules', command: '/broadcast hi' }])
		await up(db)
		const settings = readSettings(db)
		expect(settings.commands.broadcast.triggers).toEqual(['/broadcast', { string: '/rules', args: 'hi' }])
		for (const cmd of Object.values<any>(settings.commands)) {
			expect(cmd.triggers.some((t: any) => (typeof t === 'string' ? t : t.string) === '/gone')).toBe(false)
		}
	})

	test('is a no-op on settings with no commands', async () => {
		const db = makeDb(undefined, undefined)
		await up(db)
		expect(readSettings(db).commands).toBeUndefined()
	})
})
