import DatabaseConstructor from 'better-sqlite3'
import { describe, expect, test } from 'vitest'

import { up } from './0096_discord_accounts_and_link_provenance'

type Db = InstanceType<typeof DatabaseConstructor>

// The pre-migration shape, plus one of the tables that FKs into `users` -- rebuilding `users` must not disturb it.
function makeDb() {
	const db = new DatabaseConstructor(':memory:')
	// as the runner leaves it: rebuilding a table drops it, and enforcement would fire the inbound cascades
	db.pragma('foreign_keys = OFF')
	db.exec(`
		CREATE TABLE users (discordId TEXT PRIMARY KEY NOT NULL, username TEXT NOT NULL, nickname TEXT);
		CREATE TABLE linkedSteamAccounts (
			steam64Id TEXT PRIMARY KEY NOT NULL,
			discordId TEXT NOT NULL,
			createdAt INTEGER NOT NULL,
			FOREIGN KEY (discordId) REFERENCES users(discordId) ON DELETE cascade
		);
		CREATE INDEX linkedSteamDiscordIdIndex ON linkedSteamAccounts (discordId);
		CREATE TABLE filters (
			id TEXT PRIMARY KEY,
			owner TEXT REFERENCES users(discordId) ON DELETE set null
		);
	`)
	return db
}

function addUser(db: Db, discordId: string, username: string, nickname: string | null = null) {
	db.prepare(`INSERT INTO users (discordId, username, nickname) VALUES (?, ?, ?)`).run(discordId, username, nickname)
}

function addLink(db: Db, steam64Id: string, discordId: string, createdAt = 1_700_000_000_000) {
	db.prepare(`INSERT INTO linkedSteamAccounts (steam64Id, discordId, createdAt) VALUES (?, ?, ?)`).run(steam64Id, discordId, createdAt)
}

function columns(db: Db, table: string): string[] {
	return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name)
}

describe('0096_discord_accounts_and_link_provenance', () => {
	test('every user becomes a discord account carrying the username', async () => {
		const db = makeDb()
		addUser(db, '1', 'alice', 'Alice A')
		addUser(db, '2', 'bob')
		await up(db)

		const accounts = db.prepare(`SELECT discordId, username FROM discordAccounts ORDER BY discordId`).all()
		expect(accounts).toEqual([
			{ discordId: '1', username: 'alice' },
			{ discordId: '2', username: 'bob' },
		])
	})

	test('users keeps its rows and nicknames, and loses the username', async () => {
		const db = makeDb()
		addUser(db, '1', 'alice', 'Alice A')
		addUser(db, '2', 'bob')
		await up(db)

		expect(columns(db, 'users').sort()).toEqual(['discordId', 'nickname'])
		expect(db.prepare(`SELECT discordId, nickname FROM users ORDER BY discordId`).all()).toEqual([
			{ discordId: '1', nickname: 'Alice A' },
			{ discordId: '2', nickname: null },
		])
	})

	test('existing links migrate as self-serve, attributed to their own owner', async () => {
		const db = makeDb()
		addUser(db, '1', 'alice')
		addLink(db, '76561198000000001', '1', 1_700_000_000_000)
		await up(db)

		expect(db.prepare(`SELECT * FROM linkedSteamAccounts`).all()).toEqual([
			{ steam64Id: '76561198000000001', discordId: '1', origin: 'self-serve', linkedBy: '1', createdAt: 1_700_000_000_000 },
		])
	})

	test('rebuilding users leaves rows that reference it untouched', async () => {
		const db = makeDb()
		addUser(db, '1', 'alice')
		db.prepare(`INSERT INTO filters (id, owner) VALUES ('f', '1')`).run()
		await up(db)

		expect(db.prepare(`SELECT id, owner FROM filters`).all()).toEqual([{ id: 'f', owner: '1' }])
	})

	test('the link index survives the rebuild', async () => {
		const db = makeDb()
		await up(db)
		const indexes = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'linkedSteamAccounts'`).all()
		expect(indexes).toContainEqual({ name: 'linkedSteamDiscordIdIndex' })
	})

	test('is a noop on an already migrated db', async () => {
		const db = makeDb()
		addUser(db, '1', 'alice', 'Alice A')
		addLink(db, '76561198000000001', '1')
		await up(db)
		const accounts = db.prepare(`SELECT * FROM discordAccounts`).all()
		const links = db.prepare(`SELECT * FROM linkedSteamAccounts`).all()

		await up(db)

		expect(db.prepare(`SELECT * FROM discordAccounts`).all()).toEqual(accounts)
		expect(db.prepare(`SELECT * FROM linkedSteamAccounts`).all()).toEqual(links)
	})
})
