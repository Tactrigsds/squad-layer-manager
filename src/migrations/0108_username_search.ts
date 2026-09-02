import type { MigrationDriver } from '@/server/migrate'

// Substring search over player names, for the history page's name filters. An fts5 trigram index answers
// `MATCH` for any needle of three or more characters, where the previous LIKE scan walked the whole players
// table. Trigger-maintained, and only when a name actually changes: the roster upsert rewrites every seen
// player's row constantly, and re-indexing on each of those would cost more than the searches save.
export async function up(db: MigrationDriver): Promise<void> {
	db.exec(`CREATE VIRTUAL TABLE usernameSearch USING fts5(
		username,
		usernameNoTag,
		eosId UNINDEXED,
		tokenize='trigram'
	)`)
	db.exec(`INSERT INTO usernameSearch (rowid, username, usernameNoTag, eosId)
		SELECT rowid, username, coalesce(usernameNoTag, ''), eosId FROM players`)

	db.exec(`CREATE TRIGGER playersUsernameSearchInsert AFTER INSERT ON players BEGIN
		INSERT INTO usernameSearch (rowid, username, usernameNoTag, eosId)
		VALUES (new.rowid, new.username, coalesce(new.usernameNoTag, ''), new.eosId);
	END`)
	db.exec(`CREATE TRIGGER playersUsernameSearchUpdate AFTER UPDATE OF username, usernameNoTag ON players
		WHEN new.username IS NOT old.username OR new.usernameNoTag IS NOT old.usernameNoTag
	BEGIN
		DELETE FROM usernameSearch WHERE rowid = old.rowid;
		INSERT INTO usernameSearch (rowid, username, usernameNoTag, eosId)
		VALUES (new.rowid, new.username, coalesce(new.usernameNoTag, ''), new.eosId);
	END`)
	db.exec(`CREATE TRIGGER playersUsernameSearchDelete AFTER DELETE ON players BEGIN
		DELETE FROM usernameSearch WHERE rowid = old.rowid;
	END`)
}
