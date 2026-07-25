import type { MigrationDriver } from '@/server/migrate'

// `commands[id].scopes` becomes `commands[id].allowedChats`. The values are unchanged ('admin' | 'public', each a
// group of in-game chat channels); only the field name was wrong. "Scope" reads as a permission, which this is not:
// it says which chats accept the command, and being in admin chat is not authorization on its own.
//
// `settings` is stored superjson-wrapped ({ json, meta }) in a drizzle json(text) column; both keys are plain JSON,
// so superjson's `meta` never references them.
export async function up(db: MigrationDriver): Promise<void> {
	const row = db.prepare(`SELECT settings FROM globalSettings WHERE id = 1`).get() as { settings: string } | undefined
	if (!row?.settings) return

	const wrapper = JSON.parse(row.settings) as { json?: any; meta?: any }
	if (!wrapper?.json || typeof wrapper.json !== 'object') return
	const commands = wrapper.json.commands
	if (!commands || typeof commands !== 'object') return

	for (const cmd of Object.values<any>(commands)) {
		if (!cmd || typeof cmd !== 'object' || !('scopes' in cmd)) continue
		cmd.allowedChats = Array.isArray(cmd.scopes) ? cmd.scopes.filter((s: unknown) => s === 'admin' || s === 'public') : []
		delete cmd.scopes
	}

	db.prepare(`UPDATE globalSettings SET settings = ? WHERE id = 1`).run(JSON.stringify(wrapper))
}
