import type { MigrationDriver } from '@/server/migrate'

// servers.teamswaps loses NOT NULL and its stale Map default. No saved swaps is stored as NULL, which the column
// refused, so every write that emptied the saved swaps failed.
//
// Runs with foreign_keys OFF (the runner's default), which keeps matchHistory, appEvents and timeouts pointing at
// the rebuilt table.

const COLUMNS = [
	'id',
	'displayName',
	'enabled',
	'defaultServer',
	'layerQueue',
	'teamswaps',
	'settings',
	'backburner',
	'switchRequests',
	'visibility',
	'ownerDiscordId',
]

export async function up(db: MigrationDriver): Promise<void> {
	const columns = db.prepare(`PRAGMA table_info(servers)`).all() as { name: string; notnull: number }[]
	if (!columns.find((c) => c.name === 'teamswaps')?.notnull) return

	db.exec(`
		CREATE TABLE \`__new_servers\` (
			\`id\` text PRIMARY KEY NOT NULL,
			\`displayName\` text NOT NULL,
			\`enabled\` integer DEFAULT true NOT NULL,
			\`defaultServer\` integer DEFAULT false NOT NULL,
			\`layerQueue\` text DEFAULT '{"json":[]}' NOT NULL,
			\`teamswaps\` text,
			\`settings\` text DEFAULT '{"json":{}}',
			\`backburner\` text DEFAULT '{"json":[]}' NOT NULL,
			\`switchRequests\` text DEFAULT '{"json":null}',
			\`visibility\` text DEFAULT 'public' NOT NULL,
			\`ownerDiscordId\` text
		)
	`)
	const list = COLUMNS.map((c) => `\`${c}\``).join(', ')
	db.exec(`INSERT INTO \`__new_servers\` (${list}) SELECT ${list} FROM \`servers\``)
	db.exec(`DROP TABLE \`servers\``)
	db.exec(`ALTER TABLE \`__new_servers\` RENAME TO \`servers\``)
}
