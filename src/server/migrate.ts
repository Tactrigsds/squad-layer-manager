import type { Database } from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'

// Custom migration runner that applies both generated `.sql` schema migrations
// (authored via `drizzle-kit generate`) and hand-written `.ts` data migrations in
// a single filename-ordered sequence. Replaces `drizzle-kit migrate` as the *apply*
// step; `drizzle-kit generate` still authors schema SQL + the journal.
//
// Design constraints:
//  - Migrations must be frozen in time: a `.ts` migration receives only the raw
//    better-sqlite3 driver and must not import from the rest of the codebase, so
//    that later refactors can never change the meaning of a historical migration.
//  - The server is bundled (rolldown), so `.ts` migrations can't be globbed off disk
//    at runtime in prod — they are passed in via a statically-imported registry
//    (see src/migrations/registry.ts). `.sql` files are read from the shipped
//    `drizzle-sqlite/` folder at runtime.

export type MigrationDriver = Database

// A hand-written data migration. `up` gets the raw driver and may be async (e.g. to
// stream/transform rows). It runs inside a BEGIN IMMEDIATE transaction owned by the
// runner, so it must not open its own transaction.
export type TsMigration = {
	// Zero-padded numeric prefix + description, WITHOUT extension, e.g. "0062_backfill_foo".
	// Must be globally unique and ordered against the `.sql` filenames.
	name: string
	up: (db: MigrationDriver) => void | Promise<void>
}

type Migration =
	| { name: string; kind: 'sql'; sql: string }
	| { name: string; kind: 'ts'; up: (db: MigrationDriver) => void | Promise<void> }

const TABLE = '_slm_migrations'

export async function runMigrations(
	driver: MigrationDriver,
	opts: { sqlDir: string; tsMigrations: TsMigration[]; log?: (msg: string) => void },
): Promise<{ applied: string[] }> {
	const log = opts.log ?? (() => {})

	driver.exec(`CREATE TABLE IF NOT EXISTS "${TABLE}" (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)`)

	// One-time transition: adopt migrations already applied by `drizzle-kit migrate`
	// so we don't try to re-run them (which would fail on CREATE TABLE etc.).
	baselineFromDrizzle(driver, opts.sqlDir, log)

	const applied = getAppliedNames(driver)
	const pending = collectMigrations(opts.sqlDir, opts.tsMigrations).filter((m) => !applied.has(m.name))

	const done: string[] = []
	const insert = driver.prepare(`INSERT INTO "${TABLE}" (name, applied_at) VALUES (?, ?)`)
	for (const m of pending) {
		log(`applying migration ${m.name}`)
		// Manual BEGIN/COMMIT rather than driver.transaction(): a `.ts` migration's `up`
		// may be async, which better-sqlite3's synchronous transaction API can't wrap.
		driver.exec('BEGIN IMMEDIATE')
		try {
			if (m.kind === 'sql') {
				for (const stmt of splitSqlStatements(m.sql)) driver.exec(stmt)
			} else {
				await m.up(driver)
			}
			insert.run(m.name, Date.now())
			driver.exec('COMMIT')
		} catch (err) {
			if (driver.inTransaction) driver.exec('ROLLBACK')
			throw new Error(`migration ${m.name} failed`, { cause: err })
		}
		done.push(m.name)
	}
	return { applied: done }
}

// Read-only: which migrations (by name) exist but aren't recorded as applied. Used by the
// server boot interlock (see db.ts) to refuse to serve against an un-migrated DB. Never writes
// — treats a missing `_slm_migrations` table as "nothing applied yet".
export function getPendingMigrations(driver: MigrationDriver, opts: { sqlDir: string; tsMigrations: TsMigration[] }): string[] {
	const applied = getAppliedNames(driver)
	return collectMigrationNames(opts.sqlDir, opts.tsMigrations).filter((name) => !applied.has(name))
}

function getAppliedNames(driver: MigrationDriver): Set<string> {
	const exists = driver.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='${TABLE}'`).get()
	if (!exists) return new Set()
	return new Set((driver.prepare(`SELECT name FROM "${TABLE}"`).all() as { name: string }[]).map((r) => r.name))
}

// Sorted, uniqueness-checked list of every migration name across the .sql folder and the .ts
// registry. Throws on a collision (same name as both a .sql file and a registry entry, or two
// registry entries), which is the single source of truth for ordering.
function collectMigrationNames(sqlDir: string, tsMigrations: TsMigration[]): string[] {
	const names = [
		...fs.readdirSync(sqlDir).filter((f) => f.endsWith('.sql')).map((f) => f.slice(0, -'.sql'.length)),
		...tsMigrations.map((m) => m.name),
	]
	const seen = new Set<string>()
	for (const name of names) {
		if (seen.has(name)) throw new Error(`duplicate migration name "${name}" — names must be unique across .sql and .ts`)
		seen.add(name)
	}
	// Filenames are zero-padded, so lexicographic order == numeric order.
	return names.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

function collectMigrations(sqlDir: string, tsMigrations: TsMigration[]): Migration[] {
	const ordered = collectMigrationNames(sqlDir, tsMigrations)
	const sqlNames = new Set(fs.readdirSync(sqlDir).filter((f) => f.endsWith('.sql')).map((f) => f.slice(0, -'.sql'.length)))
	const tsByName = new Map(tsMigrations.map((m) => [m.name, m]))
	return ordered.map((name): Migration =>
		sqlNames.has(name)
			? { name, kind: 'sql', sql: fs.readFileSync(path.join(sqlDir, `${name}.sql`), 'utf8') }
			: { name, kind: 'ts', up: tsByName.get(name)!.up }
	)
}

// drizzle-kit generate emits multi-statement SQL split by this marker. better-sqlite3's
// exec() can run multiple statements at once, but splitting yields precise per-statement errors.
function splitSqlStatements(sql: string): string[] {
	return sql
		.split('--> statement-breakpoint')
		.map((s) => s.trim())
		.filter((s) => s.length > 0)
}

// Seeds `_slm_migrations` from drizzle's `__drizzle_migrations` the first time the runner
// sees an already-migrated DB. drizzle records folderMillis (== journal `when`) per applied
// migration, so every journal entry with `when <= max(created_at)` is already applied.
// No-op on a fresh DB (no drizzle table) — there the runner applies everything itself.
function baselineFromDrizzle(driver: MigrationDriver, sqlDir: string, log: (msg: string) => void): void {
	const count = (driver.prepare(`SELECT COUNT(*) AS c FROM "${TABLE}"`).get() as { c: number }).c
	if (count > 0) return

	const hasDrizzle = driver
		.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='__drizzle_migrations'`)
		.get()
	if (!hasDrizzle) return

	const maxAt = (driver.prepare(`SELECT MAX(created_at) AS maxAt FROM __drizzle_migrations`).get() as {
		maxAt: number | null
	}).maxAt
	if (maxAt == null) return

	const journalPath = path.join(sqlDir, 'meta', '_journal.json')
	const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as { entries: { tag: string; when: number }[] }

	const insert = driver.prepare(`INSERT OR IGNORE INTO "${TABLE}" (name, applied_at) VALUES (?, ?)`)
	const baseline = journal.entries.filter((e) => e.when <= maxAt)
	driver.transaction(() => {
		for (const e of baseline) insert.run(e.tag, e.when)
	})()
	log(`baselined ${baseline.length} migration(s) from __drizzle_migrations`)
}
