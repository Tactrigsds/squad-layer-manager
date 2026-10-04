import type { MigrationDriver } from '@/server/migrate'

// A filter can be owned by a user, a plugin or SLM itself.
//
//   filters.owner  -> filters.ownerUserId
//   filters        += ownerPluginId, references plugins
//   filters        += check: at most one of ownerUserId and ownerPluginId
//
// With neither owner column set, SLM owns the filter. Two kinds of existing row become SLM's:
//  - a fresh install's seeded filters, which were owned by a stand-in user with discordId 1 ("SLM")
//  - filters whose owner was deleted, which `on delete set null` had already left with no owner
//
// The stand-in user is deleted along with its account, unless some other row still points at it.
//
// Runs with foreign_keys OFF (the runner's default), which is what makes the table rebuild safe: the contributor
// tables cascade on a filter's deletion.

const SEED_USER_ID = '1'

function hasColumn(db: MigrationDriver, table: string, column: string): boolean {
	const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
	return columns.some((c) => c.name === column)
}

// every (table, column) with a foreign key into `target`
function inboundRefs(db: MigrationDriver, target: string): { table: string; column: string }[] {
	const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]
	const refs: { table: string; column: string }[] = []
	for (const { name } of tables) {
		const fks = db.prepare(`PRAGMA foreign_key_list(\`${name}\`)`).all() as { table: string; from: string }[]
		for (const fk of fks) if (fk.table === target) refs.push({ table: name, column: fk.from })
	}
	return refs
}

function isReferenced(db: MigrationDriver, refs: { table: string; column: string }[], id: string): boolean {
	return refs.some(({ table, column }) => db.prepare(`SELECT 1 FROM \`${table}\` WHERE \`${column}\` = ? LIMIT 1`).get(id) !== undefined)
}

export async function up(db: MigrationDriver): Promise<void> {
	if (!hasColumn(db, 'filters', 'owner')) return

	db.exec(`
		CREATE TABLE \`__new_filters\` (
			\`id\` text PRIMARY KEY NOT NULL,
			\`name\` text NOT NULL,
			\`description\` text,
			\`filter\` text NOT NULL,
			\`ownerUserId\` text,
			\`ownerPluginId\` text,
			\`alertMessage\` text,
			\`emoji\` text,
			\`invertedAlertMessage\` text,
			\`invertedEmoji\` text,
			FOREIGN KEY (\`ownerUserId\`) REFERENCES \`users\`(\`discordId\`) ON UPDATE no action ON DELETE set null,
			FOREIGN KEY (\`ownerPluginId\`) REFERENCES \`plugins\`(\`id\`) ON UPDATE no action ON DELETE set null,
			CONSTRAINT \`filtersSingleOwner\` CHECK(\`ownerUserId\` IS NULL OR \`ownerPluginId\` IS NULL)
		)
	`)
	db.prepare(
		`INSERT INTO \`__new_filters\`
			(\`id\`, \`name\`, \`description\`, \`filter\`, \`ownerUserId\`, \`ownerPluginId\`, \`alertMessage\`, \`emoji\`, \`invertedAlertMessage\`, \`invertedEmoji\`)
		 SELECT \`id\`, \`name\`, \`description\`, \`filter\`, NULLIF(\`owner\`, ?), NULL, \`alertMessage\`, \`emoji\`, \`invertedAlertMessage\`, \`invertedEmoji\`
		 FROM \`filters\``,
	).run(SEED_USER_ID)
	db.exec(`DROP TABLE \`filters\``)
	db.exec(`ALTER TABLE \`__new_filters\` RENAME TO \`filters\``)

	// the stand-in's users row references its account, so that one reference does not keep the account alive
	const userRefs = inboundRefs(db, 'users')
	const accountRefs = inboundRefs(db, 'discordAccounts').filter((ref) => ref.table !== 'users')
	if (isReferenced(db, userRefs, SEED_USER_ID) || isReferenced(db, accountRefs, SEED_USER_ID)) return
	db.prepare(`DELETE FROM \`users\` WHERE \`discordId\` = ?`).run(SEED_USER_ID)
	db.prepare(`DELETE FROM \`discordAccounts\` WHERE \`discordId\` = ?`).run(SEED_USER_ID)
}
