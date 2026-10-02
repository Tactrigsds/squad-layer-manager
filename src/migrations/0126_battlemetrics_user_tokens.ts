import type { MigrationDriver } from '@/server/migrate'

// A user's own battlemetrics personal access token, sealed like the integration tokens in the global settings.
export async function up(db: MigrationDriver): Promise<void> {
	db.exec(`
		CREATE TABLE IF NOT EXISTS battlemetricsUserTokens (
			userId text PRIMARY KEY NOT NULL REFERENCES users(discordId) ON DELETE CASCADE,
			token text NOT NULL,
			updatedAt integer NOT NULL
		)
	`)
}
