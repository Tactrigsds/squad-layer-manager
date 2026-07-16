import type { MigrationDriver } from '@/server/migrate'

// Replaces `playerFlagGroupings` with `playerGroupings`, keyed by grouping id. Before:
//   playerFlagGroupings: { modeIds: string[], groupings: { label, modeIds, associations: Record<flagId, number>, color }[] }
// After:
//   playerGroupings: Record<groupingId, { rules: { type: 'battlemetrics', flag, group }[], groups: Record<group, { color }> }>
//
// The old "display mode" is now the grouping itself, so each mode becomes one record entry holding only the groupings that
// referenced it. Numeric `associations` priorities are flattened into `rules` -- ordered across every grouping in the mode,
// which is how priority was compared before -- so array position now carries the priority.
//
// Without this migration the reshaped GlobalSettingsSchema fails to validate on load, which would reset EVERY global
// setting to defaults.
//
// `settings` is stored superjson-wrapped ({ json, meta }) in a drizzle json(text) column; we parse the TEXT, mutate the
// plain `.json` payload and write it back. All reshaped values are plain strings/arrays/objects, so the superjson `meta`
// (which only tags non-JSON types) never references them and is left untouched. Shapes are inlined per the
// frozen-in-time migration rule.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const DEFAULT_GROUP_COLOR = '#888888'

export async function up(db: MigrationDriver): Promise<void> {
	const row = db.prepare(`SELECT settings FROM globalSettings WHERE id = 1`).get() as { settings: string } | undefined
	if (!row?.settings) return

	const wrapper = JSON.parse(row.settings) as { json?: any; meta?: any }
	const json = wrapper?.json
	if (!json || typeof json !== 'object') return

	const old = json.playerFlagGroupings
	// idempotent: nothing to do once the key is gone, and the old value is always the { modeIds, groupings } object
	if (!old || typeof old !== 'object' || Array.isArray(old)) {
		if ('playerFlagGroupings' in json) {
			delete json.playerFlagGroupings
			db.prepare(`UPDATE globalSettings SET settings = ? WHERE id = 1`).run(JSON.stringify(wrapper))
		}
		return
	}

	const oldGroupings: any[] = Array.isArray(old.groupings) ? old.groupings : []

	// a grouping's mode may not have made it into the declared list, so take the union rather than trusting `modeIds`
	const groupingIds: string[] = []
	for (const modeId of [...(Array.isArray(old.modeIds) ? old.modeIds : []), ...oldGroupings.flatMap(g => g?.modeIds ?? [])]) {
		const id = String(modeId)
		if (id && !groupingIds.includes(id)) groupingIds.push(id)
	}

	// `color` used to mean either a flag id (take that flag's color) or a literal CSS color. A flag id can't be resolved
	// here (no BattleMetrics access from a migration), so those fall back to the neutral default and get re-picked by hand.
	const unresolvedColorGroups: string[] = []

	const playerGroupings: Record<string, { rules: any[]; groups: Record<string, { color: string }> }> = {}
	for (const groupingId of groupingIds) {
		const mine = oldGroupings.filter(g => (g?.modeIds ?? []).map(String).includes(groupingId))

		const flattened: { group: string; flag: string; priority: number }[] = []
		const groups: Record<string, { color: string }> = {}
		for (const g of mine) {
			const group = typeof g?.label === 'string' ? g.label.trim() : ''
			// the new rule schema requires a group name; an unlabelled grouping could never be told apart in the UI anyway
			if (!group) continue

			const rawColor = typeof g?.color === 'string' ? g.color : ''
			if (rawColor && UUID_RE.test(rawColor)) {
				groups[group] = { color: DEFAULT_GROUP_COLOR }
				unresolvedColorGroups.push(`${groupingId}/${group}`)
			} else {
				groups[group] = { color: rawColor || DEFAULT_GROUP_COLOR }
			}

			for (const [flag, priority] of Object.entries(g?.associations ?? {})) {
				flattened.push({ group, flag, priority: typeof priority === 'number' ? priority : 0 })
			}
		}

		flattened.sort((a, b) => a.priority - b.priority)
		playerGroupings[groupingId] = {
			rules: flattened.map(({ flag, group }) => ({ type: 'battlemetrics', flag, group })),
			groups,
		}
	}

	delete json.playerFlagGroupings
	json.playerGroupings = playerGroupings
	db.prepare(`UPDATE globalSettings SET settings = ? WHERE id = 1`).run(JSON.stringify(wrapper))

	if (unresolvedColorGroups.length > 0) {
		console.warn(
			`0081: these groups took their color from a flag, which cannot be resolved offline, so they were set to `
				+ `${DEFAULT_GROUP_COLOR}. Under Settings > Players & Flags > Player groupings, the reset button next to each group `
				+ `(Colors section) takes the color back from its flag: ${unresolvedColorGroups.join(', ')}`,
		)
	}
}
