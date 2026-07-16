import type { MigrationDriver } from '@/server/migrate'

// `timeoutCommandAliases` ({ string, duration }: a fixed-duration kick whose player and reason were typed in chat)
// became the general `commandAliases` ({ alias, command }: a shortcut to a complete command invocation).
//
// The old aliases cannot be carried across. A command alias takes no arguments of its own, and the old ones took a
// <player> (and an optional reason) at call time while pinning only the duration -- there is no `command` text that
// expresses "timeout whoever I name for 5m". Converting them would produce aliases that fail on every use, so they're
// dropped and logged instead, leaving the admin to re-add whichever ones still make sense.
//
// `settings` is stored superjson-wrapped ({ json, meta }) in a drizzle json(text) column; both keys are plain JSON,
// so superjson's `meta` never references them.
export async function up(db: MigrationDriver): Promise<void> {
	const row = db.prepare(`SELECT settings FROM globalSettings WHERE id = 1`).get() as { settings: string } | undefined
	if (!row?.settings) return

	const wrapper = JSON.parse(row.settings) as { json?: any; meta?: any }
	if (!wrapper?.json || typeof wrapper.json !== 'object') return
	const settings = wrapper.json
	if (settings.commandAliases !== undefined) return

	const dropped = Array.isArray(settings.timeoutCommandAliases) ? settings.timeoutCommandAliases : []
	if (dropped.length > 0) {
		const listed = dropped.map((a: any) => `${a?.string} (${a?.duration})`).join(', ')
		console.warn(
			`0080_command_aliases: dropping ${dropped.length} timeout alias(es) that the new alias model cannot express: ${listed}. `
				+ `Re-add them under Settings > In-game Commands > Command Aliases if still wanted.`,
		)
	}

	settings.commandAliases = []
	delete settings.timeoutCommandAliases

	db.prepare(`UPDATE globalSettings SET settings = ? WHERE id = 1`).run(JSON.stringify(wrapper))
}
