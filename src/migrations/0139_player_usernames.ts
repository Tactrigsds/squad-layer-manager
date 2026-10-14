import zlib from 'node:zlib'

import type { MigrationDriver } from '@/server/migrate'

// playerUsernames: every name a player has gone by, one row each time their stored name changed, so the player
// details window can list previous names and name search can find a player by one.
//
// Recorded by triggers on players rather than by the writers: two paths rewrite players.username (the event upsert
// and the rename on PLAYER_DETAILS_CHANGED), and a trigger fires only when the name actually changes, where the
// upsert runs for every seen player constantly. Each row is stamped with the row's modifiedAt, which the writers
// set to the time of the event that carried the name.
//
// Backfilled by replaying the name-bearing events, hot and archived, through the same rule the upsert applies: a
// join log only knows the tagless name, so it does not replace a stored tagged name that still ends in it.
//
// usernameSearch is rebuilt over these names instead of players. It drops usernameNoTag: every value that column
// takes is a suffix of some recorded username, so a substring search over the names already finds it.
export async function up(db: MigrationDriver): Promise<void> {
	db.exec(`CREATE TABLE playerUsernames (
		playerId TEXT NOT NULL REFERENCES players(eosId) ON DELETE CASCADE,
		time INTEGER NOT NULL,
		username TEXT NOT NULL,
		PRIMARY KEY (playerId, time, username)
	) WITHOUT ROWID`)

	backfill(db)

	db.exec(`DROP TRIGGER IF EXISTS playersUsernameSearchInsert`)
	db.exec(`DROP TRIGGER IF EXISTS playersUsernameSearchUpdate`)
	db.exec(`DROP TRIGGER IF EXISTS playersUsernameSearchDelete`)
	db.exec(`DROP TABLE IF EXISTS usernameSearch`)
	db.exec(`CREATE VIRTUAL TABLE usernameSearch USING fts5(
		username,
		eosId UNINDEXED,
		tokenize='trigram'
	)`)
	db.exec(`INSERT INTO usernameSearch (username, eosId) SELECT DISTINCT username, playerId FROM playerUsernames`)

	const now = `CAST(unixepoch('subsec') * 1000 AS INTEGER)`
	db.exec(`CREATE TRIGGER playersUsernameHistoryInsert AFTER INSERT ON players BEGIN
		INSERT OR IGNORE INTO playerUsernames (playerId, time, username)
		VALUES (new.eosId, coalesce(new.modifiedAt, new.createdAt, ${now}), new.username);
	END`)
	db.exec(`CREATE TRIGGER playersUsernameHistoryUpdate AFTER UPDATE OF username ON players
		WHEN new.username IS NOT old.username
	BEGIN
		INSERT OR IGNORE INTO playerUsernames (playerId, time, username)
		VALUES (new.eosId, coalesce(new.modifiedAt, ${now}), new.username);
	END`)
	// a name the player has gone by before is already indexed
	db.exec(`CREATE TRIGGER playerUsernamesSearchInsert AFTER INSERT ON playerUsernames
		WHEN NOT EXISTS (
			SELECT 1 FROM playerUsernames WHERE playerId = new.playerId AND username = new.username AND time <> new.time
		)
	BEGIN
		INSERT INTO usernameSearch (username, eosId) VALUES (new.username, new.playerId);
	END`)
	db.exec(`CREATE TRIGGER playersUsernameSearchDelete AFTER DELETE ON players BEGIN
		DELETE FROM usernameSearch WHERE eosId = old.eosId;
	END`)
}

// A name as one event reported it. `joinLog` marks a player whose username is their tagless name, which is all a
// join log knows.
type Observation = { time: number; id: number; username: string; joinLog: boolean }

type PlayerJson = { ids?: { eos?: string; username?: string; usernameNoTag?: string } }
type EventJson = { player?: PlayerJson | string; newUsername?: string }

