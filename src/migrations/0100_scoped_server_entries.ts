import type { MigrationDriver } from '@/server/migrate'

// Adds per-user server visibility. A 'scoped' server (ownerDiscordId set) is delivered to and usable by only its
// owner; in-app tutorials create one emulated server per user this way. Every existing server predates the column
// and is 'public'. ownerDiscordId is bigint stored as text, like every other discord id column.
export async function up(db: MigrationDriver): Promise<void> {
	const columns = db.prepare(`PRAGMA table_info(servers)`).all() as { name: string }[]
	if (!columns.some((c) => c.name === 'visibility')) {
		db.exec(`ALTER TABLE servers ADD COLUMN visibility text NOT NULL DEFAULT 'public'`)
	}
	if (!columns.some((c) => c.name === 'ownerDiscordId')) {
		db.exec(`ALTER TABLE servers ADD COLUMN ownerDiscordId text`)
	}
}
