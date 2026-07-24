import type { MigrationDriver } from '@/server/migrate'

// Settings reorganization. Most of it is keys changing scope between the global row and the per-server rows:
//
//   vote, fogOffDelay, postRollAnnouncementsTimeout   global -> per-server (copied to every server)
//   layerQueue.*                                      global -> per-server, under `queue`
//   squadServer.rconCacheTTL                          global -> per-server
//   squadServer.{logFilePollInterval,tickRateThresholds} -> global top level, dissolving squadServer
//   warnPrefix                                        dropped; admin-directed warns are never prefixed now
//   warnOnChangeLayer                                 -> warnOnNextLayerChange (per-server), behaviour widened
//   queue.{preferredLength,generatedItemType,preferredNumVoteChoices} dropped; nothing read them
//   adminActionReasons[].aliases                      -> .keywords, now the ONLY thing chat matches, so required
//
// Everything moving global -> per-server was one value the whole install shared, so every server starts from it and
// operators diverge them afterwards.
//
// `settings` is stored superjson-wrapped ({ json, meta }); every value touched here is a primitive, a plain object or
// an array of them, so `meta` never references them. HumanTime values are copied across verbatim: the global row holds
// them encoded ("5m") and server rows decoded (300000), but the schema parses either, and the next save through the
// editor normalizes. Idempotent throughout: once a key has moved the source no longer carries it.

type Wrapper = { json?: Record<string, unknown>; meta?: unknown }

// per-server keys an earlier revision of this migration hoisted onto the global row. They belong to the server, so
// they're pushed back down if a database ran that revision; on any other database there is nothing to push.
const RETURNED_TO_SERVERS = ['overrideAdminSetNextLayer', 'warnOnChangeLayer'] as const

// warnOnChangeLayer only fired when SLM's own queue save moved the next layer; it now announces a change from any
// source, so it is renamed to match. The value carries over as-is.
const RENAMED_ON_SERVERS: Record<string, string> = { warnOnChangeLayer: 'warnOnNextLayerChange' }

const GLOBAL_TO_SERVER_KEYS = ['vote', 'fogOffDelay', 'postRollAnnouncementsTimeout'] as const
const DROPPED_QUEUE_KEYS = ['preferredLength', 'generatedItemType', 'preferredNumVoteChoices'] as const

function readGlobal(db: MigrationDriver): { id: number; wrapper: Wrapper; json: Record<string, unknown> } | null {
	const row = db.prepare(`SELECT id, settings FROM globalSettings ORDER BY id LIMIT 1`).get() as
		| { id: number; settings: string | null }
		| undefined
	if (!row?.settings) return null
	const wrapper = JSON.parse(row.settings) as Wrapper
	if (!wrapper.json || typeof wrapper.json !== 'object') return null
	return { id: row.id, wrapper, json: wrapper.json }
}

export async function up(db: MigrationDriver): Promise<void> {
	const global = readGlobal(db)
	const globalJson = global?.json ?? {}
	const squadServer = (globalJson.squadServer ?? {}) as Record<string, unknown>
	const layerQueue = (globalJson.layerQueue ?? {}) as Record<string, unknown>

	const serverRows = db.prepare(`SELECT id, settings FROM servers ORDER BY id`).all() as { id: string; settings: string | null }[]
	for (const row of serverRows) {
		if (!row.settings) continue
		const wrapper = JSON.parse(row.settings) as Wrapper
		const json = wrapper.json
		if (!json || typeof json !== 'object') continue
		let changed = false

		const adopt = (key: string, value: unknown) => {
			if (value === undefined || key in json) return
			json[key] = structuredClone(value)
			changed = true
		}
		for (const key of GLOBAL_TO_SERVER_KEYS) adopt(key, globalJson[key])
		for (const key of RETURNED_TO_SERVERS) adopt(key, globalJson[key])
		adopt('rconCacheTTL', squadServer.rconCacheTTL)

		// the queue-length settings join the pool config under the server's own `queue`
		const queue = (json.queue ?? {}) as Record<string, unknown>
		for (const key of ['maxQueueSize', 'lowQueueWarningThreshold', 'adminQueueReminderInterval']) {
			if (!(key in layerQueue) || key in queue) continue
			queue[key] = structuredClone(layerQueue[key])
			changed = true
		}
		for (const key of DROPPED_QUEUE_KEYS) {
			if (!(key in queue)) continue
			delete queue[key]
			changed = true
		}
		if (changed) json.queue = queue

		// after the adopts above, so a value pushed back down from the global row is renamed too
		for (const [from, to] of Object.entries(RENAMED_ON_SERVERS)) {
			if (!(from in json)) continue
			if (!(to in json)) json[to] = json[from]
			delete json[from]
			changed = true
		}

		if (changed) db.prepare(`UPDATE servers SET settings = ? WHERE id = ?`).run(JSON.stringify(wrapper), row.id)
	}

	if (!global) return
	let globalChanged = false

	// squadServer dissolves: its cache TTLs went to the servers above, and the two settings left are unrelated to each
	// other, so they sit at the top level rather than under a heading that no longer describes them
	if ('squadServer' in global.json) {
		for (const key of ['logFilePollInterval', 'tickRateThresholds']) {
			if (key in squadServer && !(key in global.json)) global.json[key] = squadServer[key]
		}
		delete global.json.squadServer
		globalChanged = true
	}

	for (const key of [...GLOBAL_TO_SERVER_KEYS, ...RETURNED_TO_SERVERS, 'layerQueue', 'warnPrefix']) {
		if (!(key in global.json)) continue
		delete global.json[key]
		globalChanged = true
	}

	if (reasonAliasesToKeywords(global.json)) globalChanged = true

	if (globalChanged) db.prepare(`UPDATE globalSettings SET settings = ? WHERE id = ?`).run(JSON.stringify(global.wrapper), global.id)
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
