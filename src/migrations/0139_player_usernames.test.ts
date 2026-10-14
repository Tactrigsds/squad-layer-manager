import DatabaseConstructor from 'better-sqlite3'
import zlib from 'node:zlib'
import superjson from 'superjson'
import { describe, expect, test } from 'vitest'

import { up } from './0139_player_usernames'

type Db = DatabaseConstructor.Database

function makeDb() {
	const db = new DatabaseConstructor(':memory:')
	db.exec(`
		CREATE TABLE players (eosId TEXT PRIMARY KEY NOT NULL, steamId TEXT, epicId TEXT, username TEXT NOT NULL,
			usernameNoTag TEXT, createdAt INTEGER, modifiedAt INTEGER);
		CREATE TABLE serverEvents (id INTEGER PRIMARY KEY, type TEXT NOT NULL, time INTEGER NOT NULL, matchId INTEGER NOT NULL,
			appEventId TEXT, version INTEGER, data TEXT);
		CREATE TABLE archivedMatches (matchId INTEGER PRIMARY KEY, serverId TEXT NOT NULL, eventCount INTEGER NOT NULL,
			encoding TEXT NOT NULL, events BLOB NOT NULL);
		CREATE VIRTUAL TABLE usernameSearch USING fts5(username, usernameNoTag, eosId UNINDEXED, tokenize='trigram');
	`)
	return db
}

const player = (eos: string, username: string, usernameNoTag?: string) => ({ ids: { eos, username, usernameNoTag } })

type RawEvent = { id: number; type: string; time: number; json: Record<string, unknown> }

function insertHot(db: Db, matchId: number, events: RawEvent[]) {
	const insert = db.prepare(`INSERT INTO serverEvents (id, type, time, matchId, data) VALUES (?, ?, ?, ?, ?)`)
	for (const e of events) insert.run(e.id, e.type, e.time, matchId, superjson.stringify(e.json))
}

function insertArchived(db: Db, matchId: number, events: RawEvent[]) {
	const packed = events.map((e) => ({
		id: e.id,
		type: e.type,
		time: e.time,
		appEventId: null,
		version: null,
		data: superjson.serialize(e.json),
	}))
	const blob = zlib.zstdCompressSync(Buffer.from(JSON.stringify(packed), 'utf8'))
	db.prepare(`INSERT INTO archivedMatches (matchId, serverId, eventCount, encoding, events) VALUES (?, 's', ?, 'zstd-json-v1', ?)`).run(
		matchId,
		events.length,
		blob,
	)
}

function insertPlayer(db: Db, eosId: string, username: string, time: number, usernameNoTag: string | null = null) {
	db.prepare(`INSERT INTO players (eosId, username, usernameNoTag, createdAt, modifiedAt) VALUES (?, ?, ?, ?, ?)`).run(
		eosId,
		username,
		usernameNoTag,
		time,
		time,
	)
}

const history = (db: Db, eosId: string) =>
	db.prepare(`SELECT time, username FROM playerUsernames WHERE playerId = ? ORDER BY time`).all(eosId) as {
		time: number
		username: string
	}[]

const search = (db: Db, needle: string) =>
	(
		db.prepare(`SELECT eosId FROM usernameSearch WHERE usernameSearch MATCH ? ORDER BY eosId`).all(`"${needle}"`) as { eosId: string }[]
	).map((r) => r.eosId)

