import type { PluginMigration } from 'slm/plugin'

// The core migration that removed native balance triggers RENAMED balanceTriggerEvents to
// p_balance_triggers_events rather than dropping it, because core migrations run at boot, before
// any plugin activates. So this either creates the table fresh, or reshapes the adopted one:
// evaluationResult (the whole superjson-wrapped evaluation) becomes input (just the relevant
// slice), and time is backfilled from the triggering match's end time.
export const migrations: PluginMigration[] = [
	{
		name: '0001_init',
		up: (db) => {
			db.exec(`CREATE TABLE IF NOT EXISTS p_balance_triggers_events (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				triggerId TEXT NOT NULL,
				triggerVersion INTEGER NOT NULL,
				matchTriggeredId INTEGER,
				strongerTeam TEXT NOT NULL,
				level TEXT NOT NULL,
				input TEXT NOT NULL DEFAULT '{}',
				time INTEGER NOT NULL DEFAULT 0
			)`)
			const cols = (db.prepare(`SELECT name FROM pragma_table_info('p_balance_triggers_events')`).all() as { name: string }[]).map(
				(c) => c.name,
			)
			if (cols.includes('evaluationResult')) {
				db.exec(`ALTER TABLE p_balance_triggers_events RENAME COLUMN evaluationResult TO input`)
				db.exec(`UPDATE p_balance_triggers_events SET input = COALESCE(json_extract(input, '$.json.relevantInput'), '{}')`)
			}
			if (!cols.includes('time')) {
				db.exec(`ALTER TABLE p_balance_triggers_events ADD COLUMN time INTEGER NOT NULL DEFAULT 0`)
				db.exec(`UPDATE p_balance_triggers_events SET time = COALESCE(
					(SELECT mh.endTime FROM matchHistory mh WHERE mh.id = p_balance_triggers_events.matchTriggeredId), 0)`)
			}
			db.exec(`CREATE INDEX IF NOT EXISTS p_balance_triggers_events_match ON p_balance_triggers_events (matchTriggeredId)`)
		},
	},
]
