import { assertNever } from '@/lib/type-guards'
import { tsMigrations } from '@/migrations/registry'
import type * as CS from '@/models/context-shared'
import { initModule } from '@/server/logger'
import DatabaseConstructor, { type Database } from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { highlight } from 'sql-highlight'

import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import type * as C from './context.ts'
import * as DbMeta from './db-meta.ts'
import * as Env from './env.ts'
import * as Migrate from './migrate.ts'

export type Db = BetterSQLite3Database<Record<string, never>>

const module = initModule('db')
let log!: CS.Logger

let driver!: Database

// backups: boot takes a pre-migration snapshot, which is named after DB_PATH and retained in BACKUPS_DIR
const envBuilder = Env.getEnvBuilder({ ...Env.groups.general, ...Env.groups.db, ...Env.groups.backups })
let ENV!: ReturnType<typeof envBuilder>
let db: Db
let dbRedactParams: Db

// the DB_PATH default was ./data/main.sqlite3 before backups landed (they're named after the db file, and "main" said
// nothing). A deployment that relied on the default would otherwise come up silently on a fresh, empty database while
// its real one sat next to it, so refuse to start instead. Safe to delete once no deployment has the old file.
const LEGACY_DB_PATH = './data/main.sqlite3'
function assertNotLegacyDbPath() {
	if (process.env.DB_PATH || !fs.existsSync(LEGACY_DB_PATH)) return
	throw new Error(
		`Refusing to start: found a database at the old default path ${LEGACY_DB_PATH}, but the default is now ${ENV.DB_PATH}. `
			+ `Rename it (along with any -wal/-shm files) to ${ENV.DB_PATH}, or set DB_PATH=${LEGACY_DB_PATH} to keep using it.`,
	)
}

export async function setup(opts?: { skipMigrationCheck?: boolean }) {
	log = module.getLogger()
	ENV = envBuilder()
	assertNotLegacyDbPath()

	fs.mkdirSync(path.dirname(ENV.DB_PATH), { recursive: true })
	driver = new DatabaseConstructor(ENV.DB_PATH)
	driver.pragma('journal_mode = WAL')
	driver.pragma('synchronous = NORMAL')
	driver.pragma('busy_timeout = 5000')

	// Schema-vs-code guard, run while foreign_keys is still at its default (OFF) — same as the
	// standalone `pnpm db:migrate`, since drizzle-kit's table-rebuild migrations require FK
	// enforcement off. Boot applies pending migrations itself by default, backing the DB up first and
	// refusing to touch a DB another process has open; with DB_AUTOMIGRATE off it merely refuses to run
	// against a DB that's behind, never taking a write lock or mutating the DB here. Scripts that
	// intentionally run pre-migration pass skipMigrationCheck.
	if (!opts?.skipMigrationCheck) {
		const migrateOpts = { sqlDir: path.resolve(process.cwd(), 'drizzle-sqlite'), tsMigrations }
		if (ENV.DB_AUTOMIGRATE) {
			const { applied } = await Migrate.applyPendingMigrations(driver, {
				...migrateOpts,
				log: (msg) => log.info(msg),
				backup: { dbPath: ENV.DB_PATH, dir: ENV.BACKUPS_DIR, retainCount: ENV.BACKUPS_RETAIN_COUNT },
			})
			if (applied.length > 0) log.info('DB_AUTOMIGRATE applied %d migration(s)', applied.length)
		} else {
			const pending = Migrate.getPendingMigrations(driver, migrateOpts)
			if (pending.length > 0) {
				throw new Error(
					`Refusing to start: ${pending.length} pending database migration(s): ${pending.join(', ')}. `
						+ `Run \`pnpm db:migrate\` (prod: \`pnpm db:migrate:prod\`) before starting, or set DB_AUTOMIGRATE=true.`,
				)
			}
		}

		// stamp the database with the build now taking ownership of it, so a backup of it can later say which image to
		// restore to. After migrations on purpose: a pre-migration snapshot is already on disk carrying the previous
		// build's stamp, which is the one a rollback wants.
		DbMeta.writeBuildStamp(driver, { gitSha: ENV.PUBLIC_GIT_SHA, gitBranch: ENV.PUBLIC_GIT_BRANCH })
	}

	// mysql enforced the schema's FK cascades; sqlite only does so with this pragma (per-connection).
	// Set after migrations so table-rebuild migrations run with enforcement off (see above).
	driver.pragma('foreign_keys = ON')

	db = drizzle(driver, {
		logger: {
			logQuery: (query: string, params: unknown[]) => {
				log.debug('%s %o', highlight(query), params)
			},
		},
	})

	dbRedactParams = drizzle(driver, {
		logger: {
			logQuery: (query: string, params: unknown[]) => {
				log.debug('%s', highlight(query))
			},
		},
	})
}

// sqlite's online backup API (the same thing the shell's `.backup` runs): copies the database page by page from the
// live connection, giving a consistent snapshot without taking the db offline. Writes made through this connection
// while it runs are applied to the copy too, so the snapshot can't tear. better-sqlite3 transfers in 100-page chunks
// with a setImmediate between them, so this doesn't block the event loop despite the driver being synchronous.
// The destination is written by sqlite itself, so callers should hand it a temp path and rename into place -- a crash
// mid-backup otherwise leaves a truncated file that looks whole.
export async function backupTo(destPath: string) {
	return await driver.backup(destPath)
}

