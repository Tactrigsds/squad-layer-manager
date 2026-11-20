import superjson from 'superjson'

import type { MigrationDriver } from '@/server/migrate'

// Opens the help command to public chat where it still holds the old default of admin chat only. An install that
// chose admin-only on purpose cannot be told apart from one that kept the default, so both are opened.
export async function up(db: MigrationDriver): Promise<void> {
	const row = db.prepare(`SELECT id, settings FROM globalSettings ORDER BY id LIMIT 1`).get() as
		| { id: number; settings: string | null }
		| undefined
	if (!row?.settings) return
	const settings = superjson.parse<Record<string, any>>(row.settings)
	const help = settings?.commands?.help
	if (!help || typeof help !== 'object') return
	const chats = help.allowedChats
	if (!Array.isArray(chats) || chats.length !== 1 || chats[0] !== 'admin') return
	help.allowedChats = ['admin', 'public']
	db.prepare(`UPDATE globalSettings SET settings = ? WHERE id = ?`).run(superjson.stringify(settings), row.id)
}
