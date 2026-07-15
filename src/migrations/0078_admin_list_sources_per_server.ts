import type { MigrationDriver } from '@/server/migrate'

// Makes admin list sources fully server-specific. Previously the source definitions lived in a single global,
// name-keyed record (globalSettings.adminListSources) and each server referenced them by name (servers.adminListSources
// was a string[]). Now each server carries its own array of full source definitions ({ type, source }), and the global
// record is removed:
//   globalSettings.adminListSources: Record<name, { type, source }>   (deleted)
//   servers.adminListSources: string[]  ->  { type, source }[]        (names resolved against the old global record)
//
// Each server's referenced names are resolved against the global record; names that no longer resolve are dropped (they
// would have logged a warning and contributed nothing at fetch time). Without this migration the reshaped schema fails
// to validate the old string[] value on load, which would reset the affected server's settings.
//
// `settings` is stored superjson-wrapped ({ json, meta }) in a drizzle json(text) column; the values are plain
// strings/objects so the superjson `meta` never references them and is left untouched. Idempotent: a server whose
// adminListSources is already an array of objects (or is empty) is left alone, and the global key is only deleted when
// present. Shapes are inlined per the frozen-in-time migration rule.
export async function up(db: MigrationDriver): Promise<void> {
	const globalRow = db.prepare(`SELECT settings FROM globalSettings WHERE id = 1`).get() as { settings: string } | undefined
	const sourcesByName: Record<string, { type: string; source: string }> = {}
	if (globalRow?.settings) {
		const wrapper = JSON.parse(globalRow.settings) as { json?: any; meta?: any }
		const record = wrapper?.json?.adminListSources
		if (record && typeof record === 'object' && !Array.isArray(record)) {
			for (const [name, def] of Object.entries(record)) {
				if (def && typeof def === 'object') sourcesByName[name] = def as { type: string; source: string }
			}
		}
		if (wrapper?.json && 'adminListSources' in wrapper.json) {
			delete wrapper.json.adminListSources
			db.prepare(`UPDATE globalSettings SET settings = ? WHERE id = 1`).run(JSON.stringify(wrapper))
		}
	}

	const serverRows = db.prepare(`SELECT id, settings FROM servers`).all() as { id: string; settings: string | null }[]
	for (const row of serverRows) {
		if (!row.settings) continue
		const wrapper = JSON.parse(row.settings) as { json?: any; meta?: any }
		const sources = wrapper?.json?.adminListSources
		// only the old shape (an array of name strings) is converted; already-migrated object arrays are left alone
		if (!Array.isArray(sources) || !sources.every((s) => typeof s === 'string')) continue

		wrapper.json.adminListSources = (sources as string[])
			.map((name) => sourcesByName[name])
			.filter((def): def is { type: string; source: string } => def != null)
		db.prepare(`UPDATE servers SET settings = ? WHERE id = ?`).run(JSON.stringify(wrapper), row.id)
	}
}
