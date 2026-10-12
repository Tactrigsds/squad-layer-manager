import superjson from 'superjson'

import type { MigrationDriver } from '@/server/migrate'

// Gives every server without one a `color` setting, and deletes the global `topBarColor` setting it replaces, along with
// any comment on it and any restricted global-settings grant naming it. A grant left naming it would fail validation
// and break the global settings.
//
// Public servers are coloured before scoped ones, in table order, each taking the first swatch no server holds yet.
// The swatches are a copy of Color.SWATCH_LIST in src/lib/color.ts at the time of writing. Idempotent.
const SWATCHES = [
	'#d1495b',
	'#e08e45',
	'#3d7dd9',
	'#3f9e6b',
	'#8367c7',
	'#e68cde',
	'#49c1ea',
	'#9bc14d',
	'#9f7100',
	'#9095e8',
	'#c265b0',
	'#04cfa2',
]
const KEY = 'topBarColor'

const namesKey = (path: unknown) => typeof path === 'string' && (path === KEY || path.startsWith(`${KEY}.`))

export async function up(db: MigrationDriver): Promise<void> {
	const rows = db.prepare(`SELECT id, settings, visibility FROM servers ORDER BY visibility = 'public' DESC, rowid`).all() as {
		id: string
		settings: string | null
		visibility: string
	}[]
	const parsed = rows.map((row) => ({
		id: row.id,
		settings: (row.settings === null ? null : superjson.parse(row.settings)) as Record<string, unknown> | null,
	}))
	const taken = new Set<string>()
	for (const { settings } of parsed) {
		if (settings && typeof settings.color === 'string') taken.add(settings.color.toLowerCase())
	}
	const updateServer = db.prepare(`UPDATE servers SET settings = ? WHERE id = ?`)
	let next = 0
	for (const { id, settings } of parsed) {
		if (!settings || typeof settings !== 'object' || typeof settings.color === 'string') continue
		let color = SWATCHES.find((swatch) => !taken.has(swatch))
		if (color === undefined) color = SWATCHES[next++ % SWATCHES.length]
		taken.add(color)
		updateServer.run(superjson.stringify({ ...settings, color }), id)
	}

	const global = db.prepare(`SELECT id, settings FROM globalSettings WHERE settings LIKE '%${KEY}%' ORDER BY id LIMIT 1`).get() as
		| { id: number; settings: string }
		| undefined
	if (!global) return
	const settings = superjson.parse(global.settings) as Record<string, unknown> | null
	if (!settings || typeof settings !== 'object') return
	delete settings[KEY]
	const comments = settings.comments as Record<string, unknown> | undefined
	if (comments && typeof comments === 'object') {
		for (const path of Object.keys(comments)) if (namesKey(path)) delete comments[path]
		if (Object.keys(comments).length === 0) delete settings.comments
	}
	const roles = (settings.rbac as { roles?: Record<string, { globalSettingsGrants?: unknown }> } | undefined)?.roles
	if (roles && typeof roles === 'object') {
		for (const cfg of Object.values(roles)) {
			if (!cfg || typeof cfg !== 'object' || !Array.isArray(cfg.globalSettingsGrants)) continue
			cfg.globalSettingsGrants = cfg.globalSettingsGrants.filter((path: unknown) => !namesKey(path))
		}
	}
	db.prepare(`UPDATE globalSettings SET settings = ? WHERE id = ?`).run(superjson.stringify(settings), global.id)
}
