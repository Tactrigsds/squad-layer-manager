import type { Database } from 'better-sqlite3'

// A tiny key/value table recording which build a database belongs to: the git sha and branch of the app that last
// ran against it. It rides inside the database file, so every snapshot -- periodic or pre-migration -- carries it for
// free, and `restore.sh` can read it back out of a backup to tell you which image to pin before starting the app.
//
// Deliberately outside the migration sequence, like `_slm_migrations`: it is infrastructure metadata, not schema, and
// an old database that predates it is fine (reads treat a missing table as "unknown"). Driver-only, no env import, so
// the restore path can read it before the rest of the app is set up.
const TABLE = '_slm_meta'

export type BuildStamp = { gitSha: string; gitBranch: string }

// Records the running build against the database. Called on every boot: the value is the build that owns the database
// from now on, which for a periodic backup is exactly the version to restore to. A pre-migration snapshot is taken
// before this runs, so it keeps the PREVIOUS build's stamp -- the one a bad upgrade rolls back to.
export function writeBuildStamp(driver: Database, stamp: BuildStamp): void {
	driver.exec(`CREATE TABLE IF NOT EXISTS "${TABLE}" (key TEXT PRIMARY KEY, value TEXT NOT NULL)`)
	const upsert = driver.prepare(`INSERT INTO "${TABLE}" (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
	upsert.run('git_sha', stamp.gitSha)
	upsert.run('git_branch', stamp.gitBranch)
}

// null when the database carries no stamp: it predates this table, or was created by something that never booted the
// app (a fresh clone, say). Never writes -- a missing table is "unknown", not an error.
export function readBuildStamp(driver: Database): BuildStamp | null {
	const exists = driver.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='${TABLE}'`).get()
	if (!exists) return null
	const rows = driver.prepare(`SELECT key, value FROM "${TABLE}"`).all() as { key: string; value: string }[]
	const byKey = new Map(rows.map((r) => [r.key, r.value]))
	const gitSha = byKey.get('git_sha')
	const gitBranch = byKey.get('git_branch')
	if (gitSha === undefined || gitBranch === undefined) return null
	return { gitSha, gitBranch }
}
