import superjson from 'superjson'

import type { MigrationDriver } from '@/server/migrate'

// battlemetrics:write-notes is new and gates adding notes to a player's BM profile. Every role that can write flags
// can already post notes through a flag's reason, so it gets this too, and a role that denies flags denies this as
// well: otherwise a `!write-flags` meant to strip a `*` role's flagging would let notes through.
//
// `*` already covers it, and a role that grants or denies it already is left alone. Idempotent: a second run finds
// the permission already there.
const FLAGS = 'battlemetrics:write-flags'
const NOTES = 'battlemetrics:write-notes'

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
		if (permissions.includes('*') || permissions.includes(NOTES) || permissions.includes(`!${NOTES}`)) continue
		if (permissions.includes(FLAGS)) cfg.permissions = [...permissions, NOTES]
		else if (permissions.includes(`!${FLAGS}`)) cfg.permissions = [...permissions, `!${NOTES}`]
		else continue
		changed = true
	}
	if (!changed) return
	db.prepare(`UPDATE globalSettings SET settings = ? WHERE id = ?`).run(superjson.stringify(settings), row.id)
}
