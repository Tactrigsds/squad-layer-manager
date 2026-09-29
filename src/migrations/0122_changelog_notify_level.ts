import type { MigrationDriver } from '@/server/migrate'

// Replaces the changelog's notify on/off with a level ('off' | 'headline' | 'all'), and saves whether a user wants
// operator notes, which decides whether those count toward their unseen dot. Off stays off, on becomes 'headline'.
export async function up(db: MigrationDriver): Promise<void> {
	const columns = db.prepare(`PRAGMA table_info(changelogUserState)`).all() as { name: string }[]
	if (columns.some((c) => c.name === 'notifyLevel')) return
	db.exec(`ALTER TABLE changelogUserState ADD COLUMN notifyLevel text DEFAULT 'headline' NOT NULL`)
	db.exec(`ALTER TABLE changelogUserState ADD COLUMN showOperatorNotes integer DEFAULT false NOT NULL`)
	db.exec(`UPDATE changelogUserState SET notifyLevel = 'off' WHERE notify = 0`)
	db.exec(`ALTER TABLE changelogUserState DROP COLUMN notify`)
}
