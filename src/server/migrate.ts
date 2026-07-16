import type { Database } from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import * as DbBackup from './db-backup.ts'

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

export type BackupConfig = {
	// the database being migrated, which backups are named after
	dbPath: string
	dir: string
	// how many pre-migration backups to keep, this one included. 0 keeps all of them.
	retainCount: number
}

// The database is open in another process, so migrating it now is not safe.
export class DbInUseError extends Error {}

// The entry point for anything that migrates a database it did not just create: takes the db offline for the
// duration, snapshots it if there is anything to apply, and only then applies it. `runMigrations` remains the bare
// runner, for callers holding a database nothing else can reach (a fresh test db, a clone that isn't in place yet).
export async function applyPendingMigrations(
	driver: MigrationDriver,
	opts: { sqlDir: string; tsMigrations: TsMigration[]; log?: (msg: string) => void; backup?: BackupConfig },
): Promise<{ applied: string[] }> {
	const log = opts.log ?? (() => {})
	// checked before taking the lock, because there is usually nothing to do and a caller that isn't migrating has no
	// business demanding exclusive access: every boot goes through here, and one that overlaps the outgoing process's
	// shutdown would otherwise refuse to start over migrations it was never going to apply. Re-checked under the lock,
	// which is the check that counts.
	if (getPendingMigrations(driver, opts).length === 0) return { applied: [] }
	return await withDbLockedExclusively(driver, async () => {
		if (getPendingMigrations(driver, opts).length === 0) return { applied: [] }
		if (opts.backup) await takePreMigrationBackup(driver, opts.backup, log)
		return await runMigrations(driver, opts)
	})
}

async function takePreMigrationBackup(driver: MigrationDriver, backup: BackupConfig, log: (msg: string) => void) {
	const name = DbBackup.fileName(backup.dbPath, 'pre-migration')
	const destPath = path.join(backup.dir, name)
	const { sizeBytes } = await DbBackup.writeBackup({ destPath, snapshot: (dest) => driver.backup(dest) })
	log(`wrote pre-migration backup ${destPath} (${sizeBytes} bytes)`)
	// pruned after the new one is on disk, so a failure here can never leave us with none
	const pruned = DbBackup.pruneBackups({ ...backup, kind: 'pre-migration', keep: name })
	for (const stale of pruned) log(`deleted old pre-migration backup ${stale}`)
}

// Holds sqlite's exclusive lock on the database for the duration of `fn`, so nothing else can read or write it, and
// throws DbInUseError rather than proceeding if anything else already has it open.
//
// An exclusive lock, not `BEGIN IMMEDIATE`. A running app that happens not to be writing holds no write lock, so
// BEGIN IMMEDIATE succeeds against it and the check would pass exactly when it matters most: sqlite has no online-DDL
// guarantees, so a table-rebuild migration applied under a live app is how a database gets corrupted. Exclusive
// locking mode conflicts with any other connection, idle or not, and holds its locks until the mode is dropped again
// rather than until the transaction ends.
export async function withDbLockedExclusively<T>(driver: MigrationDriver, fn: () => Promise<T>): Promise<T> {
	// A WAL connection that goes exclusive before it has ever touched the db keeps its wal-index in heap memory and
	// never creates the -shm file -- and such a connection can't be put back into NORMAL locking mode at all, short of
	// reopening it. That's silent: the pragma below reports `normal` afterwards while the file stays locked for the life
	// of the connection, which for the boot path is the life of the app. One read first, and the -shm exists.
	driver.prepare('SELECT 1 FROM sqlite_master').get()
	driver.pragma('locking_mode = EXCLUSIVE')
	try {
		// the mode alone takes no locks; the first access after it does
		driver.exec('BEGIN IMMEDIATE')
		driver.exec('ROLLBACK')
	} catch (err) {
		if (driver.inTransaction) driver.exec('ROLLBACK')
		driver.pragma('locking_mode = NORMAL')
		if (isDatabaseLocked(err)) {
			throw new DbInUseError(
				`${driver.name} is open in another process. Stop the app (and any other \`db:migrate\` run) before migrating: `
					+ 'sqlite cannot safely apply schema changes to a database something else is using.',
				{ cause: err },
			)
		}
		throw err
	}
	try {
		return await fn()
	} finally {
		driver.pragma('locking_mode = NORMAL')
		// NORMAL doesn't take effect until the file is next accessed, so the locks would otherwise stay held for the
		// life of this connection -- which for the boot path is the life of the app.
		driver.exec('BEGIN IMMEDIATE')
		driver.exec('COMMIT')
	}
}

export function isDatabaseLocked(err: unknown): boolean {
	for (let e: unknown = err; e != null; e = (e as { cause?: unknown }).cause) {
		const code = (e as { code?: string }).code
		if (code === 'SQLITE_BUSY' || code === 'SQLITE_BUSY_SNAPSHOT') return true
	}
	return false
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
