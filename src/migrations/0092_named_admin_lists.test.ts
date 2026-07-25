import DatabaseConstructor from 'better-sqlite3'
import { describe, expect, test } from 'vitest'
import { up } from './0092_named_admin_lists'

function makeDb(globalJson: unknown, servers: Record<string, unknown> = {}) {
	const db = new DatabaseConstructor(':memory:')
	db.exec(`CREATE TABLE servers (id TEXT PRIMARY KEY, settings TEXT)`)
	db.exec(`CREATE TABLE globalSettings (id INTEGER PRIMARY KEY, settings TEXT)`)
	db.prepare(`INSERT INTO globalSettings (id, settings) VALUES (1, ?)`).run(JSON.stringify({ json: globalJson }))
	for (const [id, settings] of Object.entries(servers)) {
		db.prepare(`INSERT INTO servers (id, settings) VALUES (?, ?)`).run(id, JSON.stringify({ json: settings }))
	}
	return db
}

function readGlobal(db: InstanceType<typeof DatabaseConstructor>) {
	const row = db.prepare(`SELECT settings FROM globalSettings WHERE id = 1`).get() as { settings: string }
	return JSON.parse(row.settings).json
}

function readServer(db: InstanceType<typeof DatabaseConstructor>, id: string) {
	const row = db.prepare(`SELECT settings FROM servers WHERE id = ?`).get(id) as { settings: string }
	return JSON.parse(row.settings).json
}

describe('0092_named_admin_lists', () => {
	test('names each source after where it comes from and gives it the old global permissions', async () => {
		const db = makeDb({
			adminListSources: [
				{ type: 'local', source: '/etc/squad/Admins.cfg' },
				{ type: 'remote', source: 'https://example.com/lists/Whitelist.cfg' },
			],
			adminIdentifyingPermissions: ['canseeadminchat'],
		})
		await up(db)
		const gs = readGlobal(db)
		expect(Object.keys(gs.adminLists).sort()).toEqual(['Admins', 'Whitelist'])
		expect(gs.adminLists.Admins).toEqual({
			source: { type: 'local', source: '/etc/squad/Admins.cfg' },
			adminIdentifyingPermissions: ['canseeadminchat'],
		})
		expect(gs.adminListSources).toBeUndefined()
		expect(gs.adminIdentifyingPermissions).toBeUndefined()
	})

	test('gives every server every list, because every source applied everywhere before', async () => {
		const db = makeDb(
			{ adminListSources: [{ type: 'local', source: 'Admins.cfg' }], adminIdentifyingPermissions: [] },
			{ 'eu-1': { queue: {} }, 'us-1': { queue: {} } },
		)
		await up(db)
		expect(readServer(db, 'eu-1').adminLists).toEqual(['Admins'])
		expect(readServer(db, 'us-1').adminLists).toEqual(['Admins'])
	})

	test('fans an in-game-admin assignment out to every list, since it meant their union', async () => {
		const db = makeDb({
			adminListSources: [
				{ type: 'local', source: 'A.cfg' },
				{ type: 'local', source: 'B.cfg' },
			],
			adminIdentifyingPermissions: ['canseeadminchat'],
			rbac: { roles: { admins: { assignments: { includeIngameAdmins: true, adminListGroups: ['Reserve'] } } } },
		})
		await up(db)
		const a = readGlobal(db).rbac.roles.admins.assignments
		expect(a.ingameAdminLists).toEqual(['A', 'B'])
		expect(a.adminListGroups).toEqual([
			{ listId: 'A', groupId: 'Reserve' },
			{ listId: 'B', groupId: 'Reserve' },
		])
		expect(a.includeIngameAdmins).toBeUndefined()
	})

	test('leaves a role that never had in-game admins without any', async () => {
		const db = makeDb({
			adminListSources: [{ type: 'local', source: 'A.cfg' }],
			adminIdentifyingPermissions: [],
			rbac: { roles: { web: { assignments: { includeIngameAdmins: false, adminListGroups: [] } } } },
		})
		await up(db)
		const a = readGlobal(db).rbac.roles.web.assignments
		expect(a.ingameAdminLists).toEqual([])
		expect(a.adminListGroups).toEqual([])
	})

	test('disambiguates two sources whose files share a name', async () => {
		const db = makeDb({
			adminListSources: [
				{ type: 'local', source: '/one/Admins.cfg' },
				{ type: 'local', source: '/two/Admins.cfg' },
			],
			adminIdentifyingPermissions: [],
		})
		await up(db)
		expect(Object.keys(readGlobal(db).adminLists).sort()).toEqual(['Admins', 'Admins-2'])
	})

	test('names an sftp source after its host and file', async () => {
		const db = makeDb({
			adminListSources: [{ type: 'sftp', host: 'box.example.com', filePath: '/cfg/Admins.cfg', username: 'u' }],
			adminIdentifyingPermissions: [],
		})
		await up(db)
		expect(Object.keys(readGlobal(db).adminLists)).toEqual(['Admins'])
	})

	test('an install with no sources gets an empty set rather than a broken one', async () => {
		const db = makeDb({ adminListSources: [], adminIdentifyingPermissions: [] }, { 'eu-1': {} })
		await up(db)
		expect(readGlobal(db).adminLists).toEqual({})
		expect(readServer(db, 'eu-1').adminLists).toEqual([])
	})

	test('is idempotent', async () => {
		const db = makeDb(
			{
				adminListSources: [{ type: 'local', source: 'Admins.cfg' }],
				adminIdentifyingPermissions: ['canseeadminchat'],
				rbac: { roles: { admins: { assignments: { includeIngameAdmins: true, adminListGroups: ['G'] } } } },
			},
			{ 'eu-1': {} },
		)
		await up(db)
		const once = JSON.stringify([readGlobal(db), readServer(db, 'eu-1')])
		await up(db)
		expect(JSON.stringify([readGlobal(db), readServer(db, 'eu-1')])).toEqual(once)
	})
})
