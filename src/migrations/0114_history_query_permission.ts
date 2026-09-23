import superjson from 'superjson'

import type { MigrationDriver } from '@/server/migrate'

// history:query is new and gates the history page, its text and csv forms, and quoting a linked selection into
// discord. Until now anyone who could reach the site could query history, so every role that grants site access
// grants this too, and upgrading takes history away from no one.
//
// `*` already covers it, and a role that denies it outright is left denying it. Idempotent: a second run finds the
// permission already there.
const SITE = 'site:authorized'
const HISTORY = 'history:query'

export async function up(db: MigrationDriver): Promise<void> {
	const row = db.prepare(`SELECT id, settings FROM globalSettings ORDER BY id LIMIT 1`).get() as
		| { id: number; settings: string | null }
		| undefined
	if (!row?.settings) return
	const settings = superjson.parse(row.settings) as { rbac?: { roles?: Record<string, { permissions?: unknown }> } }
	const roles = settings?.rbac?.roles
	if (!roles || typeof roles !== 'object') return

	let changed = false
	for (const cfg of Object.values(roles)) {
		if (!cfg || typeof cfg !== 'object' || !Array.isArray(cfg.permissions)) continue
		const permissions = cfg.permissions as unknown[]
		if (!permissions.includes(SITE) || permissions.includes('*')) continue
		if (permissions.includes(HISTORY) || permissions.includes(`!${HISTORY}`)) continue
		cfg.permissions = [...permissions, HISTORY]
		changed = true
	}
	if (!changed) return
	db.prepare(`UPDATE globalSettings SET settings = ? WHERE id = ?`).run(superjson.stringify(settings), row.id)
}
