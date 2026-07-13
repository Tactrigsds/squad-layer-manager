import type { MigrationDriver } from '@/server/migrate'

// The `generation` block (columnOrder + weights) moved out of layer-db.json into admin-editable global settings
// (GlobalSettingsSchema.layerGeneration), so weights can be tuned from the settings page instead of by editing a
// file and restarting.
//
// This seeds the empty default rather than carrying the old values over: layer-db.json is gitignored,
// per-deployment config, and a migration must not depend on the filesystem it happens to run against. A deployment
// that had weights configured re-enters them under Settings -> Layer Generation Weights (the server logs a warning
// while the dead `generation` block is still in its layer-db.json).
//
// `settings` is stored superjson-wrapped ({ json, meta }) in a drizzle json(text) column. layerGeneration is plain
// JSON (strings/numbers/arrays), so superjson's `meta` never references it. Shape is inlined per the
// frozen-in-time rule.
const LAYER_GENERATION = {
	columnOrder: [],
	weights: {},
}

export async function up(db: MigrationDriver): Promise<void> {
	const row = db.prepare(`SELECT settings FROM globalSettings WHERE id = 1`).get() as { settings: string } | undefined
	if (!row?.settings) return

	const wrapper = JSON.parse(row.settings) as { json?: any; meta?: any }
	if (!wrapper?.json || typeof wrapper.json !== 'object') return
	if (wrapper.json.layerGeneration !== undefined) return

	wrapper.json.layerGeneration = LAYER_GENERATION
	db.prepare(`UPDATE globalSettings SET settings = ? WHERE id = 1`).run(JSON.stringify(wrapper))
}
