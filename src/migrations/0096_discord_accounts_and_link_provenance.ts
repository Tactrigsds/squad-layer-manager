import type { MigrationDriver } from '@/server/migrate'

// Splits the discord account away from the SLM user, and records where a steam link came from.
//
//   users(discordId, username, nickname)  -> discordAccounts(discordId, username, updatedAt)
//                                          + users(discordId, nickname)
//   linkedSteamAccounts.discordId          -> references discordAccounts rather than users
//   linkedSteamAccounts                    += origin, linkedBy
//
// A steam account can now be linked to somebody who has never signed in, so the identity a link points at cannot be
// an SLM user row. `users` keeps its meaning -- has signed in -- because every ownership and actor reference in the
// schema is a FK to it, and recording a person's identity must not grant them one.
//
// Every existing link was made by its own owner through the self-serve settings page, so all of them migrate to
// origin='self-serve' with the owner as the actor.
//
// Runs with foreign_keys OFF (the runner's default), which is what makes the table rebuilds safe: `users` is
// referenced by four other tables, and their rows must survive it being swapped out from under them.

function hasTable(db: MigrationDriver, name: string): boolean {
	const row = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name)
	return row !== undefined
}

function hasColumn(db: MigrationDriver, table: string, column: string): boolean {
	const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
	return columns.some((c) => c.name === column)
}

export async function up(db: MigrationDriver): Promise<void> {
	if (!hasTable(db, 'users')) return

	if (!hasTable(db, 'discordAccounts')) {
		db.exec(`
			CREATE TABLE \`discordAccounts\` (
				\`discordId\` text PRIMARY KEY NOT NULL,
				\`username\` text NOT NULL,
				\`updatedAt\` integer NOT NULL
			)
		`)
		// the accounts we know of are exactly the users we have, and their username is already the discord one
		db.prepare(
			`INSERT INTO \`discordAccounts\` (\`discordId\`, \`username\`, \`updatedAt\`)
			 SELECT \`discordId\`, \`username\`, ? FROM \`users\``,
		).run(Date.now())
	}

	if (hasColumn(db, 'users', 'username')) {
		db.exec(`
			CREATE TABLE \`__new_users\` (
				\`discordId\` text PRIMARY KEY NOT NULL,
				\`nickname\` text,
				FOREIGN KEY (\`discordId\`) REFERENCES \`discordAccounts\`(\`discordId\`) ON UPDATE no action ON DELETE cascade
			)
		`)
		db.exec(`INSERT INTO \`__new_users\` (\`discordId\`, \`nickname\`) SELECT \`discordId\`, \`nickname\` FROM \`users\``)
		db.exec(`DROP TABLE \`users\``)
		db.exec(`ALTER TABLE \`__new_users\` RENAME TO \`users\``)
	}

	if (hasTable(db, 'linkedSteamAccounts') && !hasColumn(db, 'linkedSteamAccounts', 'origin')) {
		db.exec(`
			CREATE TABLE \`__new_linkedSteamAccounts\` (
				\`steam64Id\` text PRIMARY KEY NOT NULL,
				\`discordId\` text NOT NULL,
				\`origin\` text NOT NULL,
				\`linkedBy\` text,
				\`createdAt\` integer NOT NULL,
				FOREIGN KEY (\`discordId\`) REFERENCES \`discordAccounts\`(\`discordId\`) ON UPDATE no action ON DELETE cascade,
				FOREIGN KEY (\`linkedBy\`) REFERENCES \`users\`(\`discordId\`) ON UPDATE no action ON DELETE set null
			)
		`)
		db.exec(`
			INSERT INTO \`__new_linkedSteamAccounts\` (\`steam64Id\`, \`discordId\`, \`origin\`, \`linkedBy\`, \`createdAt\`)
			SELECT \`steam64Id\`, \`discordId\`, 'self-serve', \`discordId\`, \`createdAt\` FROM \`linkedSteamAccounts\`
		`)
		db.exec(`DROP TABLE \`linkedSteamAccounts\``)
		db.exec(`ALTER TABLE \`__new_linkedSteamAccounts\` RENAME TO \`linkedSteamAccounts\``)
		db.exec(`CREATE INDEX \`linkedSteamDiscordIdIndex\` ON \`linkedSteamAccounts\` (\`discordId\`)`)
	}
}
