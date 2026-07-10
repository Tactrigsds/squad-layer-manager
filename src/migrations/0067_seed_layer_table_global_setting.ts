import type { MigrationDriver } from '@/server/migrate'

// `layerTable` moved out of the deploy-time JSONC config into admin-editable global settings
// (GlobalSettingsSchema.layerTable). Existing globalSettings rows have no `layerTable`, so without this
// seed the schema's prefault would replace this deployment's tuned column/menu config with the bland
// default on next load. Seed the value that was living in slm-config.jsonc so nothing is lost; new
// installs (no row yet, or already have the field) are untouched.
//
// `settings` is stored superjson-wrapped ({ json, meta }) inside a drizzle json(text) column. layerTable is
// all plain JSON (strings/objects), so the superjson `meta` never references it. Shape is inlined per the
// frozen-in-time migration rule.
const LAYER_TABLE = {
	orderedColumns: [
		{ name: 'id', visible: false },
		{ name: 'Size' },
		{ name: 'Layer' },
		{ name: 'Map', visible: false },
		{ name: 'Gamemode', visible: false },
		{ name: 'LayerVersion', visible: false },
		{ name: 'Faction_1' },
		{ name: 'Unit_1' },
		{ name: 'Alliance_1', visible: false },
		{ name: 'Faction_2' },
		{ name: 'Unit_2' },
		{ name: 'Alliance_2', visible: false },
		{ name: 'Balance_Differential' },
		{ name: 'Asymmetry_Score' },
	],
	defaultSortBy: { type: 'random' },
	// stored in the current (operator) node shape, not the legacy { column, code } shape, since the schema no
	// longer coerces on read (an `inrange` on the column with both bounds open)
	extraLayerSelectMenuItems: [
		{ type: 'inrange', neg: false, args: [{ type: 'column', column: 'Balance_Differential' }, { type: 'value' }, { type: 'value' }] },
		{ type: 'inrange', neg: false, args: [{ type: 'column', column: 'Asymmetry_Score' }, { type: 'value' }, { type: 'value' }] },
	],
	defaultExtraFilters: ['late-night-pool', 'seeding'],
}

export async function up(db: MigrationDriver): Promise<void> {
	const row = db.prepare(`SELECT settings FROM globalSettings WHERE id = 1`).get() as { settings: string } | undefined
	if (!row?.settings) return

	const wrapper = JSON.parse(row.settings) as { json?: any; meta?: any }
	if (!wrapper?.json || typeof wrapper.json !== 'object') return
	if (wrapper.json.layerTable !== undefined) return

	wrapper.json.layerTable = LAYER_TABLE
	db.prepare(`UPDATE globalSettings SET settings = ? WHERE id = 1`).run(JSON.stringify(wrapper))
}
