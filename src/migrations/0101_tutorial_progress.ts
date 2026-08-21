import type { MigrationDriver } from '@/server/migrate'

// Where a user is in each tutorial, so a run can be resumed later and from another browser. Held per user rather
// than in localStorage, which is where completion used to live: finishing on one machine left every other one
// offering the tutorial as unstarted.
//
// stepId, not a step index: the step list is built per run from what the install supports, so the same index is a
// different step elsewhere. An id that no longer exists resolves to nothing and the reader starts over.
export async function up(db: MigrationDriver): Promise<void> {
	db.exec(`
		CREATE TABLE IF NOT EXISTS tutorialProgress (
			userId text NOT NULL REFERENCES users(discordId) ON DELETE CASCADE,
			scenarioId text NOT NULL,
			stepId text,
			completedAt integer,
			updatedAt integer NOT NULL,
			PRIMARY KEY (userId, scenarioId)
		)
	`)
}
