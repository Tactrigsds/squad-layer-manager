import type { MigrationDriver } from '@/server/migrate'

// Adds the per-server switch-request queue (player-initiated /switch): the match-scoped queue is persisted so an
// SLM restart mid-match keeps it. Stored superjson-wrapped like the other servers JSON columns; null when empty.
export async function up(db: MigrationDriver): Promise<void> {
	const columns = db.prepare(`PRAGMA table_info(servers)`).all() as { name: string }[]
	if (columns.some((c) => c.name === 'switchRequests')) return
	db.exec(`ALTER TABLE servers ADD COLUMN switchRequests text DEFAULT '{"json":null}'`)
}
