import type { MigrationDriver } from '@/server/migrate'

// squad-server:view now gates every per-server read (the dashboard, its streams, and which servers are even listed).
// Roles that predate it hold none, so without this every existing role loses the dashboard the moment it lands.
//
// Granted to any role that could already reach a server at all: it held site:authorized, or any permission that only
// makes sense while looking at one. `*` roles need nothing, the wildcard already expands to every permission.
//
// Idempotent: a role that already lists it is skipped.
const IMPLIES_VIEW = [
	'site:authorized',
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
		if (permissions.includes('squad-server:view') || permissions.includes('*')) continue
		if (!permissions.some((p) => typeof p === 'string' && IMPLIES_VIEW.includes(p))) continue
		// ahead of the rest so the list reads in the order the permission editor sorts it
		permissions.unshift('squad-server:view')
		changed = true
	}

	if (changed) db.prepare(`UPDATE globalSettings SET settings = ? WHERE id = ?`).run(JSON.stringify(wrapper), row.id)
}
