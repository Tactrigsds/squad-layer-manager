import type { MigrationDriver } from '@/server/migrate'

// Records which plugin queued a layer that got played. The queue item itself already carries its source in
// the servers.layerQueue json; this is the match history's copy of it, alongside setByUserId.
export async function up(db: MigrationDriver): Promise<void> {
	const columns = db.prepare(`PRAGMA table_info(matchHistory)`).all() as { name: string }[]
	if (columns.some((c) => c.name === 'setByPluginId')) return
	db.exec(`ALTER TABLE matchHistory ADD COLUMN setByPluginId text`)
}
