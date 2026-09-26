import DatabaseConstructor from 'better-sqlite3'
import zlib from 'node:zlib'
import superjson from 'superjson'
import { describe, expect, test } from 'vitest'

import { up } from './0115_server_event_index'

function makeDb() {
	const db = new DatabaseConstructor(':memory:')
	// as the runner has it (see _template.ts)
	db.pragma('foreign_keys = OFF')
	db.exec(`CREATE TABLE matchHistory (id INTEGER PRIMARY KEY, serverId TEXT NOT NULL)`)
	db.exec(`CREATE TABLE servers (id TEXT PRIMARY KEY)`)
	db.exec(
		`CREATE TABLE serverEvents (id INTEGER PRIMARY KEY, type TEXT NOT NULL, time INTEGER NOT NULL, matchId INTEGER NOT NULL, data TEXT NOT NULL)`,
	)
	db.exec(`CREATE TABLE damageSources (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE)`)
	db.exec(`CREATE TABLE playerEventIndex (
		playerId TEXT NOT NULL, time INTEGER NOT NULL, serverEventId INTEGER NOT NULL, assocType TEXT NOT NULL,
		matchId INTEGER NOT NULL, serverId TEXT NOT NULL, type TEXT NOT NULL, damageSourceId INTEGER, variant TEXT, channel TEXT,
		PRIMARY KEY (playerId, time, serverEventId, assocType)
	) WITHOUT ROWID`)
	db.exec(
		`CREATE TABLE archivedMatches (matchId INTEGER PRIMARY KEY, serverId TEXT NOT NULL, encoding TEXT NOT NULL, events BLOB NOT NULL)`,
	)
	return db
}

function readIndex(db: DatabaseConstructor.Database) {
	return db
		.prepare(
			`SELECT serverEventId, time, matchId, serverId, type, ds.name AS damageSource, variant, channel
			 FROM serverEventIndex LEFT JOIN damageSources ds ON ds.id = damageSourceId ORDER BY serverEventId`,
		)
		.all()
}

describe('0115_server_event_index', () => {
	test('indexes every event once, from the player index, the hot table and the archive', async () => {
		const db = makeDb()
		db.exec(`INSERT INTO matchHistory (id, serverId) VALUES (1, 'hot'), (2, 'cold')`)
		db.exec(`INSERT INTO damageSources (name) VALUES ('BP_AK74')`)
		// a kill with two players on it, which must still come out as one row
		const kill = superjson.stringify({ weapon: 'BP_AK74', variant: 'teamkill' })
		db.prepare(`INSERT INTO serverEvents (id, type, time, matchId, data) VALUES (1, 'PLAYER_DIED', 100, 1, ?)`).run(kill)
		db.exec(`INSERT INTO playerEventIndex VALUES
			('a', 100, 1, 'attacker', 1, 'hot', 'PLAYER_DIED', 1, 'teamkill', NULL),
			('b', 100, 1, 'victim', 1, 'hot', 'PLAYER_DIED', 1, 'teamkill', NULL)`)
		db.prepare(`INSERT INTO serverEvents (id, type, time, matchId, data) VALUES (2, 'NEW_GAME', 200, 1, ?)`).run(
			superjson.stringify({ layerId: 'X' }),
		)

		const archived = [
			{ id: 3, type: 'PLAYER_WOUNDED', time: 300, data: superjson.serialize({ weapon: 'BP_M4', variant: 'normal' }) },
			{ id: 4, type: 'CHAT_MESSAGE', time: 400, data: superjson.serialize({ channel: { type: 'ChatAdmin' } }) },
			{ id: 5, type: 'MAP_SET', time: 500, data: superjson.serialize({ layerId: 'Y' }) },
		]
		db.exec(`INSERT INTO playerEventIndex VALUES ('c', 400, 4, 'player', 2, 'cold', 'CHAT_MESSAGE', NULL, NULL, 'ChatAdmin')`)
		db.prepare(`INSERT INTO archivedMatches (matchId, serverId, encoding, events) VALUES (2, 'cold', 'zstd-json-v1', ?)`).run(
			zlib.zstdCompressSync(Buffer.from(JSON.stringify(archived))),
		)

		await up(db)
		expect(readIndex(db)).toEqual([
			{
				serverEventId: 1,
				time: 100,
				matchId: 1,
				serverId: 'hot',
				type: 'PLAYER_DIED',
				damageSource: 'BP_AK74',
				variant: 'teamkill',
				channel: null,
			},
			{ serverEventId: 2, time: 200, matchId: 1, serverId: 'hot', type: 'NEW_GAME', damageSource: null, variant: null, channel: null },
			{
				serverEventId: 3,
				time: 300,
				matchId: 2,
				serverId: 'cold',
				type: 'PLAYER_WOUNDED',
				damageSource: 'BP_M4',
				variant: 'normal',
				channel: null,
			},
			{
				serverEventId: 4,
				time: 400,
				matchId: 2,
				serverId: 'cold',
				type: 'CHAT_MESSAGE',
				damageSource: null,
				variant: null,
				channel: 'ChatAdmin',
			},
			{ serverEventId: 5, time: 500, matchId: 2, serverId: 'cold', type: 'MAP_SET', damageSource: null, variant: null, channel: null },
		])
	})
})
