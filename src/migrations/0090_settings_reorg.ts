import type { MigrationDriver } from '@/server/migrate'

// Settings reorganization: several keys change scope between the global row and the per-server rows.
//
//   overrideAdminSetNextLayer / warnOnChangeLayer   per-server -> global (first server that sets them wins)
//   adminActionReasons[].aliases                    -> .keywords, now the ONLY thing chat matches, so required
//   squadServer.rconCacheTTL                        global -> per-server (copied to every server)
//   squadServer.{logFilePollInterval,tickRateThresholds} -> global top level, dissolving squadServer
//   warnPrefix                                      dropped; admin-directed warns are never prefixed now
//
// `settings` is stored superjson-wrapped ({ json, meta }); every value touched here is a primitive or a plain
// object, so `meta` never references them. Idempotent throughout: once a key has been moved the source no longer
// carries it and the destination already does.

type Wrapper = { json?: Record<string, unknown>; meta?: unknown }

const GLOBALIZED_SERVER_KEYS = ['overrideAdminSetNextLayer', 'warnOnChangeLayer'] as const

function readGlobal(db: MigrationDriver): { id: number; wrapper: Wrapper; json: Record<string, unknown> } | null {
	const row = db.prepare(`SELECT id, settings FROM globalSettings ORDER BY id LIMIT 1`).get() as
		| { id: number; settings: string | null }
		| undefined
	if (!row?.settings) return null
	const wrapper = JSON.parse(row.settings) as Wrapper
	if (!wrapper.json || typeof wrapper.json !== 'object') return null
	return { id: row.id, wrapper, json: wrapper.json }
}

function writeGlobal(db: MigrationDriver, id: number, wrapper: Wrapper): void {
	db.prepare(`UPDATE globalSettings SET settings = ? WHERE id = ?`).run(JSON.stringify(wrapper), id)
}

export async function up(db: MigrationDriver): Promise<void> {
	const global = readGlobal(db)
	const squadServer = (global?.json.squadServer ?? {}) as Record<string, unknown>
	// every server starts from what the whole install was already using, so nobody's RCON traffic changes shape
	const rconCacheTTL = squadServer.rconCacheTTL

	// per-server -> global. These are policy rather than connection details, so the servers collapse into one value:
	// the first server that has one explicitly set wins, and the schema default covers the rest.
	const hoisted: Record<string, unknown> = {}
	const serverRows = db.prepare(`SELECT id, settings FROM servers ORDER BY id`).all() as { id: string; settings: string | null }[]
	for (const row of serverRows) {
		if (!row.settings) continue
		const wrapper = JSON.parse(row.settings) as Wrapper
		const json = wrapper.json
		if (!json || typeof json !== 'object') continue
		let changed = false
		for (const key of GLOBALIZED_SERVER_KEYS) {
			if (!(key in json)) continue
			if (!(key in hoisted)) hoisted[key] = json[key]
			delete json[key]
			changed = true
		}
		if (rconCacheTTL !== undefined && !('rconCacheTTL' in json)) {
			json.rconCacheTTL = structuredClone(rconCacheTTL)
			changed = true
		}
		if (changed) db.prepare(`UPDATE servers SET settings = ? WHERE id = ?`).run(JSON.stringify(wrapper), row.id)
	}

	if (!global) return
	let globalChanged = false
	for (const key of GLOBALIZED_SERVER_KEYS) {
		if (key in global.json || !(key in hoisted)) continue
		global.json[key] = hoisted[key]
		globalChanged = true
	}

	// squadServer dissolves: its cache TTLs went to the servers above, and the two settings left are unrelated to each
	// other, so they sit at the top level rather than under a heading that no longer describes them
	if ('squadServer' in global.json) {
		for (const key of ['logFilePollInterval', 'tickRateThresholds']) {
			if (key in squadServer && !(key in global.json)) global.json[key] = squadServer[key]
		}
		delete global.json.squadServer
		globalChanged = true
	}

	if ('warnPrefix' in global.json) {
		delete global.json.warnPrefix
		globalChanged = true
	}

	if (reasonAliasesToKeywords(global.json)) globalChanged = true

	if (globalChanged) writeGlobal(db, global.id, global.wrapper)
}

// Chat used to resolve a reason by its label or an alias, which left a reason whose label has whitespace reachable
// only if it happened to carry an alias (a preset arg matches exactly one token). Keywords replace aliases as the one
// thing chat matches, so every reason needs at least one: reasons that carry no alias seed one from their label.
function reasonAliasesToKeywords(json: Record<string, unknown>): boolean {
	const reasons = json.adminActionReasons
	if (!Array.isArray(reasons)) return false

	const taken = new Set<string>()
	for (const reason of reasons) {
		if (!reason || typeof reason !== 'object') continue
		for (const keyword of ((reason as Record<string, unknown>).keywords ?? []) as unknown[]) {
			if (typeof keyword === 'string') taken.add(keyword.toLowerCase())
		}
	}

	let changed = false
	for (const raw of reasons) {
		if (!raw || typeof raw !== 'object') continue
		const reason = raw as Record<string, unknown>
		if (!('aliases' in reason)) continue
		const aliases = (Array.isArray(reason.aliases) ? reason.aliases : []).filter((a): a is string => typeof a === 'string')
		delete reason.aliases
		changed = true
		if (Array.isArray(reason.keywords) && reason.keywords.length > 0) continue

		const label = typeof reason.label === 'string' ? reason.label : ''
		const keywords = aliases.length > 0 ? aliases : [uniqueKeyword(slugify(label), taken)]
		for (const keyword of keywords) taken.add(keyword.toLowerCase())
		reason.keywords = keywords
	}
	return changed
}

function slugify(label: string): string {
	return label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

// labels are unique but their slugs need not be ("No SLKit" and "No-SLKit" collapse to the same thing), and keywords
// have to stay unique across every reason for chat to resolve them
function uniqueKeyword(base: string, taken: Set<string>): string {
	const seed = base || 'reason'
	if (!taken.has(seed)) return seed
	for (let n = 2;; n++) {
		const candidate = `${seed}-${n}`
		if (!taken.has(candidate)) return candidate
	}
}
