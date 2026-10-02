import type { MigrationDriver } from '@/server/migrate'

// Drops indexes no query reads, each of which every insert into its table still pays for:
//  - serverEvents.type and serverEvents.time: the history engine filters and pages on serverEventIndex, and
//    serverEvents is only ever read by match.
//  - players.eosId: the primary key's own index already covers it.
//  - players.createdAt and squads.name: never queried.
//  - players.username: only searched with a leading wildcard, which no index can serve.
//
// Adds an index for a damage-source filter, partial since only combat events carry one. A page filtered to a
// weapon otherwise walks every event by time until it has found a page of them (72ms for a weapon with a few
// hundred events among 1M, 0.07ms with the index).
export async function up(db: MigrationDriver): Promise<void> {
	for (const name of ['typeIndex', 'timeIndex', 'eosIdIndex', 'createdAtIndex', 'usernameIndex', 'nameIndex']) {
		db.exec(`DROP INDEX IF EXISTS ${name}`)
	}
	db.exec(
		'CREATE INDEX IF NOT EXISTS serverEventIndexDamageSourceTimeIndex ON serverEventIndex (damageSourceId, time) WHERE damageSourceId IS NOT NULL',
	)
}
