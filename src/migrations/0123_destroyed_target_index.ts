import type { MigrationDriver } from '@/server/migrate'

// Adds what was destroyed or hit to both event indexes, for VEHICLE_DESTROYED, DEPLOYABLE_DESTROYED and FOB_RADIO_DAMAGED: the blueprint,
// interned in damageSources beside the weapons that destroy them, and its class (MBT, MINE, ...).
//
// Last columns on purpose: sqlite trims a record at its final non-null column, so columns only these events fill
// cost nothing on the rows the tables are mostly made of. Nothing to backfill, since neither event existed before.
export async function up(db: MigrationDriver): Promise<void> {
	for (const table of ['playerEventIndex', 'serverEventIndex']) {
		db.exec(`ALTER TABLE ${table} ADD COLUMN targetId INTEGER REFERENCES damageSources(id)`)
		db.exec(`ALTER TABLE ${table} ADD COLUMN targetType TEXT`)
	}
}
