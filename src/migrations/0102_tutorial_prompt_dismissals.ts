import type { MigrationDriver } from '@/server/migrate'

// A page offers its tutorials in a dialog when it opens. This is the record of a user telling one to stop, kept
// per user for the same reason progress is: dismissing on one machine should hold on the next.
export async function up(db: MigrationDriver): Promise<void> {
	db.exec(`
		CREATE TABLE IF NOT EXISTS tutorialPromptDismissals (
			userId text NOT NULL REFERENCES users(discordId) ON DELETE CASCADE,
			surfaceId text NOT NULL,
			dismissedAt integer NOT NULL,
			PRIMARY KEY (userId, surfaceId)
		)
	`)
}
