import type { MigrationDriver } from '@/server/migrate'

// Renames two vote global-settings keys to mark them as the defaults they always were:
//   vote.voteDuration     -> vote.defaultVoteDuration
//   vote.voteDisplayProps -> vote.defaultVoteDisplayProps
//
// Without this migration the reshaped GlobalSettingsSchema fails to validate on load, which would reset EVERY global
// setting to defaults.
//
// Also rewrites any RBAC settings-path grants that referenced the old sub-paths, so a role restricted to
// "vote.voteDuration" keeps editing the same setting. The schema only validates a grant's head segment ("vote"), so a
// stale sub-path wouldn't crash boot -- it would just silently stop matching -- but the rename should carry through.
//
// `settings` is stored superjson-wrapped ({ json, meta }) in a drizzle json(text) column; we parse the TEXT, mutate the
// plain `.json` payload and write it back. Both renamed values are JSON-native (a HumanTime string and a string array),
// so the superjson `meta` (which only tags non-JSON types) never references them and is left untouched. Shapes are
// inlined per the frozen-in-time migration rule.

const RENAMES: [from: string, to: string][] = [
	['voteDuration', 'defaultVoteDuration'],
	['voteDisplayProps', 'defaultVoteDisplayProps'],
]

export async function up(db: MigrationDriver): Promise<void> {
	const row = db.prepare(`SELECT settings FROM globalSettings WHERE id = 1`).get() as { settings: string } | undefined
	if (!row?.settings) return

	const wrapper = JSON.parse(row.settings) as { json?: any; meta?: any }
	const json = wrapper?.json
	if (!json || typeof json !== 'object') return

	let changed = false

	const vote = json.vote
	if (vote && typeof vote === 'object' && !Array.isArray(vote)) {
		for (const [from, to] of RENAMES) {
			if (from in vote && !(to in vote)) {
				vote[to] = vote[from]
				delete vote[from]
				changed = true
			}
		}
	}

	// rewrite grant paths: "vote.voteDuration" -> "vote.defaultVoteDuration" (exact match or a deeper descendant)
	const roles = json.rbac?.roles
	if (roles && typeof roles === 'object') {
		for (const cfg of Object.values(roles) as any[]) {
			const grants = cfg?.globalSettingsGrants
			if (!Array.isArray(grants)) continue
			for (let i = 0; i < grants.length; i++) {
				const path = grants[i]
				if (typeof path !== 'string') continue
				for (const [from, to] of RENAMES) {
					const oldPrefix = `vote.${from}`
					const newPrefix = `vote.${to}`
					if (path === oldPrefix || path.startsWith(`${oldPrefix}.`)) {
						grants[i] = newPrefix + path.slice(oldPrefix.length)
						changed = true
						break
					}
				}
			}
		}
	}

	if (changed) db.prepare(`UPDATE globalSettings SET settings = ? WHERE id = 1`).run(JSON.stringify(wrapper))
}
