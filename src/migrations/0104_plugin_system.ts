import superjson from 'superjson'

import type { MigrationDriver } from '@/server/migrate'

// Introduces the plugin system and moves native balance triggers out of the core:
//  - `plugins` holds installed-plugin state (enabled + config).
//  - balanceTriggerEvents is RENAMED to the balance-triggers plugin's namespaced table rather than
//    dropped: core migrations run at boot, before any plugin activates, so a drop here would destroy
//    the data before the plugin could adopt it. The plugin's own 0001_init reshapes the adopted table.
//  - the `balanceTriggerLevels` global setting becomes the plugin's config, and the plugin comes up
//    enabled, preserving behaviour (native triggers were always on).
//  - appEvents gains actorPluginId for the new 'plugin' actor.
export async function up(db: MigrationDriver): Promise<void> {
	db.exec(`CREATE TABLE plugins (
		id TEXT PRIMARY KEY,
		enabled INTEGER NOT NULL DEFAULT 0,
		config TEXT NOT NULL DEFAULT '{"json":{}}'
	)`)
	db.exec(`ALTER TABLE appEvents ADD COLUMN actorPluginId TEXT`)
	db.exec(`ALTER TABLE balanceTriggerEvents RENAME TO p_balance_triggers_events`)

	// an absent key means the schema default applied: only 150x2, at warn
	const row = db.prepare(`SELECT settings FROM globalSettings WHERE id = 1`).get() as { settings: string } | undefined
	let oldLevels: Record<string, string> | undefined
	if (row?.settings) {
		const settings = superjson.parse(row.settings) as Record<string, unknown> | null
		if (settings && typeof settings === 'object' && 'balanceTriggerLevels' in settings) {
			oldLevels = settings.balanceTriggerLevels as Record<string, string>
			delete settings.balanceTriggerLevels
			db.prepare(`UPDATE globalSettings SET settings = ? WHERE id = 1`).run(superjson.stringify(settings))
		}
	}
	const old = oldLevels ?? { '150x2': 'warn' }
	const config = {
		levels: {
			'150x2': old['150x2'] ?? 'off',
			'200x2': old['200x2'] ?? 'off',
			RWS5: old['RWS5'] ?? 'off',
			'RAM3+': old['RAM3+'] ?? 'off',
		},
		postRollReminder: true,
	}
	db.prepare(`INSERT INTO plugins (id, enabled, config) VALUES ('balance-triggers', 1, ?)`).run(superjson.stringify(config))
}
