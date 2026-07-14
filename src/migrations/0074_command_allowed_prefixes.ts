import type { MigrationDriver } from '@/server/migrate'

// The single `commandPrefix` became a list of `allowedPrefixes`, and command strings now carry their prefix inline
// (`!help` rather than `help`) so different commands can use different prefixes. `defaultPrefix` is the prefix that
// commands introduced by later SLM versions get seeded with.
//
// Every stored command string and timeout alias was bare (the old schema explicitly rejected strings starting with
// the prefix), so prefixing each one with the old `commandPrefix` reproduces exactly what used to be typed in chat.
//
// `settings` is stored superjson-wrapped ({ json, meta }) in a drizzle json(text) column; commands,
// timeoutCommandAliases and commandPrefix are plain JSON, so superjson's `meta` never references them.
const FALLBACK_PREFIX = '!'

export async function up(db: MigrationDriver): Promise<void> {
	const row = db.prepare(`SELECT settings FROM globalSettings WHERE id = 1`).get() as { settings: string } | undefined
	if (!row?.settings) return

	const wrapper = JSON.parse(row.settings) as { json?: any; meta?: any }
	if (!wrapper?.json || typeof wrapper.json !== 'object') return
	const settings = wrapper.json
	if (settings.allowedPrefixes !== undefined) return

	const prefix = typeof settings.commandPrefix === 'string' && settings.commandPrefix !== ''
		? settings.commandPrefix
		: FALLBACK_PREFIX

	if (settings.commands && typeof settings.commands === 'object') {
		for (const cmd of Object.values<any>(settings.commands)) {
			if (!cmd || typeof cmd !== 'object' || !Array.isArray(cmd.strings)) continue
			cmd.strings = cmd.strings.map((s: unknown) => typeof s === 'string' ? prefix + s : s)
		}
	}

	if (Array.isArray(settings.timeoutCommandAliases)) {
		settings.timeoutCommandAliases = settings.timeoutCommandAliases.map((alias: any) => {
			if (!alias || typeof alias !== 'object' || typeof alias.string !== 'string') return alias
			return { ...alias, string: prefix + alias.string }
		})
	}

	settings.allowedPrefixes = [prefix]
	settings.defaultPrefix = prefix
	delete settings.commandPrefix

	db.prepare(`UPDATE globalSettings SET settings = ? WHERE id = 1`).run(JSON.stringify(wrapper))
}
