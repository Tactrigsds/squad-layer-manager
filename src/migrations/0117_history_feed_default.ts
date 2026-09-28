import type { MigrationDriver } from '@/server/migrate'

// An events query without a `feed` now means the DEFAULT feed filter rather than ALL, so a saved one that meant ALL
// spells it out. `query` is plain json, and a query without a `type` is an events query.
export async function up(db: MigrationDriver): Promise<void> {
	const rows = db.prepare(`SELECT id, query FROM savedQueries`).all() as { id: string; query: string }[]
	const update = db.prepare(`UPDATE savedQueries SET query = ? WHERE id = ?`)
	for (const row of rows) {
		const query = JSON.parse(row.query) as { type?: string; feed?: string }
		if ((query.type ?? 'events') !== 'events' || query.feed !== undefined) continue
		update.run(JSON.stringify({ ...query, feed: 'ALL' }), row.id)
	}
}
