import type { MigrationDriver } from '@/server/migrate'

// The admin-action-reason shape changed (a shared `message` + `actionMessage` + `actions` list became a
// required warn text + per-action `actionTexts`). Old-shape rows can't satisfy the new schema and would fail
// the boot-time settings validation, so reset the list to empty (a deliberate "start fresh"). `broadcasts`,
// `messageVariables` and `requireReasonFor` are untouched.
//
// `settings` is stored superjson-wrapped ({ json, meta }) in a drizzle json(text) column; adminActionReasons
// is plain JSON, so the superjson `meta` never references it.
export async function up(db: MigrationDriver): Promise<void> {
	const row = db.prepare(`SELECT settings FROM globalSettings WHERE id = 1`).get() as { settings: string } | undefined
	if (!row?.settings) return

	const wrapper = JSON.parse(row.settings) as { json?: any; meta?: any }
	if (!wrapper?.json || typeof wrapper.json !== 'object') return
	if (wrapper.json.adminActionReasons === undefined) return

	wrapper.json.adminActionReasons = []
	db.prepare(`UPDATE globalSettings SET settings = ? WHERE id = 1`).run(JSON.stringify(wrapper))
}
