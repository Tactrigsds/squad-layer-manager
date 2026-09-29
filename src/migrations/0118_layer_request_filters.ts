import superjson from 'superjson'

import type { MigrationDriver } from '@/server/migrate'

// Seeds queue.mainPool.layerRequestFilters: { filterId, applyAs: 'regular'|'inverted' }[], the filters layer
// requests carry. Before it existed, requests carried the pool filter. The new list takes the pool's
// constrainGeneration entries if there are any, else the pool filter (include -> regular, exclude -> inverted),
// else nothing. Servers that already have the key, or have no mainPool (defaults apply), are left alone.
export async function up(db: MigrationDriver): Promise<void> {
	const rows = db.prepare(`SELECT id, settings FROM servers`).all() as { id: string; settings: string | null }[]
	const update = db.prepare(`UPDATE servers SET settings = ? WHERE id = ?`)
	for (const row of rows) {
		if (!row.settings) continue
		const settings = superjson.parse(row.settings) as { queue?: { mainPool?: Record<string, any> } } | null
		const mainPool = settings?.queue?.mainPool
		if (!mainPool || typeof mainPool !== 'object' || 'layerRequestFilters' in mainPool) continue

		let layerRequestFilters: { filterId: string; applyAs: 'regular' | 'inverted' }[] = []
		const constrainGeneration = Array.isArray(mainPool.constrainGeneration) ? mainPool.constrainGeneration : []
		if (constrainGeneration.length > 0) {
			layerRequestFilters = constrainGeneration.map((c: { filterId: string; applyAs: 'regular' | 'inverted' }) => ({
				filterId: c.filterId,
				applyAs: c.applyAs,
			}))
		} else if (mainPool.poolFilter?.filterId) {
			layerRequestFilters = [
				{ filterId: mainPool.poolFilter.filterId, applyAs: mainPool.poolFilter.mode === 'exclude' ? 'inverted' : 'regular' },
			]
		}
		mainPool.layerRequestFilters = layerRequestFilters
		update.run(superjson.stringify(settings), row.id)
	}
}