// try to use the getter instead of passing the db instance around by itself. that way the logger is always up-to-date. not expensive.
export function addPooledDb<T extends object>(ctx: T) {
	if ('db' in ctx) return ctx as T & C.Db
	return {
		...ctx,
		db(opts?: { redactParams?: boolean }) {
			const redactParams = opts?.redactParams ?? false
			if (redactParams) {
				return dbRedactParams
			} else {
				return db
			}
		},
	}
}

// better-sqlite3 has a single connection and drizzle's transaction API over it is synchronous, so
// transactions with async callbacks are implemented with manual BEGIN/COMMIT. The lock serializes
// logical transactions so awaited work inside one can't interleave statements from another.
let txLock: Promise<void> = Promise.resolve()
async function acquireTxLock(): Promise<() => void> {
	let release!: () => void
	const prev = txLock
	txLock = new Promise((res) => (release = res))
	await prev
	return release
}

// Only queries may be awaited inside a transaction: the lock above is process-wide, so a callback that waits on
// anything else stalls every other write in the process for as long as it waits (and whatever it waited on is not
// rolled back with the transaction anyway). See docs/architecture.md.
//
// That property is detectable rather than merely conventional. better-sqlite3 is synchronous, so an awaited drizzle
// query settles on a microtask, and the microtask queue always drains before the loop reaches the check phase --
// a query-only callback therefore always beats a setImmediate scheduled alongside it. Anything that reaches the
// network, the disk or a timer has to yield first, and loses the race.
//
// exported for its test: the race is the whole mechanism, and it is not otherwise observable from outside.
export async function runDetectingYield<V>(run: () => Promise<V>): Promise<{ res: V; yielded: boolean }> {
	let yielded = false
	const immediate = setImmediate(() => {
		yielded = true
	})
	try {
		return { res: await run(), yielded }
	} finally {
		clearImmediate(immediate)
	}
}

// keyed on the tx handle, which a joined inner transaction shares with its outer one, so a violation is reported once
// at the innermost transaction that saw it -- the precise one -- rather than again at every transaction enclosing it.
const asyncTxReported = new WeakSet<object>()

async function runTxCallback<V>(txHandle: object, callback: () => Promise<V>): Promise<V> {
	// constructed eagerly because the offending call site is gone by the time the violation is detectable. V8 formats
	// .stack lazily, so this costs an allocation unless it's actually reported.
	const callSite = new Error()
	const { res, yielded } = await runDetectingYield(callback)
	// deliberately after the await rather than around it: a callback that threw is already loud, and throwing this on
	// top of it would bury the actual failure
	if (yielded && !asyncTxReported.has(txHandle)) {
		asyncTxReported.add(txHandle)
		reportAsyncTx(callSite)
	}
	return res
}

function reportAsyncTx(callSite: Error): void {
	const msg = 'transaction callback yielded to the event loop: only queries may be awaited inside runTransaction, '
		+ 'because the transaction lock is process-wide. Hoist the call above runTransaction if the write needs its '
		+ 'result, or defer it with ctx.tx.unlockTasks if it is a side effect of the write. See docs/architecture.md.'
	switch (ENV.NODE_ENV) {
		// a violation is a latency bug rather than a correctness one, and rolling a transaction back over it in prod
		// would turn slow writes into failed ones
		case 'production':
			log.warn({ err: callSite }, msg)
			return
		case 'development':
		case 'test':
			callSite.message = msg
			throw callSite
		default:
			assertNever(ENV.NODE_ENV)
	}
}

export async function runTransaction<T extends C.Db, V>(
	ctx: T & { tx?: { rollback: () => void } },
	opts: { redactParams?: boolean },
	callback: (ctx: T & C.Tx) => Promise<V>,
): Promise<V>
export async function runTransaction<T extends C.Db, V>(
	ctx: T & { tx?: { rollback: () => void } },
	callback: (ctx: T & C.Tx) => Promise<V>,
): Promise<V>
export async function runTransaction<T extends C.Db, V>(
	ctx: T & { tx?: { rollback: () => void } },
	secondArg: ((ctx: T & C.Tx) => Promise<V>) | { redactParams?: boolean },
	thirdArg?: (ctx: T & C.Tx) => Promise<V>,
): Promise<V> {
	const opts = typeof secondArg === 'object' ? secondArg : undefined
	const callback = (typeof secondArg === 'function' ? secondArg : thirdArg)!

	// already inside a transaction: join it. an inner rollback() rolls back the outer transaction
	if (ctx.tx) return await runTxCallback(ctx.tx, () => callback(ctx as T & C.Tx))

	let res!: Awaited<V>
	let shouldRollback = false
	const unlockTasks: C.Tx['tx']['unlockTasks'] = []
	const txHandle: C.Tx['tx'] = {
		rollback: () => {
			shouldRollback = true
		},
		unlockTasks,
	}
	const release = await acquireTxLock()
	try {
		driver.exec('BEGIN IMMEDIATE')
		try {
			res = await runTxCallback(txHandle, () =>
				callback({
					...ctx,
					tx: txHandle,
					db: () => ctx.db(opts),
				}))
			driver.exec(shouldRollback ? 'ROLLBACK' : 'COMMIT')
		} catch (err) {
			if (driver.inTransaction) driver.exec('ROLLBACK')
			throw err
		}
	} finally {
		release()
	}
	await Promise.all(unlockTasks.map(async (task) => task()))
	return res
}
