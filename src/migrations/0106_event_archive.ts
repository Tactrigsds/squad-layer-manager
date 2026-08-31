import type { MigrationDriver } from '@/server/migrate'

// Splits event storage into a hot window and a permanent index, so history stays searchable without
// keeping every event row relational forever.
//
//  - `playerEventIndex` replaces `playerEventAssociations`. Same association, plus the dimensions a search
//    filters on (time, match, server, type), and no FK to serverEvents -- which is the point: it has to
//    survive the compaction that deletes the row it refers to.
//  - `archivedMatches` holds compacted matches. Empty until the compaction job runs.
//  - `chatSearch` is an fts5 index over chat text, backfilled from what is currently stored.
//  - `damageSources` interns the Die()/Wound() `caused by` tokens playerEventIndex refers to.
//  - matchHistory gains the parsed layer parts, so a layer-config query over history never calls the
//    layer engine per row. Backfilled by the app (the engine isn't available here), see reconcileLayerParts.
export async function up(db: MigrationDriver): Promise<void> {
	for (const col of [
		'layerMap',
		'layerGamemode',
		'layerVersion',
		'layerTeam1Faction',
		'layerTeam1Unit',
		'layerTeam2Faction',
		'layerTeam2Unit',
	]) {
		db.exec(`ALTER TABLE matchHistory ADD COLUMN ${col} TEXT`)
	}
	db.exec(`CREATE INDEX matchHistoryLayerPartsIndex ON matchHistory (layerMap, layerGamemode)`)

	// pk order is the dominant query: one player's history, newest first. WITHOUT ROWID so the pk is the
	// table -- a player's whole trail is one contiguous range, not an index scan plus a row lookup.
	db.exec(`CREATE TABLE damageSources (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		name TEXT NOT NULL UNIQUE
	)`)
	db.exec(`CREATE TABLE playerEventIndex (
		playerId TEXT NOT NULL REFERENCES players(eosId) ON DELETE CASCADE,
		time INTEGER NOT NULL,
		serverEventId INTEGER NOT NULL,
		assocType TEXT NOT NULL,
		matchId INTEGER NOT NULL REFERENCES matchHistory(id) ON DELETE CASCADE,
		serverId TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
		type TEXT NOT NULL,
		damageSourceId INTEGER REFERENCES damageSources(id),
		variant TEXT,
		PRIMARY KEY (playerId, time, serverEventId, assocType)
	) WITHOUT ROWID`)

	db.exec(`CREATE TABLE archivedMatches (
		matchId INTEGER PRIMARY KEY REFERENCES matchHistory(id) ON DELETE CASCADE,
		serverId TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
		eventCount INTEGER NOT NULL,
		encoding TEXT NOT NULL,
		events BLOB NOT NULL,
		createdAt INTEGER NOT NULL
	)`)
	db.exec(`CREATE INDEX archivedMatchesServerIdIndex ON archivedMatches (serverId)`)

	// a squad's match, previously only reachable through the events referencing it -- which compaction deletes
	db.exec(`ALTER TABLE squads ADD COLUMN matchId INTEGER REFERENCES matchHistory(id) ON DELETE CASCADE`)
	db.exec(`CREATE INDEX squadMatchIdIndex ON squads (matchId)`)
	db.exec(`UPDATE squads SET matchId = (
		SELECT se.matchId FROM squadEventAssociations sea
		JOIN serverEvents se ON se.id = sea.serverEventId
		WHERE sea.squadId = squads.id
		ORDER BY se.id DESC LIMIT 1
	)`)

	// Chat text, searchable across all of history. Standalone rather than an external-content table over
	// serverEvents, for the same reason playerEventIndex carries no FK: compaction deletes the row the text
	// came from, and the index has to outlive it. Everything but `message` is UNINDEXED -- stored and
	// returned, but not tokenised.
	db.exec(`CREATE VIRTUAL TABLE chatSearch USING fts5(
		message,
		serverEventId UNINDEXED,
		playerId UNINDEXED,
		matchId UNINDEXED,
		serverId UNINDEXED,
		time UNINDEXED
	)`)
	db.exec(`INSERT INTO chatSearch (message, serverEventId, playerId, matchId, serverId, time)
		SELECT json_extract(se.data, '$.json.message'), se.id, json_extract(se.data, '$.json.player'), se.matchId, mh.serverId, se.time
		FROM serverEvents se
		JOIN matchHistory mh ON mh.id = se.matchId
		WHERE se.type = 'CHAT_MESSAGE' AND json_extract(se.data, '$.json.message') IS NOT NULL`)

	// INSERT OR IGNORE: the old table's uniqueness was (serverEventId, playerId, assocType) while the new pk
	// leads with time, so two events recorded in the same millisecond for the same player collapse only if
	// they also share an id, which they cannot.
	db.exec(`INSERT INTO damageSources (name)
		SELECT DISTINCT json_extract(data, '$.json.weapon') FROM serverEvents
		WHERE type IN ('PLAYER_DIED', 'PLAYER_WOUNDED') AND json_extract(data, '$.json.weapon') IS NOT NULL`)

	db.exec(`INSERT OR IGNORE INTO playerEventIndex (playerId, time, serverEventId, assocType, matchId, serverId, type, damageSourceId, variant)
		SELECT pea.playerId, se.time, se.id, pea.assocType, se.matchId, mh.serverId, se.type,
			w.id, json_extract(se.data, '$.json.variant')
		FROM playerEventAssociations pea
		JOIN serverEvents se ON se.id = pea.serverEventId
		JOIN matchHistory mh ON mh.id = se.matchId
		LEFT JOIN damageSources w ON w.name = json_extract(se.data, '$.json.weapon')`)

	db.exec(`DROP TABLE playerEventAssociations`)
}
