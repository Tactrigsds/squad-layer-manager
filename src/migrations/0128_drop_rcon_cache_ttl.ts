import superjson from 'superjson'

import type { MigrationDriver } from '@/server/migrate'

// The per-server `rconCacheTTL` setting is gone: SLM polls RCON at fixed intervals. This deletes it, and any comment on
// it, from every server's settings, and drops it from the paths of every role's restricted server-settings write grant.
//
// A write grant with no paths covers every non-sensitive setting, so a grant whose only paths named `rconCacheTTL`
// becomes a read grant on the same servers rather than an empty write grant. That keeps the view access every grant
// implies and nothing more.
//
// Only rows whose text mentions the key are parsed. Idempotent: a second run changes nothing.
const KEY = 'rconCacheTTL'

const namesKey = (path: unknown) => typeof path === 'string' && (path === KEY || path.startsWith(`${KEY}.`))

export async function up(db: MigrationDriver): Promise<void> {
	const servers = db.prepare(`SELECT id, settings FROM servers WHERE settings LIKE '%${KEY}%'`).all() as {
		id: string
		settings: string
	}[]
	const updateServer = db.prepare(`UPDATE servers SET settings = ? WHERE id = ?`)
	for (const row of servers) {
		const settings = superjson.parse(row.settings) as Record<string, unknown> | null
		if (!settings || typeof settings !== 'object') continue
		let changed = false
		if (KEY in settings) {
			delete settings[KEY]
			changed = true
		}
		const comments = settings.comments as Record<string, unknown> | undefined
		if (comments && typeof comments === 'object') {
			for (const path of Object.keys(comments)) {
				if (!namesKey(path)) continue
				delete comments[path]
				changed = true
			}
			if (Object.keys(comments).length === 0) delete settings.comments
		}
		if (changed) updateServer.run(superjson.stringify(settings), row.id)
	}

	const global = db.prepare(`SELECT id, settings FROM globalSettings WHERE settings LIKE '%${KEY}%' ORDER BY id LIMIT 1`).get() as
		| { id: number; settings: string }
		| undefined
	if (!global) return
	const settings = superjson.parse(global.settings) as { rbac?: { roles?: Record<string, { serverSettingsGrants?: unknown }> } } | null
	const roles = settings?.rbac?.roles
	if (!roles || typeof roles !== 'object') return

	let changed = false
	for (const cfg of Object.values(roles)) {
		if (!cfg || typeof cfg !== 'object' || !Array.isArray(cfg.serverSettingsGrants)) continue
		cfg.serverSettingsGrants = cfg.serverSettingsGrants.map((grant: unknown) => {
			if (!grant || typeof grant !== 'object') return grant
			const { access, paths } = grant as { access?: unknown; paths?: unknown }
			if ((access !== undefined && access !== 'write') || !Array.isArray(paths) || !paths.some(namesKey)) return grant
			changed = true
			const kept = paths.filter((p) => !namesKey(p))
			if (kept.length > 0) return { ...grant, paths: kept }
			return { ...grant, access: 'read', paths: [] }
		})
	}
	if (!changed) return
	db.prepare(`UPDATE globalSettings SET settings = ? WHERE id = ?`).run(superjson.stringify(settings), global.id)
}
