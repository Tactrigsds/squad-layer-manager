import type { MigrationDriver } from '@/server/migrate'

// Adds the `vote` dimension to appEventAssociations, so the history page can search vote events by their kind,
// outcome, voters, choices and winner. Re-runs the backfill the way 0142 does, over the vote events. Those recorded
// before this have no voter type or choice labels, so they gain only their kind and outcome.
export async function up(db: MigrationDriver): Promise<void> {
	db.exec(`UPDATE appEvents SET feedVisible = NULL WHERE type IN ('VOTE_STARTED', 'VOTE_ENDED', 'VOTE_ABORTED')`)
}
