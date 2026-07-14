import type { MigrationDriver } from '@/server/migrate'

// Layer generation can now pick a matchup (the two teams as an unordered pair) as well as a single column, so
// `layerGeneration.columnOrder` is no longer only columns: it becomes `pickOrder`, and matchup weights get their
// own record alongside the per-column ones.
//
// Existing pick orders carry over as-is (every entry in them is a column, which is still a valid pick step).
//
// `settings` is stored superjson-wrapped ({ json, meta }) in a drizzle json(text) column. layerGeneration is plain
// JSON (strings/numbers/arrays/objects), so superjson's `meta` never references it. Shape is inlined per the
// frozen-in-time rule.
const MATCHUP_WEIGHTS = {
	AllianceMatchup: [],
	FactionMatchup: [],
	UnitMatchup: [],
	FactionUnitMatchup: [],
}

export async function up(db: MigrationDriver): Promise<void> {
	const row = db.prepare(`SELECT settings FROM globalSettings WHERE id = 1`).get() as { settings: string } | undefined
	if (!row?.settings) return

	const wrapper = JSON.parse(row.settings) as { json?: any; meta?: any }
	const generation = wrapper?.json?.layerGeneration
	if (!generation || typeof generation !== 'object') return

	generation.pickOrder ??= generation.columnOrder ?? []
	delete generation.columnOrder
	generation.matchupWeights ??= MATCHUP_WEIGHTS

	db.prepare(`UPDATE globalSettings SET settings = ? WHERE id = 1`).run(JSON.stringify(wrapper))
}
