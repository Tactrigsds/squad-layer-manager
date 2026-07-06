import { tsMigrations } from '@/migrations/registry'
import * as Migrate from '@/server/migrate'
import DatabaseConstructor from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'

// Applies all pending schema (.sql) and data (.ts) migrations. Run in dev via
// `pnpm db:migrate`; in the production image via `pnpm db:migrate:prod` (bundled
// to dist-server/scripts/migrate.js, alongside the shipped drizzle-sqlite/ folder).
//
// DB_PATH default is kept in sync with drizzle.config.ts and src/server/env.ts.
const DB_PATH = process.env.DB_PATH ?? './data/main.sqlite3'
const SQL_DIR = path.resolve(process.cwd(), 'drizzle-sqlite')

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true })
const driver = new DatabaseConstructor(DB_PATH)
driver.pragma('journal_mode = WAL')
// Short timeout on purpose: if the write lock is held, that almost certainly means the app is
// running, and we want to fail fast with a clear message rather than block (and rather than
// contend for the lock and risk stalling live app writes). SQLite has no online-DDL guarantees,
// so migrating against a running app is unsafe regardless.
driver.pragma('busy_timeout = 2000')
// foreign_keys intentionally left at its default (OFF) during migrations, matching
// drizzle-kit — table-rebuild migrations rely on FK enforcement being off.

function isDatabaseLocked(err: unknown): boolean {
	for (let e: unknown = err; e != null; e = (e as { cause?: unknown }).cause) {
		const code = (e as { code?: string }).code
		if (code === 'SQLITE_BUSY' || code === 'SQLITE_BUSY_SNAPSHOT') return true
	}
	return false
}

function abortLocked(): never {
	console.error(
		'Database is locked — the app appears to be running. Stop the server before migrating; '
			+ 'SQLite cannot safely apply schema changes against a live app.',
	)
	process.exit(1)
}

// Probe the write lock before touching anything, so the common case (app running the whole time)
// fails immediately with a friendly message instead of mid-run.
try {
	driver.exec('BEGIN IMMEDIATE')
	driver.exec('ROLLBACK')
} catch (err) {
	if (driver.inTransaction) driver.exec('ROLLBACK')
	if (isDatabaseLocked(err)) abortLocked()
	throw err
}

try {
	const { applied } = await Migrate.runMigrations(driver, {
		sqlDir: SQL_DIR,
		tsMigrations,
		log: (msg) => console.log(msg),
	})
	console.log(applied.length ? `done — applied ${applied.length} migration(s)` : 'done — already up to date')
} catch (err) {
	// The app could have grabbed the lock between the probe and now (or mid-run).
	if (isDatabaseLocked(err)) abortLocked()
	throw err
} finally {
	driver.close()
}
