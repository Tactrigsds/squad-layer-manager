import type { MigrationDriver } from '@/server/migrate'

// squad-server:view now gates the per-server reads (the dashboard, its streams, and which servers are listed at all).
// Holding any other server-scoped permission implies it (see RBAC.canViewServer), so a role that can touch a server
// keeps seeing it with no change here.
//
// What does need fixing is the read-only role: one holding site:authorized and nothing server-scoped could watch every
// dashboard before, and would silently lose all of them. Those get an explicit grant.
//
// Idempotent: a role that already lists it, or holds something that implies it, is skipped.
const IMPLIES_VIEW = [
	'squad-server:view',
	'queue:write',
	'queue:force-write',
	'queue:manage-all-notes',
	'vote:manage',
	'squad-server:end-match',
	'squad-server:disable-slm-updates',
	'squad-server:turn-fog-off',
	'squad-server:manage-players',
	'squad-server:warn-players',
	'squad-server:broadcast',
	'squad-server:kick-players',
]

export async function up(db: MigrationDriver): Promise<void> {
	const row = db.prepare(`SELECT id, settings FROM globalSettings ORDER BY id LIMIT 1`).get() as
		| { id: number; settings: string | null }
		| undefined
	if (!row?.settings) return
	const wrapper = JSON.parse(row.settings) as { json?: any; meta?: any }
	const roles = wrapper?.json?.rbac?.roles
	if (!roles || typeof roles !== 'object') return

	let changed = false
	for (const cfg of Object.values(roles) as any[]) {
		if (!cfg || typeof cfg !== 'object') continue
		const permissions: unknown = cfg.permissions
		if (!Array.isArray(permissions)) continue
		// `*` already expands to every permission
		if (permissions.includes('*')) continue
		if (!permissions.includes('site:authorized')) continue
		if (permissions.some((p) => typeof p === 'string' && IMPLIES_VIEW.includes(p))) continue
		// a serverGrants entry counts too, since those grant server-scoped permissions on specific servers
		if (Array.isArray(cfg.serverGrants) && cfg.serverGrants.length > 0) continue
		permissions.push('squad-server:view')
		changed = true
	}

	if (changed) db.prepare(`UPDATE globalSettings SET settings = ? WHERE id = ?`).run(JSON.stringify(wrapper), row.id)
}
