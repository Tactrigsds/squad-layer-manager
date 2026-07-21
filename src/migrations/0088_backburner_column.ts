import type { MigrationDriver } from '@/server/migrate'

// Adds the per-server layer backburner (in-game "layer requests"): an ordered list of layer templates
// consumed by autogeneration. Stored superjson-wrapped like the other servers JSON columns.
export async function up(db: MigrationDriver): Promise<void> {
	const columns = db.prepare(`PRAGMA table_info(servers)`).all() as { name: string }[]
	if (columns.some(c => c.name === 'backburner')) return
	db.exec(`ALTER TABLE servers ADD COLUMN backburner text NOT NULL DEFAULT '{"json":[]}'`)
}
