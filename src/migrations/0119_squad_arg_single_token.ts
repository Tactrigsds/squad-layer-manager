import superjson from 'superjson'

import type { MigrationDriver } from '@/server/migrate'

// A squad argument was `[team] <squad>`, one or two words, and is now one word, `[team:]squad`. A trigger template on
// a squad command that pins the team as its own word (`2 {{arg1}}`, `B cmd`) would now read the team as the squad, so
// its first two words are joined with a colon. Every squad command takes the squad first.
//
// Only a pinned team is rewritten. A template that leads with a placeholder already passes the squad through as
// typed, so its callers just type `2:3` like everyone else.
const SQUAD_COMMANDS = ['swapSquadNow', 'swapSquadNext', 'warnSquad', 'killSquad', 'disbandSquad', 'kickSquad', 'timeoutSquad']

const LEADING_PAIR = /^(\s*)(\S+)\s+(\S+)/
const SLOT_TEAM = /^(1|2|a|b)$/i
const FACTION_LIKE = /^[a-z]+$/i
const SQUAD_LITERAL = /^(\d+|cmd)$/i
const ARG_PLACEHOLDER = /^\{\{arg\d+\}\}$/

// Mirrors the old parser, which paired the first two words when the first was a team and the second was a squad
// number or "cmd". A faction only counted as a team on a layer that had it, so a word that could be one is only
// taken for a team where the squad after it is literal, which is how a squad name followed by a reason can't look.
export function rewriteTemplate(template: string): string | undefined {
	const m = LEADING_PAIR.exec(template)
	if (!m) return undefined
	const [, lead, first, second] = m
	if (first.includes('{{') || first.includes(':')) return undefined
	const pairs =
		(SLOT_TEAM.test(first) && (SQUAD_LITERAL.test(second) || ARG_PLACEHOLDER.test(second))) ||
		(FACTION_LIKE.test(first) && SQUAD_LITERAL.test(second))
	if (!pairs) return undefined
	return `${lead}${first}:${second}${template.slice(m[0].length)}`
}

export async function up(db: MigrationDriver): Promise<void> {
	const row = db.prepare(`SELECT settings FROM globalSettings WHERE id = 1`).get() as { settings: string } | undefined
	if (!row?.settings) return
	const settings = superjson.parse(row.settings) as { commands?: Record<string, { triggers?: unknown[] }> } | null
	const commands = settings?.commands
	if (!commands || typeof commands !== 'object') return

	const rewritten: string[] = []
	for (const id of SQUAD_COMMANDS) {
		const triggers = commands[id]?.triggers
		if (!Array.isArray(triggers)) continue
		commands[id].triggers = triggers.map((t) => {
			if (!t || typeof t !== 'object') return t
			const { string, args } = t as { string?: unknown; args?: unknown }
			if (typeof args !== 'string') return t
			const next = rewriteTemplate(args)
			if (next === undefined) return t
			rewritten.push(`${String(string)}: "${args}" -> "${next}"`)
			return { ...t, args: next }
		})
	}
	if (rewritten.length === 0) return

	console.info(`0119_squad_arg_single_token: rewrote ${rewritten.length} squad trigger(s) to team:squad: ${rewritten.join(', ')}`)
	db.prepare(`UPDATE globalSettings SET settings = ? WHERE id = 1`).run(superjson.stringify(settings))
}
