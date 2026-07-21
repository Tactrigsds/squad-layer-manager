import type { MigrationDriver } from '@/server/migrate'

// Collapses the per-filter pool configuration into a single pool filter plus role lists.
//
// Old shape (servers.settings.json.queue):
//   mainPool.filters: Array<string | {
//     filterId, showIndicator?: 'regular'|'inverted'|'disabled'|'both',
//     defaultApplyDuringLayerSelection?: 'regular'|'inverted'|'disabled'|'hidden',
//     inPool?: 'regular'|'inverted'|'disabled', warn?: 'regular'|'inverted'|'disabled'
//   }>
//   generationPool.filters: Array<{ filterId, applyAs: 'regular'|'inverted'|'disabled' }>
//
// New shape:
//   mainPool.poolFilter: { filterId, mode: 'include'|'exclude' } | null   (first active inPool entry; extras dropped)
//   mainPool.indicateMatches: filterId[]      (showIndicator regular|both)
//   mainPool.indicateMisses: filterId[]       (showIndicator inverted|both)
//   mainPool.defaultSelectable: { filterId, applyAs: 'regular'|'inverted' }[]  (from defaultApplyDuringLayerSelection)
//   mainPool.warnFor: { filterId, applyAs }[] (from warn)
//   mainPool.constrainGeneration: { filterId, applyAs }[]  (from generationPool.filters)
//   mainPool.filters / generationPool.filters are deleted; repeatRules + applyMainPoolRepeatRules untouched.
//
// `settings` is stored superjson-wrapped ({ json, meta }); the touched values are plain objects/arrays so `meta`
// never references them. Idempotent: servers whose mainPool has no `filters` key are left alone.
export async function up(db: MigrationDriver): Promise<void> {
	const rows = db.prepare(`SELECT id, settings FROM servers`).all() as { id: string; settings: string | null }[]
	for (const row of rows) {
		if (!row.settings) continue
		const wrapper = JSON.parse(row.settings) as { json?: any; meta?: any }
		const queue = wrapper?.json?.queue
		const mainPool = queue?.mainPool
		if (!mainPool || !('filters' in mainPool)) continue

		const oldFilters: any[] = (Array.isArray(mainPool.filters) ? mainPool.filters : [])
			.map((f: any) => typeof f === 'string' ? { filterId: f } : f)
			.filter((f: any) => f && typeof f === 'object' && typeof f.filterId === 'string')

		let poolFilter: { filterId: string; mode: 'include' | 'exclude' } | null = null
		const indicateMatches: string[] = []
		const indicateMisses: string[] = []
		const defaultSelectable: { filterId: string; applyAs: string }[] = []
		const warnFor: { filterId: string; applyAs: string }[] = []
		const pushUnique = (list: { filterId: string }[] | string[], entry: any) => {
			const id = typeof entry === 'string' ? entry : entry.filterId
			if (!list.some((e: any) => (typeof e === 'string' ? e : e.filterId) === id)) list.push(entry)
		}

		for (const config of oldFilters) {
			if (!poolFilter && (config.inPool === 'regular' || config.inPool === 'inverted')) {
				poolFilter = { filterId: config.filterId, mode: config.inPool === 'regular' ? 'include' : 'exclude' }
			}
			if (config.showIndicator === 'regular' || config.showIndicator === 'both') pushUnique(indicateMatches, config.filterId)
			if (config.showIndicator === 'inverted' || config.showIndicator === 'both') pushUnique(indicateMisses, config.filterId)
			const applyAs = config.defaultApplyDuringLayerSelection
			if (applyAs === 'regular' || applyAs === 'inverted') pushUnique(defaultSelectable, { filterId: config.filterId, applyAs })
			if (config.warn === 'regular' || config.warn === 'inverted') pushUnique(warnFor, { filterId: config.filterId, applyAs: config.warn })
		}

		const constrainGeneration: { filterId: string; applyAs: string }[] = []
		const genPool = queue.generationPool
		if (genPool && Array.isArray(genPool.filters)) {
			for (const config of genPool.filters) {
				if (!config || typeof config.filterId !== 'string') continue
				if (config.applyAs === 'regular' || config.applyAs === 'inverted') {
					pushUnique(constrainGeneration, { filterId: config.filterId, applyAs: config.applyAs })
				}
			}
		}

		delete mainPool.filters
		if (genPool) delete genPool.filters
		Object.assign(mainPool, { poolFilter, indicateMatches, indicateMisses, defaultSelectable, warnFor, constrainGeneration })

		db.prepare(`UPDATE servers SET settings = ? WHERE id = ?`).run(JSON.stringify(wrapper), row.id)
	}
}
