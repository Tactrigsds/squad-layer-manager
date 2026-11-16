import type { MigrationDriver } from '@/server/migrate'

// Comments on a plugin's settings, keyed by dotted path into the plugin's settings document.
export async function up(db: MigrationDriver): Promise<void> {
	db.exec(`ALTER TABLE plugins ADD COLUMN comments TEXT NOT NULL DEFAULT '{"json":{}}'`)
}
