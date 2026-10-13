import superjson from 'superjson'

import type { MigrationDriver } from '@/server/migrate'

// Renames admin action reasons to message shorthands in the global settings:
//
//   adminActionReasons         ->  adminMessageShorthands
//   commands.listWarnReasons   ->  commands.listMessageShorthands
//
// Comments (keyed by dotted path) and role globalSettingsGrants paths on or below either key move with it.
// Idempotent: once renamed, neither old key is present.

const RENAMES: [from: string, to: string][] = [
	['adminActionReasons', 'adminMessageShorthands'],
	['commands.listWarnReasons', 'commands.listMessageShorthands'],
]

function renamePath(path: string): string {
	for (const [from, to] of RENAMES) {
		if (path === from || path.startsWith(`${from}.`)) return to + path.slice(from.length)
	}
	return path
}

export async function up(db: MigrationDriver): Promise<void> {
	const row = db.prepare(`SELECT id, settings FROM globalSettings ORDER BY id LIMIT 1`).get() as
		| { id: number; settings: string | null }
		| undefined
	if (!row?.settings) return
	const settings = superjson.parse<Record<string, any>>(row.settings)
	if (!settings || typeof settings !== 'object') return

	if ('adminActionReasons' in settings) {
		settings.adminMessageShorthands = settings.adminActionReasons
		delete settings.adminActionReasons
	}
	const commands = settings.commands
	if (commands && typeof commands === 'object' && 'listWarnReasons' in commands) {
		commands.listMessageShorthands = commands.listWarnReasons
		delete commands.listWarnReasons
	}

	const comments: Record<string, string> | undefined = settings.comments
	if (comments && typeof comments === 'object') {
		settings.comments = Object.fromEntries(Object.entries(comments).map(([path, comment]) => [renamePath(path), comment]))
	}

	const roles = settings.rbac?.roles
	if (roles && typeof roles === 'object') {
		for (const cfg of Object.values(roles) as { globalSettingsGrants?: unknown }[]) {
			if (!cfg || typeof cfg !== 'object' || !Array.isArray(cfg.globalSettingsGrants)) continue
			cfg.globalSettingsGrants = cfg.globalSettingsGrants.map((path: unknown) => (typeof path === 'string' ? renamePath(path) : path))
		}
	}

	db.prepare(`UPDATE globalSettings SET settings = ? WHERE id = ?`).run(superjson.stringify(settings), row.id)
}
