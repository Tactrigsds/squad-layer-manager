import { type MigrationDriver } from '@/server/migrate'

// Template for a hand-written data migration. Copy to NNNN_description.ts and register
// it in src/migrations/registry.ts.
//
// Rules for migrations — they are frozen in time:
//  - Import NOTHING from the rest of the app (no schema, env, models). A later refactor
//    must never be able to change what this migration did. Inline any constants/shapes.
//  - `db` is the raw better-sqlite3 driver. Use db.prepare()/db.exec() directly, or wrap
//    with `drizzle(db)` locally if you want a query builder — but only against literal SQL
//    or a schema snapshot copied into this file, never the live app schema.
//  - Do NOT open a transaction: the runner already wraps this in BEGIN IMMEDIATE and will
//    ROLLBACK if `up` throws.
//  - Foreign keys are OFF during migrations (as with drizzle-kit). Enable per-migration
//    with `db.pragma('foreign_keys = ON')` if you need enforcement.
export async function up(db: MigrationDriver): Promise<void> {
	// Example: backfill a column with arbitrary TypeScript logic.
	const rows = db.prepare(`SELECT id, raw FROM some_table WHERE computed IS NULL`).all() as {
		id: number
		raw: string
	}[]
	const update = db.prepare(`UPDATE some_table SET computed = ? WHERE id = ?`)
	for (const row of rows) {
		const computed = row.raw.trim().toLowerCase() // ...arbitrary transform
		update.run(computed, row.id)
	}
}
