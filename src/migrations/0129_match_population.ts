import type { MigrationDriver } from '@/server/migrate'

// Each finished match's population samples, for the population chart's day and week ranges.
//
// Left empty rather than backfilled: sampling a match needs a full feed replay, which a migration must not reach
// into the app for. The server fills matches in, newest first, in the same pass that tallies scorelines.
export async function up(db: MigrationDriver): Promise<void> {
	db.exec(`
		CREATE TABLE IF NOT EXISTS matchPopulation (
			matchId integer PRIMARY KEY NOT NULL REFERENCES matchHistory(id) ON DELETE CASCADE,
			version integer NOT NULL,
			samples blob NOT NULL
		)
	`)
}
