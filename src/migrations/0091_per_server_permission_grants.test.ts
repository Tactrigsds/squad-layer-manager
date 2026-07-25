import DatabaseConstructor from 'better-sqlite3'
import { describe, expect, test } from 'vitest'

import { up } from './0091_per_server_permission_grants'

function makeDb(roles: unknown, serverIds: string[]) {
	const db = new DatabaseConstructor(':memory:')
	db.exec(`CREATE TABLE servers (id TEXT PRIMARY KEY)`)
	db.exec(`CREATE TABLE globalSettings (id INTEGER PRIMARY KEY, settings TEXT)`)
	for (const id of serverIds) db.prepare(`INSERT INTO servers (id) VALUES (?)`).run(id)
	db.prepare(`INSERT INTO globalSettings (id, settings) VALUES (1, ?)`).run(JSON.stringify({ json: { rbac: { roles } }, meta: undefined }))
	return db
}

function readRoles(db: InstanceType<typeof DatabaseConstructor>) {
	const row = db.prepare(`SELECT settings FROM globalSettings WHERE id = 1`).get() as { settings: string }
	return JSON.parse(row.settings).json.rbac.roles
}

describe('0091_per_server_permission_grants', () => {
	test('pins moved permissions to the configured servers, leaving global ones bare', async () => {
		const db = makeDb(
			{
				admins: { permissions: ['site:authorized', 'queue:write', 'squad-server:kick-players', 'filters:create'] },
			},
			['eu-1', 'us-1'],
		)
		await up(db)
		const admins = readRoles(db).admins
		expect(admins.permissions).toEqual(['site:authorized', 'filters:create'])
		expect(admins.serverGrants).toEqual([
			{ permission: 'queue:write', serverIds: ['eu-1', 'us-1'] },
			{ permission: 'squad-server:kick-players', serverIds: ['eu-1', 'us-1'] },
		])
	})

	test('leaves denials bare, since a bare denial applies everywhere', async () => {
		const db = makeDb({ admins: { permissions: ['queue:write', '!squad-server:kick-players'] } }, ['eu-1'])
		await up(db)
		const admins = readRoles(db).admins
		expect(admins.permissions).toEqual(['!squad-server:kick-players'])
		expect(admins.serverGrants).toEqual([{ permission: 'queue:write', serverIds: ['eu-1'] }])
	})

	test('never narrows a wildcard role', async () => {
		const db = makeDb({ owners: { permissions: ['*'] } }, ['eu-1'])
		await up(db)
		expect(readRoles(db).owners).toEqual({ permissions: ['*'] })
	})

	test('grants view to a read-only role, which has nothing server-scoped to imply it', async () => {
		const db = makeDb({ viewers: { permissions: ['site:authorized'] } }, ['eu-1'])
		await up(db)
		const viewers = readRoles(db).viewers
		expect(viewers.permissions).toEqual(['site:authorized'])
		expect(viewers.serverGrants).toEqual([{ permission: 'squad-server:view', serverIds: ['eu-1'] }])
	})

	test('does not add view where another server-scoped grant already implies it', async () => {
		const db = makeDb({ admins: { permissions: ['site:authorized', 'queue:write'] } }, ['eu-1'])
		await up(db)
		expect(readRoles(db).admins.serverGrants).toEqual([{ permission: 'queue:write', serverIds: ['eu-1'] }])
	})

	test('with no servers configured, leaves grants bare rather than writing an empty one', async () => {
		const db = makeDb(
			{
				admins: { permissions: ['site:authorized', 'queue:write'] },
				viewers: { permissions: ['site:authorized'] },
			},
			[],
		)
		await up(db)
		const roles = readRoles(db)
		// a grant naming no servers is not a valid grant; a bare expression is already the right answer here
		expect(roles.admins.permissions).toEqual(['site:authorized', 'queue:write'])
		expect(roles.admins.serverGrants).toBeUndefined()
		expect(roles.viewers.permissions).toEqual(['site:authorized', 'squad-server:view'])
	})

	test('is idempotent', async () => {
		const db = makeDb({ admins: { permissions: ['site:authorized', 'queue:write'] } }, ['eu-1'])
		await up(db)
		const once = JSON.stringify(readRoles(db))
		await up(db)
		expect(JSON.stringify(readRoles(db))).toEqual(once)
	})

	test('keeps an existing serverGrant rather than duplicating it', async () => {
		const db = makeDb(
			{
				admins: {
					permissions: ['queue:write'],
					serverGrants: [{ permission: 'queue:write', serverIds: ['eu-1'] }],
				},
			},
			['eu-1', 'us-1'],
		)
		await up(db)
		expect(readRoles(db).admins.serverGrants).toEqual([{ permission: 'queue:write', serverIds: ['eu-1'] }])
	})
})
