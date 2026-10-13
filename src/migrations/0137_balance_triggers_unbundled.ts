import type { MigrationDriver } from '@/server/migrate'

// Balance triggers stopped shipping with SLM and became a separately installed plugin. 0104 still gives every
// database the plugin's settings row and events table, so where that table is empty there is nothing to keep, and
// this removes both rather than leave every new install listing leftover data for a plugin it never had. A database
// with recorded events keeps everything, for the package to adopt or for an admin to purge.
export async function up(db: MigrationDriver): Promise<void> {
	const table = db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'p_balance_triggers_events'`).get()
	if (table && db.prepare(`SELECT 1 FROM p_balance_triggers_events LIMIT 1`).get()) return
	db.exec(`DROP INDEX IF EXISTS p_balance_triggers_events_match`)
	db.exec(`DROP TABLE IF EXISTS p_balance_triggers_events`)
	if (db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '_plugin_migrations'`).get()) {
		db.exec(`DELETE FROM _plugin_migrations WHERE pluginId = 'balance-triggers'`)
	}
	db.exec(`DELETE FROM plugins WHERE id = 'balance-triggers'`)
}