describe('0139_player_usernames', () => {
	test('backfills name changes from archived and hot events', async () => {
		const db = makeDb()
		insertPlayer(db, 'p1', 'Alpha', 50)
		// archived match 1: joins as Alpha, renames to Bravo mid-match
		insertArchived(db, 1, [
			{ id: 1, type: 'PLAYER_CONNECTED', time: 100, json: { player: player('p1', 'Alpha', 'Alpha') } },
			{ id: 2, type: 'PLAYER_DETAILS_CHANGED', time: 150, json: { player: 'p1', newUsername: 'Bravo', details: {} } },
			{ id: 3, type: 'CHAT_MESSAGE', time: 160, json: { player: 'p1', message: 'hi' } },
		])
		// hot match 2: back to Alpha
		insertHot(db, 2, [{ id: 10, type: 'PLAYER_CONNECTED', time: 300, json: { player: player('p1', 'Alpha', 'Alpha') } }])

		await up(db)

		expect(history(db, 'p1')).toEqual([
			{ time: 100, username: 'Alpha' },
			{ time: 150, username: 'Bravo' },
			{ time: 300, username: 'Alpha' },
		])
	})

	test('a join log does not replace a tagged name that still ends in its tagless name', async () => {
		const db = makeDb()
		insertPlayer(db, 'p1', '[TT] grey', 50, 'grey')
		insertHot(db, 1, [
			{ id: 1, type: 'PLAYER_RECONCILED', time: 100, json: { player: player('p1', '[TT] grey') } },
			{ id: 2, type: 'PLAYER_CONNECTED', time: 200, json: { player: player('p1', 'grey', 'grey') } },
		])
		insertHot(db, 2, [{ id: 3, type: 'PLAYER_CONNECTED', time: 300, json: { player: player('p1', '[ABC] grey') } }])
		insertHot(db, 3, [{ id: 4, type: 'PLAYER_RECONCILED', time: 400, json: { player: player('p1', '[TT] grey') } }])

		await up(db)

		expect(history(db, 'p1').map((r) => r.username)).toEqual(['[TT] grey', '[ABC] grey', '[TT] grey'])
	})

	test('orders events by time across matches, not by match', async () => {
		const db = makeDb()
		insertPlayer(db, 'p1', 'Charlie', 50)
		// match 1 on one server outlives match 2 on another, and the player comes back to it
		insertHot(db, 1, [
			{ id: 1, type: 'PLAYER_CONNECTED', time: 100, json: { player: player('p1', 'Alpha') } },
			{ id: 3, type: 'PLAYER_CONNECTED', time: 300, json: { player: player('p1', 'Charlie') } },
		])
		insertHot(db, 2, [{ id: 2, type: 'PLAYER_CONNECTED', time: 200, json: { player: player('p1', 'Bravo') } }])

		await up(db)

		expect(history(db, 'p1').map((r) => r.username)).toEqual(['Alpha', 'Bravo', 'Charlie'])
	})

	test('falls back to the stored name where no event names the player', async () => {
		const db = makeDb()
		insertPlayer(db, 'p1', 'Lonely', 50)
		insertPlayer(db, 'p2', 'Renamed', 500)
		insertHot(db, 1, [{ id: 1, type: 'PLAYER_CONNECTED', time: 100, json: { player: player('p2', 'Original') } }])

		await up(db)

		expect(history(db, 'p1')).toEqual([{ time: 50, username: 'Lonely' }])
		expect(history(db, 'p2')).toEqual([
			{ time: 100, username: 'Original' },
			{ time: 500, username: 'Renamed' },
		])
	})

	test('clears a tagless name the username no longer ends in', async () => {
		const db = makeDb()
		insertPlayer(db, 'stale', 'Bo', 50, 'Smelly Pee')
		insertPlayer(db, 'tagged', '[TT] grey', 50, 'grey')

		await up(db)

		const noTag = (eosId: string) =>
			(db.prepare(`SELECT usernameNoTag FROM players WHERE eosId = ?`).get(eosId) as { usernameNoTag: string | null }).usernameNoTag
		expect(noTag('stale')).toBeNull()
		expect(noTag('tagged')).toBe('grey')
	})

	test('records later changes and finds players by any name they have had', async () => {
		const db = makeDb()
		insertPlayer(db, 'p1', 'Alpha', 50)
		insertPlayer(db, 'p2', 'Zulu', 50)
		await up(db)

		db.prepare(`UPDATE players SET username = 'Bravo', modifiedAt = 100 WHERE eosId = 'p1'`).run()
		// an upsert that leaves the name alone records nothing
		db.prepare(`UPDATE players SET username = 'Bravo', modifiedAt = 150 WHERE eosId = 'p1'`).run()
		db.prepare(`UPDATE players SET username = 'Alpha', modifiedAt = 200 WHERE eosId = 'p1'`).run()
		insertPlayer(db, 'p3', 'Alphabet', 300)

		expect(history(db, 'p1')).toEqual([
			{ time: 50, username: 'Alpha' },
			{ time: 100, username: 'Bravo' },
			{ time: 200, username: 'Alpha' },
		])
		expect(history(db, 'p3')).toEqual([{ time: 300, username: 'Alphabet' }])
		expect(search(db, 'Bra')).toEqual(['p1'])
		expect(search(db, 'Alph')).toEqual(['p1', 'p3'])
		// taking back a previous name does not index it twice
		expect(db.prepare(`SELECT count(*) AS n FROM usernameSearch WHERE eosId = 'p1'`).get()).toEqual({ n: 2 })
	})
})
