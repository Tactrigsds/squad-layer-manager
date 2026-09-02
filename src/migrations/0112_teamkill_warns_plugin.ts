import superjson from 'superjson'

import type { MigrationDriver } from '@/server/migrate'

// Moves the per-server `teamkillNotifications` setting into the teamkill-warns plugin's config, the way
// 0104 moved balance triggers. The plugin comes up enabled when any server had it on: a plugin with no
// row here defaults to disabled, which would drop the feature on upgrade with no error and no log.
//
// The setting was per-server and the plugin's config is global, so divergent templates cannot all
// survive. The first enabled server's wins.
const DEFAULT_TEMPLATE = 'You have been teamkilled by {{attacker}} with {{weapon}}. An admin has been notified.'

export async function up(db: MigrationDriver): Promise<void> {
	const rows = db.prepare(`SELECT id, settings FROM servers`).all() as { id: string; settings: string | null }[]
	const update = db.prepare(`UPDATE servers SET settings = ? WHERE id = ?`)
	const enabledServers: string[] = []
	let template: string | null = null

	for (const row of rows) {
		if (!row.settings) continue
		const settings = superjson.parse(row.settings) as Record<string, unknown> | null
		if (!settings || typeof settings !== 'object' || !('teamkillNotifications' in settings)) continue
		const old = settings.teamkillNotifications as { enabled?: boolean; template?: string } | null
		delete settings.teamkillNotifications
		update.run(superjson.stringify(settings), row.id)
		if (!old?.enabled) continue
		enabledServers.push(row.id)
		template ??= old.template ?? null
	}

	if (enabledServers.length === 0) return
	const config = { enabledServers, template: template ?? DEFAULT_TEMPLATE }
	db.prepare(
		`INSERT INTO plugins (id, enabled, config) VALUES ('teamkill-warns', 1, ?)
			ON CONFLICT (id) DO UPDATE SET enabled = 1, config = excluded.config`,
	).run(superjson.stringify(config))
}
