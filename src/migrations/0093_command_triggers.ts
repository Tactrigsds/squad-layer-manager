import type { MigrationDriver } from '@/server/migrate'

// `commands[id].strings` (plain strings) and the top-level `commandAliases` ({ alias, command }) were two ways of
// saying the same thing: a string that runs a command. They become one list, `commands[id].triggers`, whose entries
// are either a bare string (the command's arguments as typed) or `{ string, args }` (a template pinning some of them).
//
// An alias names its target by command string, so it is resolved here and stored under that command instead. One
// whose leading word matches no command string cannot be resolved and is dropped with a warning: it could not run
// before this migration either, since dispatch resolved it the same way.
//
// `settings` is stored superjson-wrapped ({ json, meta }) in a drizzle json(text) column; both keys are plain JSON,
// so superjson's `meta` never references them.
export async function up(db: MigrationDriver): Promise<void> {
	const row = db.prepare(`SELECT settings FROM globalSettings WHERE id = 1`).get() as { settings: string } | undefined
	if (!row?.settings) return

	const wrapper = JSON.parse(row.settings) as { json?: any; meta?: any }
	if (!wrapper?.json || typeof wrapper.json !== 'object') return
	const settings = wrapper.json
	const commands = settings.commands
	if (!commands || typeof commands !== 'object') return

	// strings -> triggers, before the aliases are folded in so they can be matched against the same list
	const ownerOf = new Map<string, string>()
	for (const [id, cmd] of Object.entries<any>(commands)) {
		if (!cmd || typeof cmd !== 'object') continue
		// a command already converted keeps the triggers it has: this migration was 0092 on an earlier revision of
		// its branch, so a database that ran it under that name would otherwise be re-run here and emptied
		if (Array.isArray(cmd.strings)) {
			cmd.triggers = cmd.strings.filter((s: unknown): s is string => typeof s === 'string')
			delete cmd.strings
		} else if (!Array.isArray(cmd.triggers)) {
			cmd.triggers = []
		}
		for (const t of cmd.triggers as unknown[]) {
			const str = typeof t === 'string' ? t : (t as { string?: unknown })?.string
			if (typeof str === 'string') ownerOf.set(str.toLowerCase(), id)
		}
	}

	const aliases: any[] = Array.isArray(settings.commandAliases) ? settings.commandAliases : []
	const dropped: string[] = []
	for (const alias of aliases) {
		const shortcut = typeof alias?.alias === 'string' ? alias.alias : ''
		const command = typeof alias?.command === 'string' ? alias.command : ''
		const words = command
			.trim()
			.split(/\s+/)
			.filter((w: string) => w !== '')
		const targetId = words.length > 0 ? ownerOf.get(words[0].toLowerCase()) : undefined
		if (shortcut === '' || targetId === undefined) {
			dropped.push(`${shortcut || '(blank)'} -> ${command || '(blank)'}`)
			continue
		}
		// the command word is what identified the target, so only the arguments after it carry over. An alias with
		// none of its own is exactly a plain trigger.
		const args = words.slice(1).join(' ')
		commands[targetId].triggers.push(args === '' ? shortcut : { string: shortcut, args })
	}

	if (dropped.length > 0) {
		console.warn(
			`0093_command_triggers: dropping ${dropped.length} command alias(es) whose command string does not resolve: ` +
				`${dropped.join(', ')}. They could not run before this migration either. Re-add them under ` +
				`Settings > In-game Commands as triggers on the command they were meant to run.`,
		)
	}

	delete settings.commandAliases

	db.prepare(`UPDATE globalSettings SET settings = ? WHERE id = 1`).run(JSON.stringify(wrapper))
}
