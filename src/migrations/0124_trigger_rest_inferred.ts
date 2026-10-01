import superjson from 'superjson'

import type { MigrationDriver } from '@/server/migrate'

// A trigger's `{{restN}}` placeholder was the Nth typed word onwards, and bare `{{rest}}` was every typed word. Now
// there is only `{{rest}}`, and it starts after the highest `{{argN}}` in the template. Every `{{restN}}` becomes
// `{{rest}}`. Where N was not the word after the highest `{{argN}}`, the rest overlapped words an `{{argN}}` already
// took, which is no longer expressible, so the template now drops the overlap. Those are logged.
const REST_N = /(\{\{[{&#^/]?\s*)rest(\d+)(?=\s*\}?\}\})/g
const REST_ANY = /\{\{[{&#^/]?\s*rest(\d*)\s*\}?\}\}/g
const ARG_N = /\{\{[{&#^/]?\s*arg(\d+)\s*\}?\}\}/g

export function rewriteTemplate(template: string): { args: string; overlapped: boolean } | undefined {
	const starts = [...template.matchAll(REST_ANY)].map((m) => (m[1] ? Number(m[1]) : 1))
	if (starts.length === 0) return undefined
	const highest = Math.max(0, ...[...template.matchAll(ARG_N)].map((m) => Number(m[1])))
	const overlapped = starts.some((n) => n !== highest + 1)
	const args = template.replace(REST_N, '$1rest')
	if (args === template && !overlapped) return undefined
	return { args, overlapped }
}

export async function up(db: MigrationDriver): Promise<void> {
	const row = db.prepare(`SELECT settings FROM globalSettings WHERE id = 1`).get() as { settings: string } | undefined
	if (!row?.settings) return
	const settings = superjson.parse(row.settings) as { commands?: Record<string, { triggers?: unknown[] }> } | null
	const commands = settings?.commands
	if (!commands || typeof commands !== 'object') return

	let rewritten = 0
	const overlapped: string[] = []
	for (const config of Object.values(commands)) {
		const triggers = config?.triggers
		if (!Array.isArray(triggers)) continue
		config.triggers = triggers.map((t) => {
			if (!t || typeof t !== 'object') return t
			const { string, args } = t as { string?: unknown; args?: unknown }
			if (typeof args !== 'string') return t
			const next = rewriteTemplate(args)
			if (!next) return t
			if (next.overlapped) overlapped.push(`${String(string)}: "${args}" -> "${next.args}"`)
			if (next.args === args) return t
			rewritten++
			return { ...t, args: next.args }
		})
	}
	if (overlapped.length > 0) {
		console.warn(
			`0124_trigger_rest_inferred: ${overlapped.length} trigger(s) used {{rest}} over words an {{argN}} already took, and no longer repeat them: ${overlapped.join(', ')}`,
		)
	}
	if (rewritten === 0) return

	console.info(`0124_trigger_rest_inferred: rewrote {{restN}} to {{rest}} in ${rewritten} trigger(s)`)
	db.prepare(`UPDATE globalSettings SET settings = ? WHERE id = 1`).run(superjson.stringify(settings))
}
