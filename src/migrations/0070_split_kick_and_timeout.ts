import type { MigrationDriver } from '@/server/migrate'

// Kicks and timeouts became distinct admin actions: a kick removes the player, a timeout additionally bars them
// from rejoining until it expires. The old `kick` action was always a timeout, so its texts and reason
// requirement move to `timeout`. Reasons also lost their mandatory `message` (warn text) field in favour of an
// optional `actionTexts.warn` entry, and `requireReasonFor` no longer accepts `warn` (warns always need a reason).
//
// A reason must now carry at least one action text. Migrated reasons always have one (the old warn text was
// required), so none are dropped here.
//
// Roles are also granted the new `squad-server:kick-players` permission wherever they hold
// `squad-server:timeout-players`, so nobody loses the ability to kick.
//
// `settings` is stored superjson-wrapped ({ json, meta }) in a drizzle json(text) column; adminActionReasons,
// requireReasonFor, rbac and commands are plain JSON, so the superjson `meta` never references them.

// the new /timeout and /timeoutSquad commands' default strings. Kept in sync with COMMAND_DECLARATIONS by hand:
// a migration must keep applying the same transformation forever, so it can't read today's declarations.
const NEW_COMMAND_STRINGS: Record<string, string[]> = {
	timeout: ['timeout', 'to'],
	timeoutSquad: ['timeoutsquad', 'tos'],
}

export async function up(db: MigrationDriver): Promise<void> {
	const row = db.prepare(`SELECT settings FROM globalSettings WHERE id = 1`).get() as { settings: string } | undefined
	if (!row?.settings) return

	const wrapper = JSON.parse(row.settings) as { json?: any; meta?: any }
	if (!wrapper?.json || typeof wrapper.json !== 'object') return
	const settings = wrapper.json

	if (Array.isArray(settings.adminActionReasons)) {
		settings.adminActionReasons = settings.adminActionReasons.map((reason: any) => {
			if (!reason || typeof reason !== 'object') return reason
			const { message, actionTexts, ...rest } = reason
			const texts: Record<string, string> = { ...(actionTexts ?? {}) }
			if (typeof texts.kick === 'string') {
				texts.timeout = texts.kick
				delete texts.kick
			}
			if (typeof message === 'string' && message.trim() !== '') texts.warn = message
			return { ...rest, actionTexts: texts }
		})
	}

	if (Array.isArray(settings.requireReasonFor)) {
		const actions = new Set<string>(
			settings.requireReasonFor
				.filter((a: unknown): a is string => typeof a === 'string' && a !== 'warn')
				.map((a: string) => (a === 'kick' ? 'timeout' : a)),
		)
		settings.requireReasonFor = [...actions]
	}

	// command strings and timeout-alias strings share one namespace and the settings schema rejects collisions, so
	// a pre-existing alias named e.g. "to" would make the new commands' defaults fail validation at boot. Seed the
	// new commands explicitly, dropping any default string already taken by an alias or another command.
	const commands = settings.commands
	if (commands && typeof commands === 'object') {
		const taken = new Set<string>()
		for (const cmd of Object.values(commands) as any[]) {
			for (const s of cmd?.strings ?? []) if (typeof s === 'string') taken.add(s.toLowerCase())
		}
		for (const alias of (Array.isArray(settings.timeoutCommandAliases) ? settings.timeoutCommandAliases : []) as any[]) {
			if (typeof alias?.string === 'string') taken.add(alias.string.toLowerCase())
		}
		for (const [id, defaults] of Object.entries(NEW_COMMAND_STRINGS)) {
			if (commands[id]) continue
			const strings = defaults.filter((s) => !taken.has(s))
			commands[id] = { strings, scopes: ['admin'], enabled: true }
			for (const s of strings) taken.add(s)
		}
	}

	// a role's timeout grant lives in rbac.maxTimeouts, not in its expression list (the cap can't ride the
	// equality-matched expression grammar), so that map is what identifies the roles that could kick before
	const roles = settings.rbac?.roles
	const maxTimeouts = settings.rbac?.maxTimeouts
	if (roles && typeof roles === 'object' && maxTimeouts && typeof maxTimeouts === 'object') {
		for (const roleId of Object.keys(maxTimeouts)) {
			const exprs: unknown = roles[roleId]
			if (!Array.isArray(exprs) || exprs.includes('squad-server:kick-players')) continue
			roles[roleId] = [...exprs, 'squad-server:kick-players']
		}
	}

	db.prepare(`UPDATE globalSettings SET settings = ? WHERE id = 1`).run(JSON.stringify(wrapper))
}
