import type { MigrationDriver } from '@/server/migrate'

// `updatesToSquadServerDisabled` stops being a boolean and becomes the reason itself: null when SLM is writing the
// rotation, otherwise `{ type: 'manual', by }` or `{ type: 'ingame-vote' }`. A disabled server can no longer be
// missing a reason, because there is nowhere left to put "disabled" without one.
//
// Nothing recorded who disabled updates before now, so every migrated row becomes manual with `by: null` rather than
// guessing at an actor. Only per-server settings carry the field; global settings hold no default for it.
//
// `settings` is stored superjson-wrapped ({ json, meta }) in a drizzle json(text) column. The old value was a plain
// boolean and the new one a plain object, so superjson's `meta` never referenced it and does not now.
export async function up(db: MigrationDriver): Promise<void> {
	const rows = db.prepare(`SELECT id, settings FROM servers`).all() as { id: string; settings: string | null }[]

	for (const row of rows) {
		if (!row.settings) continue
		const wrapper = JSON.parse(row.settings) as { json?: any; meta?: any }
		if (!wrapper?.json || typeof wrapper.json !== 'object') continue
		if (typeof wrapper.json.updatesToSquadServerDisabled !== 'boolean') continue

		wrapper.json.updatesToSquadServerDisabled = wrapper.json.updatesToSquadServerDisabled ? { type: 'manual', by: null } : null
		db.prepare(`UPDATE servers SET settings = ? WHERE id = ?`).run(JSON.stringify(wrapper), row.id)
	}
}
