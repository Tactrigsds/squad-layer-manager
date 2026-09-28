import superjson from 'superjson'

import type { MigrationDriver } from '@/server/migrate'

// Moves the `pluginCommands` global setting onto the plugins it configures. The setting was keyed by dispatch id
// (`plugin:<pluginId>:<name>`); each plugin row now holds its own overrides keyed by name. An entry for a plugin
// with no row gets one, disabled, the same row the plugin would create for itself on first sight.
const PREFIX = 'plugin:'

export async function up(db: MigrationDriver): Promise<void> {
	db.exec(`ALTER TABLE plugins ADD COLUMN commands TEXT NOT NULL DEFAULT '{"json":{}}'`)

	const row = db.prepare(`SELECT settings FROM globalSettings WHERE id = 1`).get() as { settings: string } | undefined
	if (!row?.settings) return
	const settings = superjson.parse(row.settings) as Record<string, unknown> | null
	if (!settings || typeof settings !== 'object' || !('pluginCommands' in settings)) return
	const old = (settings.pluginCommands ?? {}) as Record<string, unknown>
	delete settings.pluginCommands
	db.prepare(`UPDATE globalSettings SET settings = ? WHERE id = 1`).run(superjson.stringify(settings))

	const byPlugin = new Map<string, Record<string, unknown>>()
	for (const [id, config] of Object.entries(old)) {
		if (!id.startsWith(PREFIX)) continue
		const rest = id.slice(PREFIX.length)
		const sep = rest.indexOf(':')
		if (sep <= 0) continue
		const pluginId = rest.slice(0, sep)
		const name = rest.slice(sep + 1)
		let commands = byPlugin.get(pluginId)
		if (!commands) byPlugin.set(pluginId, (commands = {}))
		commands[name] = config
	}

	const upsert = db.prepare(
		`INSERT INTO plugins (id, enabled, config, commands) VALUES (?, 0, '{"json":{}}', ?)
			ON CONFLICT (id) DO UPDATE SET commands = excluded.commands`,
	)
	for (const [pluginId, commands] of byPlugin) upsert.run(pluginId, superjson.stringify(commands))
}
