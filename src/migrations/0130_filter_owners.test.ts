import DatabaseConstructor from 'better-sqlite3'
import { describe, expect, test } from 'vitest'

import { up } from './0130_filter_owners'

// the tables as they stood before 0130, trimmed to what it reads
function makeDb() {
	const db = new DatabaseConstructor(':memory:')
	// as the runner leaves it: with enforcement on, dropping the old table would cascade into the contributors
	db.pragma('foreign_keys = OFF')
	db.exec(`
		CREATE TABLE discordAccounts (discordId text PRIMARY KEY NOT NULL, username text NOT NULL, updatedAt integer NOT NULL);
		CREATE TABLE users (
			discordId text PRIMARY KEY NOT NULL,
			nickname text,
			FOREIGN KEY (discordId) REFERENCES discordAccounts(discordId) ON DELETE cascade
		);
		CREATE TABLE plugins (id text PRIMARY KEY);
		CREATE TABLE filters (
			id text PRIMARY KEY NOT NULL,
			name text NOT NULL,
			description text,
			filter text NOT NULL,
			owner text,
			alertMessage text,
			emoji text,
			invertedAlertMessage text,
			invertedEmoji text,
			FOREIGN KEY (owner) REFERENCES users(discordId) ON DELETE set null
		);
		CREATE TABLE filterUserContributors (
			filterId text NOT NULL REFERENCES filters(id) ON DELETE cascade,
			userId text NOT NULL REFERENCES users(discordId) ON DELETE cascade
		);
	`)
	return db
}

function addUser(db: DatabaseConstructor.Database, discordId: string, username: string) {
	db.prepare(`INSERT INTO discordAccounts (discordId, username, updatedAt) VALUES (?, ?, 0)`).run(discordId, username)
	db.prepare(`INSERT INTO users (discordId) VALUES (?)`).run(discordId)
}

function addFilter(db: DatabaseConstructor.Database, id: string, owner: string | null) {
	db.prepare(`INSERT INTO filters (id, name, filter, owner, emoji) VALUES (?, ?, '{}', ?, '🌲')`).run(id, id, owner)
}

function owners(db: DatabaseConstructor.Database) {
	return db.prepare(`SELECT id, ownerUserId, ownerPluginId FROM filters ORDER BY id`).all()
}

describe('0130_filter_owners', () => {
	test("a person's filter stays theirs, and the seeded and orphaned filters become SLM's", async () => {
		const db = makeDb()
		addUser(db, '1', 'SLM')
		addUser(db, '123456789012345678', 'alice')
		addFilter(db, 'seeded', '1')
		addFilter(db, 'alices', '123456789012345678')
		addFilter(db, 'orphaned', null)
		await up(db)

		expect(owners(db)).toEqual([
			{ id: 'alices', ownerUserId: '123456789012345678', ownerPluginId: null },
			{ id: 'orphaned', ownerUserId: null, ownerPluginId: null },
			{ id: 'seeded', ownerUserId: null, ownerPluginId: null },
		])
		expect(db.prepare(`SELECT name, emoji FROM filters WHERE id = 'alices'`).get()).toEqual({ name: 'alices', emoji: '🌲' })
		// the stand-in user and its account are gone, and alice is not
		expect(db.prepare(`SELECT discordId FROM users`).all()).toEqual([{ discordId: '123456789012345678' }])
		expect(db.prepare(`SELECT discordId FROM discordAccounts`).all()).toEqual([{ discordId: '123456789012345678' }])
	})

	test('keeps the stand-in user while another row still points at it', async () => {
		const db = makeDb()
		addUser(db, '1', 'SLM')
		addFilter(db, 'seeded', '1')
		db.prepare(`INSERT INTO filterUserContributors (filterId, userId) VALUES ('seeded', '1')`).run()
		await up(db)

		expect(db.prepare(`SELECT discordId FROM users`).all()).toEqual([{ discordId: '1' }])
		expect(db.prepare(`SELECT filterId, userId FROM filterUserContributors`).all()).toEqual([{ filterId: 'seeded', userId: '1' }])
	})

	test('refuses a filter owned by both a user and a plugin', async () => {
		const db = makeDb()
		addUser(db, '123456789012345678', 'alice')
		db.prepare(`INSERT INTO plugins (id) VALUES ('hello')`).run()
		await up(db)

		expect(() =>
			db
				.prepare(`INSERT INTO filters (id, name, filter, ownerUserId, ownerPluginId) VALUES ('both', 'both', '{}', ?, 'hello')`)
				.run('123456789012345678'),
		).toThrow(/CHECK constraint failed/)
	})

	test('running it twice changes nothing', async () => {
		const db = makeDb()
		addUser(db, '123456789012345678', 'alice')
		addFilter(db, 'alices', '123456789012345678')
		await up(db)
		await up(db)

		expect(owners(db)).toEqual([{ id: 'alices', ownerUserId: '123456789012345678', ownerPluginId: null }])
	})
})
