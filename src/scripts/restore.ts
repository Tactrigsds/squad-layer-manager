import { tsMigrations } from '@/migrations/registry'
import * as DbBackup from '@/server/db-backup'
import * as Env from '@/server/env'
import * as Migrate from '@/server/migrate'
import DatabaseConstructor, { type Database } from 'better-sqlite3'
import * as DateFns from 'date-fns'
import fs from 'node:fs'
import path from 'node:path'
import * as readline from 'node:readline/promises'
import * as Stream from 'node:stream/promises'
import { parseArgs } from 'node:util'
import * as Zlib from 'node:zlib'

// Puts a backup back. Run in dev via `pnpm db:restore`; in the production image via `pnpm db:restore:prod`, with the
// app stopped (restore.sh does that choreography for a docker deployment).
//
// This exists because the manual version is a loaded gun. `gunzip -c backup.gz > data/db.sqlite3` looks complete and
// is not: the old -wal is still sitting there, sqlite replays it over the file you just restored, and you silently get
// the OLD database back, with integrity_check calling it ok. Doing it while the app is running is worse -- the app
// keeps writing to an unlinked inode, those writes are lost, and nothing anywhere raises an error.

const args = parseArgs({
	options: {
		list: { type: 'boolean', default: false },
		'pre-migration': { type: 'boolean', default: false },
		latest: { type: 'boolean', default: false },
		from: { type: 'string' },
		yes: { type: 'boolean', short: 'y', default: false },
	},
	allowPositionals: false,
})

Env.ensureEnvSetup()
const ENV = Env.getEnvBuilder({ ...Env.groups.db, ...Env.groups.backups })()
const DB_PATH = path.resolve(ENV.DB_PATH)

type Candidate = { fileName: string; path: string; kind: DbBackup.BackupKind; takenAt: Date; sizeBytes: number }

// every backup of this database, newest first, whatever kind
function candidates(): Candidate[] {
	if (!fs.existsSync(ENV.BACKUPS_DIR)) return []
	const names = fs.readdirSync(ENV.BACKUPS_DIR)
	return DbBackup.backupFiles(names, ENV.DB_PATH).map(({ name, kind }) => {
		const p = path.join(ENV.BACKUPS_DIR, name)
		const stat = fs.statSync(p)
		return { fileName: name, path: p, kind, takenAt: stat.mtime, sizeBytes: stat.size }
	})
}

function describe(c: Candidate) {
	const size = `${(c.sizeBytes / 1024 / 1024).toFixed(1)} MB`
	return `${c.fileName}\n    ${c.kind}, taken ${DateFns.format(c.takenAt, 'yyyy-MM-dd HH:mm:ss')}, ${size}`
}

function list() {
	const all = candidates()
	if (all.length === 0) {
		console.log(`no backups of ${path.basename(ENV.DB_PATH)} in ${ENV.BACKUPS_DIR}`)
		return
	}
	console.log(`backups of ${path.basename(ENV.DB_PATH)} in ${ENV.BACKUPS_DIR}, newest first:\n`)
	for (const c of all) console.log(`  ${describe(c)}\n`)
}

function pick(): Candidate {
	if (args.values.from) {
		// an explicit path is taken as given: it's the escape hatch for a backup pulled off the sftp target, which
		// won't be in BACKUPS_DIR and may not be named the way we name ours.
		const p = path.resolve(args.values.from)
		const fallback = path.join(ENV.BACKUPS_DIR, args.values.from)
		const resolved = fs.existsSync(p) ? p : fs.existsSync(fallback) ? fallback : null
		if (!resolved) fail(`no such backup: ${args.values.from}`)
		const stat = fs.statSync(resolved)
		return {
			fileName: path.basename(resolved),
			path: resolved,
			kind: DbBackup.kindOf(path.basename(resolved), ENV.DB_PATH) ?? 'periodic',
			takenAt: stat.mtime,
			sizeBytes: stat.size,
		}
	}

	const all = candidates()
	const wanted = args.values['pre-migration'] ? all.filter(c => c.kind === 'pre-migration') : all
	if (wanted.length === 0) {
		fail(
			args.values['pre-migration']
				? `no pre-migration backups of ${path.basename(ENV.DB_PATH)} in ${ENV.BACKUPS_DIR}`
				: `no backups of ${path.basename(ENV.DB_PATH)} in ${ENV.BACKUPS_DIR}`,
		)
	}
	return wanted[0]
}

function fail(msg: string): never {
	console.error(msg)
	process.exit(1)
}

async function gunzipTo(sourcePath: string, destPath: string) {
	await Stream.pipeline(fs.createReadStream(sourcePath), Zlib.createGunzip(), fs.createWriteStream(destPath))
}

// a sqlite database is three files, and the other two are only ever meaningful next to the one they were named for
function rmDbFiles(dbPath: string, opts?: { keepDb?: boolean }) {
	for (const suffix of opts?.keepDb ? ['-wal', '-shm'] : ['', '-wal', '-shm']) fs.rmSync(dbPath + suffix, { force: true })
}

