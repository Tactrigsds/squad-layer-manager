import type { MigrationDriver } from '@/server/migrate'

// `allowedPrefixes` went from a list of strings to a list of `{ prefix, replyToUnknown }`, so a prefix shared with
// another bot can stop SLM warning admins about commands that were never meant for it.
//
// Existing installs keep the old behaviour (`replyToUnknown: true`); an admin turns it off per prefix afterwards.
//
// `settings` is stored superjson-wrapped ({ json, meta }) in a drizzle json(text) column; allowedPrefixes is plain
// JSON, so superjson's `meta` never references it.
export async function up(db: MigrationDriver): Promise<void> {
	const row = db.prepare(`SELECT settings FROM globalSettings WHERE id = 1`).get() as { settings: string } | undefined
	if (!row?.settings) return

	const wrapper = JSON.parse(row.settings) as { json?: any; meta?: any }
	if (!wrapper?.json || typeof wrapper.json !== 'object') return
	const settings = wrapper.json
	if (!Array.isArray(settings.allowedPrefixes)) return

	settings.allowedPrefixes = settings.allowedPrefixes.map((p: unknown) =>
		typeof p === 'string' ? { prefix: p, replyToUnknown: true } : p,
	)

	db.prepare(`UPDATE globalSettings SET settings = ? WHERE id = 1`).run(JSON.stringify(wrapper))
}
