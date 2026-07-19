import type { MigrationDriver } from '@/server/migrate'
import superjson from 'superjson'

// Removes seprately configured broadcasts
export async function up(db: MigrationDriver): Promise<void> {
	const row = db.prepare(`SELECT settings FROM globalSettings WHERE id = 1`).get() as { settings: string } | undefined
	if (!row?.settings) return

	const settings = superjson.parse(row.settings) as any
	delete settings.broadcasts
	db.prepare(`UPDATE globalSettings SET settings = ? WHERE id = 1`).run(superjson.stringify(settings))
}
