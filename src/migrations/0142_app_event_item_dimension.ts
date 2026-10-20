import type { MigrationDriver } from '@/server/migrate'

// Adds the `item` dimension to appEventAssociations, so the layer history window can find every queue save that
// touched a queue item. Re-runs the backfill the way 0110 does, but only over the types that name items: older vote
// events carry no item id and gain nothing.
export async function up(db: MigrationDriver): Promise<void> {
	db.exec(`UPDATE appEvents SET feedVisible = NULL WHERE type IN ('QUEUE_UPDATED', 'MAP_SET')`)
}
