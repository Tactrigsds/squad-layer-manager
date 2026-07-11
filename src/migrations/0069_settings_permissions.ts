import type { MigrationDriver } from '@/server/migrate'

// The settings permissions were reworked: `settings:write` became the server-scoped `server-settings:write`, and
// `admin:manage-global-settings` became `global-settings:write` (read access is implied by any write grant).
// `admin:manage-servers` previously also implied full raw server-settings access, including the RCON/SFTP connection
// details, so roles holding it are additionally granted the new server-settings perms to preserve their capabilities.
// Roles with `*` need no changes: the wildcard expands to the new permission set.
//
// `settings` is stored superjson-wrapped ({ json, meta }) in a drizzle json(text) column; rbac.roles is plain JSON.
export async function up(db: MigrationDriver): Promise<void> {
	const row = db.prepare(`SELECT settings FROM globalSettings WHERE id = 1`).get() as { settings: string } | undefined
	if (!row?.settings) return

	const wrapper = JSON.parse(row.settings) as { json?: any; meta?: any }
	const roles = wrapper?.json?.rbac?.roles
	if (!roles || typeof roles !== 'object') return

	const RENAMES: Record<string, string> = {
		'settings:write': 'server-settings:write',
		'!settings:write': '!server-settings:write',
		'admin:manage-global-settings': 'global-settings:write',
		'!admin:manage-global-settings': '!global-settings:write',
	}
	const MANAGE_SERVERS_IMPLIED = ['server-settings:read', 'server-settings:write', 'server-settings:write-sensitive']

	for (const roleId of Object.keys(roles)) {
		const exprs: unknown = roles[roleId]
		if (!Array.isArray(exprs)) continue
		const next = exprs.map((e) => (typeof e === 'string' && RENAMES[e]) || e)
		if (next.includes('admin:manage-servers')) {
			for (const perm of MANAGE_SERVERS_IMPLIED) {
				if (!next.includes(perm)) next.push(perm)
			}
		}
		roles[roleId] = next
	}

	db.prepare(`UPDATE globalSettings SET settings = ? WHERE id = 1`).run(JSON.stringify(wrapper))
}
