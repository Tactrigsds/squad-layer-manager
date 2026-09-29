import type { MigrationDriver } from '@/server/migrate'

// The in-app changelog: when this install first ran each entry, and where each user is in it. Both start empty.
// The first boot to see an empty changelogEntries stamps every entry it ships as old, so an existing install does
// not present its whole history as new.
export async function up(db: MigrationDriver): Promise<void> {
	db.exec(`
		CREATE TABLE IF NOT EXISTS changelogEntries (
			entryId text PRIMARY KEY NOT NULL,
			firstServedAt integer NOT NULL
		)
	`)
	db.exec(`
		CREATE TABLE IF NOT EXISTS changelogUserState (
			userId text PRIMARY KEY NOT NULL REFERENCES users(discordId) ON DELETE CASCADE,
			seenAt integer NOT NULL,
			notify integer DEFAULT true NOT NULL
		)
	`)
}
