import { defineTables, type PluginMigration } from 'slm/plugin'

import manifest from './plugin.ts'

// names are built the way schema.ts builds them, from the manifest rather than as literals. The
// unprefixed names are spelled out here rather than imported from schema.ts: a migration is frozen in
// time, and renaming a table there must not reach back and change what an applied migration did.
const t = defineTables(manifest)
const events = t.name('events')

// The core migration that removed native balance triggers RENAMED balanceTriggerEvents to
// p_balance_triggers_events rather than dropping it, because core migrations run at boot, before
// any plugin activates. So this either creates the table fresh, or reshapes the adopted one:
// evaluationResult (the whole superjson-wrapped evaluation) becomes input (just the relevant
// slice) plus message (the sentence the UI shows), and time is backfilled from the triggering
// match's end time.
export const migrations: PluginMigration[] = [
	{
		name: '0001_init',
		up: (db) => {
			db.exec(`CREATE TABLE IF NOT EXISTS ${events} (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				triggerId TEXT NOT NULL,
				triggerVersion INTEGER NOT NULL,
				matchTriggeredId INTEGER,
				strongerTeam TEXT NOT NULL,
				level TEXT NOT NULL,
				input TEXT NOT NULL DEFAULT '{}',
				message TEXT NOT NULL DEFAULT '',
				time INTEGER NOT NULL DEFAULT 0
			)`)
			const cols = (db.prepare(`SELECT name FROM pragma_table_info('${events}')`).all() as { name: string }[]).map((c) => c.name)
			if (cols.includes('evaluationResult')) {
				// before the rename: it is the only copy of the sentence, and the reshape below drops it
				if (!cols.includes('message')) {
					db.exec(`ALTER TABLE ${events} ADD COLUMN message TEXT NOT NULL DEFAULT ''`)
					db.exec(`UPDATE ${events} SET message = COALESCE(json_extract(evaluationResult, '$.json.messageTemplate'), '')`)
				}
				db.exec(`ALTER TABLE ${events} RENAME COLUMN evaluationResult TO input`)
				db.exec(`UPDATE ${events} SET input = COALESCE(json_extract(input, '$.json.relevantInput'), '{}')`)
			}
			if (!cols.includes('time')) {
				db.exec(`ALTER TABLE ${events} ADD COLUMN time INTEGER NOT NULL DEFAULT 0`)
				db.exec(`UPDATE ${events} SET time = COALESCE(
					(SELECT mh.endTime FROM matchHistory mh WHERE mh.id = ${events}.matchTriggeredId), 0)`)
			}
			db.exec(`CREATE INDEX IF NOT EXISTS ${events}_match ON ${events} (matchTriggeredId)`)
		},
	},
	{
		// for a database that applied 0001 before it captured the sentence. There is nothing left to
		// backfill from by then, so those rows show their trigger's name without a description.
		name: '0002_event_message',
		up: (db) => {
			const cols = (db.prepare(`SELECT name FROM pragma_table_info('${events}')`).all() as { name: string }[]).map((c) => c.name)
			if (!cols.includes('message')) {
				db.exec(`ALTER TABLE ${events} ADD COLUMN message TEXT NOT NULL DEFAULT ''`)
			}
		},
	},
]
