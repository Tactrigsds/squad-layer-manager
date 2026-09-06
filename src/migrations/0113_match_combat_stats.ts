import type { MigrationDriver } from '@/server/migrate'

// The per-team scoreline of a match: kills and wounds each side dealt, and the deaths each suffered. Columns
// rather than a blob so the history query engine can filter and order on them the way it does on tickets.
//
// Left empty rather than backfilled: attributing a kill to a team needs a full feed replay, which a migration
// must not reach into the app for. The server fills matches in as they enter the recent window instead
// (backfillCombatStats), so an upgraded install catches up over its first minutes rather than its downtime.
export async function up(db: MigrationDriver): Promise<void> {
	for (const team of [1, 2]) {
		for (const measure of ['Kills', 'Wounds', 'Deaths']) {
			db.exec(`ALTER TABLE matchHistory ADD COLUMN team${team}${measure} integer`)
		}
	}
}