function assertIntact(dbPath: string) {
	const db = new DatabaseConstructor(dbPath, { readonly: true })
	try {
		const res = db.pragma('integrity_check', { simple: true })
		if (res !== 'ok') fail(`the restored database failed its integrity check (${String(res)}); the original is untouched`)
	} finally {
		db.close()
	}
}

// how far the restored db is behind the code that is about to run against it. Restoring a pre-migration backup and then
// starting the same build just re-applies the migration you were rolling back, which is worth saying out loud.
function pendingAfterRestore(dbPath: string) {
	const db = new DatabaseConstructor(dbPath, { readonly: true })
	try {
		return Migrate.getPendingMigrations(db, { sqlDir: path.resolve(process.cwd(), 'drizzle-sqlite'), tsMigrations })
	} finally {
		db.close()
	}
}

async function confirm(question: string) {
	if (args.values.yes) return
	if (!process.stdin.isTTY) fail('refusing to restore without a confirmation. Re-run with --yes if you mean it.')
	const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
	try {
		const answer = await rl.question(`${question} [y/N] `)
		if (!/^y(es)?$/i.test(answer.trim())) fail('aborted, nothing was changed')
	} finally {
		rl.close()
	}
}

// Proves nothing else has the database open, and keeps holding it while we look at the backup. An idle app holds no
// write lock, so this has to be the exclusive-lock check the migration runner uses rather than a BEGIN IMMEDIATE probe
// -- restoring under a running app leaves it writing to an unlinked inode, losing those writes silently.
function lockExisting(): Database | null {
	if (!fs.existsSync(DB_PATH)) return null
	const driver = new DatabaseConstructor(DB_PATH)
	driver.pragma('busy_timeout = 2000')
	try {
		driver.prepare('SELECT 1 FROM sqlite_master').get()
		driver.pragma('locking_mode = EXCLUSIVE')
		driver.exec('BEGIN IMMEDIATE')
		driver.exec('ROLLBACK')
		return driver
	} catch (err) {
		if (driver.inTransaction) driver.exec('ROLLBACK')
		driver.close()
		if (Migrate.isDatabaseLocked(err)) {
			fail(
				`${ENV.DB_PATH} is open in another process. Stop the app before restoring: it would go on writing to the database you are replacing, and lose those writes.`,
			)
		}
		throw err
	}
}

if (args.values.list) {
	list()
	process.exit(0)
}
if (!args.values.from && !args.values['pre-migration'] && !args.values.latest) {
	console.error('pick a backup: --latest (newest of any kind), --pre-migration (newest taken before a migration),')
	console.error('or --from <file>. `--list` shows what there is.')
	process.exit(1)
}

const backup = pick()
const existing = lockExisting()
try {
	console.log(`restoring ${describe(backup)}\n     -> ${ENV.DB_PATH}\n`)
	if (existing) {
		await confirm(`this replaces the current ${ENV.DB_PATH}. It will be kept, renamed aside. Continue?`)
	}

	// unpacked and checked before anything is moved, so a corrupt archive costs nothing
	const tmpPath = `${DB_PATH}.restore-${process.pid}.tmp`
	rmDbFiles(tmpPath)
	await gunzipTo(backup.path, tmpPath)
	assertIntact(tmpPath)

	const pending = pendingAfterRestore(tmpPath)

	// An archive holds one file, so a -wal next to the unpacked copy can only be the empty one sqlite made for the
	// read-only connections just above, which they aren't allowed to tidy up on close. Left there they would follow
	// the rename by name and be replayed over the restored database.
	rmDbFiles(tmpPath, { keepDb: true })

	// The lock has to go before the files move: sqlite finds a database's -wal by its path, so a connection left open
	// across the rename would checkpoint into whatever ends up at that path -- i.e. into the database we just restored.
	// Closing is also what folds the current db's -wal into it, which is what makes the copy we keep self-contained.
	if (existing) {
		existing.pragma('wal_checkpoint(TRUNCATE)')
		existing.close()

		const asideName = `${path.basename(DB_PATH)}.replaced-${DateFns.format(new Date(), 'yyyyMMdd-HHmmss')}`
		const asidePath = path.join(path.dirname(DB_PATH), asideName)
		fs.renameSync(DB_PATH, asidePath)
		// checkpointed above, so these hold nothing the copy needs. Left in place they would be replayed over the
		// restored database, which is the whole trap this script exists to avoid.
		rmDbFiles(DB_PATH, { keepDb: true })
		console.log(`kept the database you replaced as ${asidePath}`)
	}

	fs.renameSync(tmpPath, DB_PATH)
	console.log(`restored ${ENV.DB_PATH} from ${backup.fileName}`)

	if (pending.length > 0) {
		console.log(
			`\nnote: this database is ${pending.length} migration(s) behind this build (${pending.join(', ')}).\n`
				+ 'Starting the app will apply them again (taking a fresh pre-migration backup first). If you are rolling back a\n'
				+ 'bad upgrade, roll the image back to the matching version too, or the migration you just undid comes straight back.',
		)
	}
} finally {
	if (existing?.open) existing.close()
}
