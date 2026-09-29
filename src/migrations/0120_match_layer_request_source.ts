import type { MigrationDriver } from '@/server/migrate'

// Records who asked for a layer that got played, when a layer request put it in the queue. A superjson string
// of { discordId?: bigint, steamId?: string, origin?: 'gui' | 'chat' }[], set only when setByType is 'layer-request'.
export async function up(db: MigrationDriver): Promise<void> {
	const columns = db.prepare(`PRAGMA table_info(matchHistory)`).all() as { name: string }[]
	if (columns.some((c) => c.name === 'setByRequesters')) return
	db.exec(`ALTER TABLE matchHistory ADD COLUMN setByRequesters text`)
}
