import zlib from 'node:zlib'

import type { MigrationDriver } from '@/server/migrate'

// Adds serverEventIndex, one row per server event, so the history engine can find the events that name no player
// (NEW_GAME, MAP_SET, ADMIN_BROADCAST, ...). playerEventIndex only ever held events with a player on them.
//
// Backfilled from every place an event can live, most complete first, each pass skipping what an earlier one
// wrote. playerEventIndex already carries every event-level column, interned damage source included. The hot
// table and the archive fill in the rest, which is mostly events with no player, plus any whose index rows were
// skipped for an unknown player. Indexes are built after the backfill, which is cheaper than maintaining them
// through it.
export async function up(db: MigrationDriver): Promise<void> {
	db.exec(`CREATE TABLE serverEventIndex (
		serverEventId INTEGER PRIMARY KEY,
		time INTEGER NOT NULL,
		matchId INTEGER NOT NULL REFERENCES matchHistory(id) ON DELETE CASCADE,
		serverId TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
		type TEXT NOT NULL,
		damageSourceId INTEGER REFERENCES damageSources(id),
		variant TEXT,
		channel TEXT
	)`)

	db.exec(`INSERT INTO serverEventIndex (serverEventId, time, matchId, serverId, type, damageSourceId, variant, channel)
		SELECT serverEventId, min(time), min(matchId), min(serverId), min(type), min(damageSourceId), min(variant), min(channel)
		FROM playerEventIndex GROUP BY serverEventId`)

	db.exec(`INSERT OR IGNORE INTO damageSources (name)
		SELECT DISTINCT json_extract(se.data, '$.json.weapon') FROM serverEvents se
		WHERE se.id NOT IN (SELECT serverEventId FROM serverEventIndex) AND json_extract(se.data, '$.json.weapon') IS NOT NULL`)
	db.exec(`INSERT OR IGNORE INTO serverEventIndex (serverEventId, time, matchId, serverId, type, damageSourceId, variant, channel)
		SELECT se.id, se.time, se.matchId, mh.serverId, se.type, w.id, json_extract(se.data, '$.json.variant'),
			CASE WHEN se.type = 'CHAT_MESSAGE' THEN json_extract(se.data, '$.json.channel.type') END
		FROM serverEvents se
		JOIN matchHistory mh ON mh.id = se.matchId
		LEFT JOIN damageSources w ON w.name = json_extract(se.data, '$.json.weapon')`)

	// the archive's encoding, inlined rather than imported like everything else here: what this migration
	// decoded must not change when the app's archive format gains a version
	const ENCODING = 'zstd-json-v1'
	type PackedEvent = {
		id: number
		type: string
		time: number
		data: { json?: { weapon?: string; variant?: string; channel?: { type?: string } } } | null
	}
	const archived = db.prepare(`SELECT matchId, serverId, events FROM archivedMatches WHERE encoding = ?`).all(ENCODING) as {
		matchId: number
		serverId: string
		events: Buffer
	}[]
	const indexed = db.prepare(`SELECT 1 FROM serverEventIndex WHERE serverEventId = ?`)
	const internSource = db.prepare(`INSERT OR IGNORE INTO damageSources (name) VALUES (?)`)
	const sourceId = db.prepare(`SELECT id FROM damageSources WHERE name = ?`)
	const insert = db.prepare(`INSERT OR IGNORE INTO serverEventIndex
		(serverEventId, time, matchId, serverId, type, damageSourceId, variant, channel) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
	for (const row of archived) {
		const packed = JSON.parse(zlib.zstdDecompressSync(row.events).toString('utf8')) as PackedEvent[]
		for (const event of packed) {
			if (indexed.get(event.id)) continue
			const json = event.data?.json
			let damageSourceId: number | null = null
			if (json?.weapon) {
				internSource.run(json.weapon)
				damageSourceId = (sourceId.get(json.weapon) as { id: number }).id
			}
			insert.run(
				event.id,
				event.time,
				row.matchId,
				row.serverId,
				event.type,
				damageSourceId,
				json?.variant ?? null,
				event.type === 'CHAT_MESSAGE' ? (json?.channel?.type ?? null) : null,
			)
		}
	}

	db.exec(`CREATE INDEX serverEventIndexTimeIndex ON serverEventIndex (time)`)
	db.exec(`CREATE INDEX serverEventIndexMatchIdIndex ON serverEventIndex (matchId)`)
	db.exec(`CREATE INDEX serverEventIndexTypeTimeIndex ON serverEventIndex (type, time)`)
}
