import type { MigrationDriver } from '@/server/migrate'

// Adds the `user` dimension to appEventAssociations, so the history page can search by the SLM user an event
// is attributable to the same way it searches by player.
//
// No DDL: the sidecar is generic over `dimension` by design (see 0109), so a new dimension is an extractor and
// a new value. What it needs instead is for the extractors to be replayed over rows that predate them, and the
// backfill is driven by `feedVisible IS NULL`, so clearing the flag is what re-runs it. The re-inserted player
// and layer rows conflict onto themselves and are dropped, leaving only the user rows as new.
export async function up(db: MigrationDriver): Promise<void> {
	db.exec(`UPDATE appEvents SET feedVisible = NULL`)
}
