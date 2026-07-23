import type { MigrationDriver } from '@/server/migrate'

// Admin lists become global (one source of admins across all servers) instead of per-server. Hoist every server's
// adminListSources / adminIdentifyingPermissions into the single globalSettings row (unioned + deduped) and strip
// them from each server's settings.
//
// `settings` is stored superjson-wrapped ({ json, meta }); the touched values are plain arrays of primitives/plain
// objects, so `meta` never references them. Idempotent: once the servers have been stripped there is nothing left
// to collect, and the global row already carries the fields, so a second run is a no-op.
export async function up(db: MigrationDriver): Promise<void> {
	const sourceKey = (s: unknown) => JSON.stringify(s)
	const sources: unknown[] = []
	const seenSources = new Set<string>()
	const perms: string[] = []
	const seenPerms = new Set<string>()

	const serverRows = db.prepare(`SELECT id, settings FROM servers ORDER BY id`).all() as { id: string; settings: string | null }[]
	for (const row of serverRows) {
		if (!row.settings) continue
		const wrapper = JSON.parse(row.settings) as { json?: any; meta?: any }
		const json = wrapper?.json
		if (!json || typeof json !== 'object') continue

		if (Array.isArray(json.adminListSources)) {
			for (const src of json.adminListSources) {
				const key = sourceKey(src)
				if (seenSources.has(key)) continue
				seenSources.add(key)
				sources.push(src)
			}
		}
		if (Array.isArray(json.adminIdentifyingPermissions)) {
			for (const perm of json.adminIdentifyingPermissions) {
				if (typeof perm !== 'string' || seenPerms.has(perm)) continue
				seenPerms.add(perm)
				perms.push(perm)
			}
		}

		if (!('adminListSources' in json) && !('adminIdentifyingPermissions' in json)) continue
		delete json.adminListSources
		delete json.adminIdentifyingPermissions
		db.prepare(`UPDATE servers SET settings = ? WHERE id = ?`).run(JSON.stringify(wrapper), row.id)
	}

	const globalRow = db.prepare(`SELECT id, settings FROM globalSettings ORDER BY id LIMIT 1`).get() as
		| { id: number; settings: string | null }
		| undefined
	if (!globalRow?.settings) return
	const wrapper = JSON.parse(globalRow.settings) as { json?: any; meta?: any }
	if (!wrapper.json || typeof wrapper.json !== 'object') return
	// leave an existing global config alone (idempotent, and never clobber a manually-set global list)
	if ('adminListSources' in wrapper.json) return
	wrapper.json.adminListSources = sources
	wrapper.json.adminIdentifyingPermissions = perms
	db.prepare(`UPDATE globalSettings SET settings = ? WHERE id = ?`).run(JSON.stringify(wrapper), globalRow.id)
}
