import type { MigrationDriver } from '@/server/migrate'

// Two related reshapes of globalSettings.settings for the Players & Flags settings:
//
// 1. Drops `playerFlagColorHierarchy` (the ordered flag-id list that used to pick a player's display color). Player
//    colors are now derived solely from `playerFlagGroupings`, so the key is removed.
//
// 2. Restructures `playerFlagGroupings` from a bare array of groupings into `{ modeIds, groupings }`, where `modeIds`
//    are the display modes declared upfront. Before:
//      playerFlagGroupings: { label, modeIds: string[], associations, color }[]
//    After:
//      playerFlagGroupings: { modeIds: string[], groupings: { label, modeIds, associations, color }[] }
//    The declared `modeIds` are seeded from the union of every grouping's `modeIds` (order preserved), so the modes that
//    were previously implied by the groupings stay selectable.
//
// Without this migration the reshaped GlobalSettingsSchema fails to validate on load (the old array value is not the new
// object), which would reset EVERY global setting to defaults.
//
// `settings` is stored superjson-wrapped ({ json, meta }) in a drizzle json(text) column; we parse the TEXT, mutate the
// plain `.json` payload and write it back. All reshaped values are plain strings/arrays/objects, so the superjson `meta`
// (which only tags non-JSON types) never references them and is left untouched. Shapes are inlined per the
// frozen-in-time migration rule.
export async function up(db: MigrationDriver): Promise<void> {
	const row = db.prepare(`SELECT settings FROM globalSettings WHERE id = 1`).get() as { settings: string } | undefined
	if (!row?.settings) return

	const wrapper = JSON.parse(row.settings) as { json?: any; meta?: any }
	const json = wrapper?.json
	if (!json || typeof json !== 'object') return

	let changed = false

	if ('playerFlagColorHierarchy' in json) {
		delete json.playerFlagColorHierarchy
		changed = true
	}

	const groupings = json.playerFlagGroupings
	// only convert the old array shape; the new object shape (or absence) is left alone (idempotent)
	if (Array.isArray(groupings)) {
		const modeIds: string[] = []
		const seen = new Set<string>()
		for (const group of groupings) {
			for (const modeId of (group?.modeIds ?? []) as unknown[]) {
				const str = String(modeId)
				if (!seen.has(str)) {
					seen.add(str)
					modeIds.push(str)
				}
			}
		}
		json.playerFlagGroupings = { modeIds, groupings }
		changed = true
	}

	if (changed) db.prepare(`UPDATE globalSettings SET settings = ? WHERE id = 1`).run(JSON.stringify(wrapper))
}