const NAMED_EVENT_TYPES = ['PLAYER_CONNECTED', 'PLAYER_RECONCILED', 'PLAYER_DETAILS_CHANGED']

function backfill(db: MigrationDriver) {
	const byPlayer = new Map<string, Observation[]>()
	// one player's name repeats on every event of a match, so only a change within the match is kept
	let lastInMatch = new Map<string, string>()
	const observe = (id: number, type: string, time: number, json: EventJson | undefined) => {
		const player = json?.player
		if (!player) return
		let eos: string | undefined
		let obs: Observation | undefined
		if (type === 'PLAYER_DETAILS_CHANGED') {
			eos = typeof player === 'string' ? player : player.ids?.eos
			if (json.newUsername) obs = { time, id, username: json.newUsername, joinLog: false }
		} else if (typeof player === 'object' && player.ids?.username) {
			eos = player.ids.eos
			obs = { time, id, username: player.ids.username, joinLog: player.ids.username === player.ids.usernameNoTag }
		}
		if (!eos || !obs) return
		const key = `${obs.joinLog ? 'j' : 'n'}${obs.username}`
		if (lastInMatch.get(eos) === key) return
		lastInMatch.set(eos, key)
		let list = byPlayer.get(eos)
		if (!list) byPlayer.set(eos, (list = []))
		list.push(obs)
	}

	// the archive's encoding, inlined: what this migration decoded must not change when the app's format gains a version
	const ENCODING = 'zstd-json-v1'
	type PackedEvent = { id: number; type: string; time: number; data: { json?: EventJson } | null }
	const archived = db.prepare(`SELECT events FROM archivedMatches WHERE encoding = ?`).iterate(ENCODING) as Iterable<{ events: Buffer }>
	for (const row of archived) {
		lastInMatch = new Map()
		const packed = JSON.parse(zlib.zstdDecompressSync(row.events).toString('utf8')) as PackedEvent[]
		for (const e of packed) {
			if (NAMED_EVENT_TYPES.includes(e.type)) observe(e.id, e.type, e.time, e.data?.json)
		}
	}

	const hot = db
		.prepare(
			`SELECT id, type, time, matchId, data FROM serverEvents WHERE type IN (${NAMED_EVENT_TYPES.map(() => '?').join(',')}) ORDER BY matchId, id`,
		)
		.iterate(...NAMED_EVENT_TYPES) as Iterable<{ id: number; type: string; time: number; matchId: number; data: string }>
	let matchId: number | null = null
	for (const row of hot) {
		if (row.matchId !== matchId) {
			matchId = row.matchId
			lastInMatch = new Map()
		}
		observe(row.id, row.type, row.time, (JSON.parse(row.data) as { json?: EventJson }).json)
	}

	const insert = db.prepare(`INSERT OR IGNORE INTO playerUsernames (playerId, time, username) VALUES (?, ?, ?)`)
	// read whole rather than iterated: better-sqlite3 refuses the inserts while an iterator is open
	const players = db.prepare(`SELECT eosId, username, createdAt, modifiedAt FROM players`).all() as Iterable<{
		eosId: string
		username: string
		createdAt: number | null
		modifiedAt: number | null
	}>
	const now = Date.now()
	for (const player of players) {
		const observations = byPlayer.get(player.eosId) ?? []
		observations.sort((a, b) => a.time - b.time || a.id - b.id)
		let current: string | null = null
		for (const obs of observations) {
			const next: string = obs.joinLog && current !== null && current.endsWith(obs.username) ? current : obs.username
			if (next === current) continue
			insert.run(player.eosId, obs.time, next)
			current = next
		}
		// the stored name is the truth where the events fall short of it, as for a player only a timeout recorded
		if (current !== player.username) {
			const lastTime = observations.at(-1)?.time ?? 0
			insert.run(player.eosId, Math.max(player.modifiedAt ?? player.createdAt ?? now, lastTime + 1), player.username)
		}
	}
}
