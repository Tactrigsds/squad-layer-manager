import superjson from 'superjson'

import type { MigrationDriver } from '@/server/migrate'

// Moves each server's repeat rules into a ruleset in the global settings.
//
//   servers.settings.queue.mainPool.repeatRules  ->  globalSettings.settings.rulesets[i].rules
//   servers.settings.queue.mainPool              +=  rulesetId
//
// A public server gets a ruleset of its own: id from the server id, name from its display name, ownerServerId set.
// A server with no repeatRules key had the schema's default rules, so its ruleset gets those. Tutorial servers
// (visibility 'scoped') share one ruleset holding the tutorial's rules, rather than adding one per user to the list.
//
// Comments on the moved rules (servers.settings.comments, keyed by dotted path) move to the global settings' comments
// under the ruleset's path.
//
// With no global settings row there is nothing to write the rulesets into, and no server can predate that row, so the
// migration does nothing. Idempotent: servers whose mainPool has no repeatRules key and a rulesetId are left alone.

type Rule = Record<string, unknown>
type Ruleset = { id: string; name: string; ownerServerId?: string; rules: Rule[] }

const DEFAULT_RULES: Rule[] = [
	{ field: 'Map', within: 4, autogen: true, warn: true, indicate: true },
	{ field: 'Layer', within: 7, autogen: true, warn: true, indicate: true },
	{ field: 'Faction', within: 3, autogen: true, warn: true, indicate: true },
]

const TUTORIAL_RULESET: Ruleset = {
	id: 'slm-tutorial',
	name: 'SLM Tutorial',
	rules: [
		{ field: 'Map', within: 4, autogen: true },
		{ field: 'Layer', within: 7, autogen: true },
		{ field: 'Faction', within: 3, autogen: true, warn: true, crossTeam: true },
	],
}

const OLD_RULES_PATH = 'queue.mainPool.repeatRules'

function slug(serverId: string): string {
	return (
		serverId
			.toLowerCase()
			.replace(/[^a-z0-9_-]+/g, '-')
			.replace(/^-+|-+$/g, '')
			.slice(0, 56) || 'server'
	)
}

function freeId(taken: Set<string>, base: string): string {
	if (!taken.has(base)) return base
	for (let i = 2; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`
}

function freeName(taken: Set<string>, wanted: string): string {
	const base = wanted.trim().slice(0, 59) || 'Ruleset'
	if (!taken.has(base.toLowerCase())) return base
	for (let i = 2; ; i++) if (!taken.has(`${base} (${i})`.toLowerCase())) return `${base} (${i})`
}

export async function up(db: MigrationDriver): Promise<void> {
	const globalRow = db.prepare(`SELECT settings FROM globalSettings WHERE id = 1`).get() as { settings: string } | undefined
	if (!globalRow) return
	const globalSettings = superjson.parse<Record<string, any>>(globalRow.settings) ?? {}
	const rulesets: Ruleset[] = Array.isArray(globalSettings.rulesets) ? globalSettings.rulesets : []
	const takenIds = new Set(rulesets.map((r) => r.id))
	const takenNames = new Set(rulesets.map((r) => r.name.toLowerCase()))
	const globalComments: Record<string, string> = { ...globalSettings.comments }

	const rows = db.prepare(`SELECT id, displayName, visibility, settings FROM servers`).all() as {
		id: string
		displayName: string
		visibility: string
		settings: string | null
	}[]
	const update = db.prepare(`UPDATE servers SET settings = ? WHERE id = ?`)

	for (const row of rows) {
		const settings = (row.settings ? superjson.parse<Record<string, any>>(row.settings) : null) ?? {}
		settings.queue ??= {}
		settings.queue.mainPool ??= {}
		const mainPool = settings.queue.mainPool
		if (!('repeatRules' in mainPool) && typeof mainPool.rulesetId === 'string') continue
		const rules: Rule[] = Array.isArray(mainPool.repeatRules) ? mainPool.repeatRules : DEFAULT_RULES

		let rulesetIndex: number
		if (row.visibility === 'scoped') {
			rulesetIndex = rulesets.findIndex((r) => r.id === TUTORIAL_RULESET.id)
			if (rulesetIndex === -1) {
				rulesets.push({ ...TUTORIAL_RULESET, name: freeName(takenNames, TUTORIAL_RULESET.name) })
				takenIds.add(TUTORIAL_RULESET.id)
				takenNames.add(rulesets[rulesets.length - 1].name.toLowerCase())
				rulesetIndex = rulesets.length - 1
			}
		} else {
			const ruleset: Ruleset = {
				id: freeId(takenIds, slug(row.id)),
				name: freeName(takenNames, row.displayName),
				ownerServerId: row.id,
				rules,
			}
			takenIds.add(ruleset.id)
			takenNames.add(ruleset.name.toLowerCase())
			rulesets.push(ruleset)
			rulesetIndex = rulesets.length - 1
		}

		delete mainPool.repeatRules
		mainPool.rulesetId = rulesets[rulesetIndex].id

		const comments: Record<string, string> | undefined = settings.comments
		if (comments) {
			for (const [path, comment] of Object.entries(comments)) {
				if (path !== OLD_RULES_PATH && !path.startsWith(`${OLD_RULES_PATH}.`)) continue
				delete comments[path]
				// a scoped server's comments describe its own copy, which no longer exists
				if (row.visibility === 'scoped') continue
				globalComments[`rulesets.${rulesetIndex}.rules${path.slice(OLD_RULES_PATH.length)}`] = comment
			}
			if (Object.keys(comments).length === 0) delete settings.comments
		}

		update.run(superjson.stringify(settings), row.id)
	}

	globalSettings.rulesets = rulesets
	if (Object.keys(globalComments).length > 0) globalSettings.comments = globalComments
	db.prepare(`UPDATE globalSettings SET settings = ? WHERE id = 1`).run(superjson.stringify(globalSettings))
}
