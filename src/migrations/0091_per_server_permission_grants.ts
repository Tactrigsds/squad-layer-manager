import type { MigrationDriver } from '@/server/migrate'

// The queue/vote/squad-server permissions became per-server. A bare expression still means "every server", so nothing
// breaks on its own, but "every server" now also silently covers servers added *later* -- a role written when one
// server existed would pick up the next one without anyone deciding that. So each role's bare grants are pinned to the
// servers that exist right now, which is the set they were actually written against.
//
// squad-server:view is new and gates the per-server reads. Holding any other server-scoped permission implies it (see
// RBAC.canViewServer), so the pinned grants above carry it. The one role that would otherwise lose every dashboard is
// the read-only one -- site:authorized and nothing server-scoped -- which gets it explicitly.
//
// Idempotent: once moved, `permissions` no longer holds the bare entries, so a second run finds nothing to pin.
const MOVED_TO_SERVER_SCOPE = [
	'queue:write',
	'queue:force-write',
	'queue:manage-all-notes',
	'vote:manage',
	'squad-server:view',
	'squad-server:end-match',
	'squad-server:disable-slm-updates',
	'squad-server:turn-fog-off',
	'squad-server:manage-players',
	'squad-server:warn-players',
	'squad-server:broadcast',
	'squad-server:kick-players',
]

type ServerGrant = { permission: string; serverIds: string[] }

export async function up(db: MigrationDriver): Promise<void> {
	const row = db.prepare(`SELECT id, settings FROM globalSettings ORDER BY id LIMIT 1`).get() as
		| { id: number; settings: string | null }
		| undefined
	if (!row?.settings) return
	const wrapper = JSON.parse(row.settings) as { json?: any; meta?: any }
	const roles = wrapper?.json?.rbac?.roles
	if (!roles || typeof roles !== 'object') return

	const serverIds = (db.prepare(`SELECT id FROM servers ORDER BY id`).all() as { id: string }[]).map((s) => s.id)

	let changed = false
	for (const cfg of Object.values(roles) as any[]) {
		if (!cfg || typeof cfg !== 'object') continue
		if (!Array.isArray(cfg.permissions)) continue
		// `*` already expands to every permission, unrestricted; pinning it would narrow an owner role
		if (cfg.permissions.includes('*')) continue

		const grants: ServerGrant[] = Array.isArray(cfg.serverGrants) ? [...cfg.serverGrants] : []

		// With no servers configured there is nothing to pin to, and a grant naming none is not a valid one -- writing
		// it would drop the permission outright. A fresh install is exactly that case, and a bare expression is already
		// the right answer there.
		if (serverIds.length > 0) {
			const kept: string[] = []
			let pinnedAny = false
			for (const expr of cfg.permissions as unknown[]) {
				// denials stay bare: they are expressions rather than grants, and a bare denial applies everywhere
				if (typeof expr !== 'string' || expr.startsWith('!') || !MOVED_TO_SERVER_SCOPE.includes(expr)) {
					kept.push(expr as string)
					continue
				}
				if (!grants.some((g) => g.permission === expr)) grants.push({ permission: expr, serverIds: [...serverIds] })
				pinnedAny = true
			}
			if (pinnedAny) {
				cfg.permissions = kept
				cfg.serverGrants = grants
				changed = true
			}
		}

		// the read-only role: nothing server-scoped to imply view, so it needs its own grant
		const holdsServerScoped =
			grants.length > 0 || (cfg.permissions as string[]).some((p) => typeof p === 'string' && MOVED_TO_SERVER_SCOPE.includes(p))
		if (!holdsServerScoped && (cfg.permissions as string[]).includes('site:authorized')) {
			if (serverIds.length > 0) cfg.serverGrants = [...grants, { permission: 'squad-server:view', serverIds: [...serverIds] }]
			else cfg.permissions = [...(cfg.permissions as string[]), 'squad-server:view']
			changed = true
		}
	}

	if (changed) db.prepare(`UPDATE globalSettings SET settings = ? WHERE id = ?`).run(JSON.stringify(wrapper), row.id)
}
