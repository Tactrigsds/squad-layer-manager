import type { MigrationDriver } from '@/server/migrate'

// The history page's persistence: saved queries (with retention rules), the events those rules keep past
// the retention period, and the id range of each archived match so id-bounded queries can prune without
// unpacking. minEventId/maxEventId stay null for matches packed before this migration.
export async function up(db: MigrationDriver): Promise<void> {
	db.exec(`ALTER TABLE archivedMatches ADD COLUMN minEventId INTEGER`)
	db.exec(`ALTER TABLE archivedMatches ADD COLUMN maxEventId INTEGER`)

	db.exec(`CREATE TABLE savedQueries (
		id TEXT PRIMARY KEY,
		name TEXT NOT NULL,
		ownerId TEXT NOT NULL REFERENCES users(discordId) ON DELETE CASCADE,
		visibility TEXT NOT NULL DEFAULT 'private',
		retain INTEGER NOT NULL DEFAULT 0,
		query TEXT NOT NULL,
		createdAt INTEGER NOT NULL,
		updatedAt INTEGER NOT NULL
	)`)
	db.exec(`CREATE INDEX savedQueriesOwnerIndex ON savedQueries (ownerId)`)

	db.exec(`CREATE TABLE retainedEvents (
		serverEventId INTEGER PRIMARY KEY,
		type TEXT NOT NULL,
		time INTEGER NOT NULL,
		matchId INTEGER NOT NULL REFERENCES matchHistory(id) ON DELETE CASCADE,
		serverId TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
		appEventId TEXT,
		version INTEGER,
		data TEXT NOT NULL
	)`)
	db.exec(`CREATE INDEX retainedEventsMatchIdIndex ON retainedEvents (matchId)`)

	db.exec(`CREATE TABLE retainedEventClaims (
		savedQueryId TEXT NOT NULL REFERENCES savedQueries(id) ON DELETE CASCADE,
		serverEventId INTEGER NOT NULL REFERENCES retainedEvents(serverEventId) ON DELETE CASCADE,
		PRIMARY KEY (savedQueryId, serverEventId)
	)`)
	db.exec(`CREATE INDEX retainedEventClaimsEventIndex ON retainedEventClaims (serverEventId)`)
}
