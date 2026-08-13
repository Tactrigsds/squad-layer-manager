import superjson from 'superjson'

import type { MigrationDriver } from '@/server/migrate'

// `allowedPrefixes` went from a list of strings to a list of `{ prefix, replyToUnknown }`, so a prefix shared with
// another bot can stop SLM warning admins about commands that were never meant for it.
//
// Existing installs keep the old behaviour (`replyToUnknown: true`); an admin turns it off per prefix afterwards.
export async function up(db: MigrationDriver): Promise<void> {
	const row = db.prepare(`SELECT settings FROM globalSettings WHERE id = 1`).get() as { settings: string } | undefined
	if (!row?.settings) return

	const settings = superjson.parse(row.settings) as any
	if (!Array.isArray(settings?.allowedPrefixes)) return

	settings.allowedPrefixes = settings.allowedPrefixes.map((p: unknown) =>
		typeof p === 'string' ? { prefix: p, replyToUnknown: true } : p,
	)

	db.prepare(`UPDATE globalSettings SET settings = ? WHERE id = 1`).run(superjson.stringify(settings))
}
