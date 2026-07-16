import { tsMigrations } from '@/migrations/registry'
import * as Env from '@/server/env'
import * as Migrate from '@/server/migrate'
import DatabaseConstructor from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'

// Applies all pending schema (.sql) and data (.ts) migrations. Run in dev via
// `pnpm db:migrate`; in the production image via `pnpm db:migrate:prod` (bundled
// to dist-server/scripts/migrate.js, alongside the shipped drizzle-sqlite/ folder).
//
// The db is snapshotted first and held offline for the run; the app applying migrations itself at boot
// (DB_AUTOMIGRATE, the default) goes through the same path. See src/server/migrate.ts.

Env.ensureEnvSetup()
const ENV = Env.getEnvBuilder({ ...Env.groups.db, ...Env.groups.backups })()
const SQL_DIR = path.resolve(process.cwd(), 'drizzle-sqlite')

fs.mkdirSync(path.dirname(ENV.DB_PATH), { recursive: true })
const driver = new DatabaseConstructor(ENV.DB_PATH)
driver.pragma('journal_mode = WAL')
// Short timeout on purpose: if the db is in use, that almost certainly means the app is running, and we want to fail
// fast with a clear message rather than block (and rather than contend for the lock and risk stalling live app writes).
driver.pragma('busy_timeout = 2000')
// foreign_keys intentionally left at its default (OFF) during migrations, matching
// drizzle-kit — table-rebuild migrations rely on FK enforcement being off.

try {
	const { applied } = await Migrate.applyPendingMigrations(driver, {
		sqlDir: SQL_DIR,
		tsMigrations,
		log: (msg) => console.log(msg),
		backup: { dbPath: ENV.DB_PATH, dir: ENV.BACKUPS_DIR, retainCount: ENV.PRE_MIGRATION_BACKUPS_RETAIN_COUNT },
	})
	console.log(applied.length ? `done — applied ${applied.length} migration(s)` : 'done — already up to date')
} catch (err) {
	if (err instanceof Migrate.DbInUseError) {
		console.error(err.message)
		process.exit(1)
	}
	throw err
} finally {
	driver.close()
}
