import type { MigrationDriver } from '@/server/migrate'

// The history page's persistence: saved queries, and the id range of each archived match so id-bounded
// queries can prune without unpacking. minEventId/maxEventId stay null for matches packed before this
// migration.
export async function up(db: MigrationDriver): Promise<void> {
	db.exec(`ALTER TABLE archivedMatches ADD COLUMN minEventId INTEGER`)
	db.exec(`ALTER TABLE archivedMatches ADD COLUMN maxEventId INTEGER`)

	db.exec(`CREATE TABLE savedQueries (
		id TEXT PRIMARY KEY,
		name TEXT NOT NULL,
		ownerId TEXT NOT NULL REFERENCES users(discordId) ON DELETE CASCADE,
		visibility TEXT NOT NULL DEFAULT 'private',
		query TEXT NOT NULL,
		createdAt INTEGER NOT NULL,
		updatedAt INTEGER NOT NULL
	)`)
	db.exec(`CREATE INDEX savedQueriesOwnerIndex ON savedQueries (ownerId)`)
}
