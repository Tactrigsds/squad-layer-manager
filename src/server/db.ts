import DatabaseConstructor, { type Database } from 'better-sqlite3'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { Worker } from 'node:worker_threads'
import { highlight } from 'sql-highlight'

import { assertNever } from '@/lib/type-guards'
import { tsMigrations } from '@/migrations/registry'
import type * as CS from '@/models/context-shared'
import { initModule } from '@/server/logger'
import * as CleanupSys from '@/systems/cleanup.server'

import type * as C from './context.ts'
import type * as MaintenanceWorker from './db-maintenance.worker.ts'
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
		`Refusing to start: found a database at the old default path ${LEGACY_DB_PATH}, but the default is now ${ENV.DB_PATH}. ` +
			`Rename it (along with any -wal/-shm files) to ${ENV.DB_PATH}, or set DB_PATH=${LEGACY_DB_PATH} to keep using it.`,
	)
}

// Migrations only go forward, so a build older than the one that last migrated the database would run against a
// schema it doesn't know. Only a warning outside production: a development database is cloned from the main checkout,
// which is routinely ahead of an older worktree's branch.
function assertNotNewerThanBuild(driver: Database, migrateOpts: { sqlDir: string; tsMigrations: Migrate.TsMigration[] }) {
	const unknown = Migrate.getUnknownAppliedMigrations(driver, migrateOpts)
	if (unknown.length === 0) return
	const stamp = DbMeta.readBuildStamp(driver)
	const tag = stamp && DbMeta.imageTagFor(stamp.gitSha)
	const msg =
		`the database was migrated by a newer build of SLM than this one (${ENV.PUBLIC_GIT_SHA}), and records ${unknown.length} ` +
		`migration(s) this build does not have: ${unknown.join(', ')}. SLM cannot be downgraded. ` +
		(tag ? `Set SLM_IMAGE_TAG=${tag}, the build that last ran against it, ` : 'Run the build that last ran against it, ') +
		'or restore a backup taken before the upgrade (see docs/guide/operations/backups.md).'
	if (ENV.NODE_ENV === 'production') throw new Error(`Refusing to start: ${msg}`)
	log.warn(msg)
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
	// a checkpoint resets the wal but leaves the file at its high-water mark, so one long burst of writes
	// (a compaction pass, a migration) would otherwise hold that much disk for the life of the process
	driver.pragma(`journal_size_limit = ${64 * 1024 * 1024}`)
	// No ANALYZE or `PRAGMA optimize`. With sqlite_stat1 the planner walks serverEventIndex's time index for a rare
	// type filter, which took one history page from 0.1ms to 44ms on a production copy.

	// Schema-vs-code guard, run while foreign_keys is still at its default (OFF) — same as the
	// standalone `pnpm db:migrate`, since drizzle-kit's table-rebuild migrations require FK
	// enforcement off. Boot applies pending migrations itself by default, backing the DB up first and
	// refusing to touch a DB another process has open; with DB_AUTOMIGRATE off it merely refuses to run
	// against a DB that's behind, never taking a write lock or mutating the DB here. Scripts that
	// intentionally run pre-migration pass skipMigrationCheck.
	if (!opts?.skipMigrationCheck) {
		const migrateOpts = { sqlDir: path.resolve(process.cwd(), 'drizzle-sqlite'), tsMigrations }
		assertNotNewerThanBuild(driver, migrateOpts)
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
					`Refusing to start: ${pending.length} pending database migration(s): ${pending.join(', ')}. ` +
						`Run \`pnpm db:migrate\` (prod: \`pnpm db:migrate:prod\`) before starting, or set DB_AUTOMIGRATE=true.`,
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

	// after migrations, which hold the database exclusively and so would lock the worker's connection out
	bootMaintenanceWorker()
	CleanupSys.register(async () => {
		maintenance.shuttingDown = true
		if (maintenance.rebootTimer) clearTimeout(maintenance.rebootTimer)
		await maintenance.worker?.terminate()
	})

	db = drizzle(driver, {
		logger: {
			logQuery: (query: string, params: unknown[]) => {
				if (log.isLevelEnabled('debug')) log.debug('%s %o', highlight(query), params)
			},
		},
	})

	dbRedactParams = drizzle(driver, {
		logger: {
			logQuery: (query: string, params: unknown[]) => {
				if (log.isLevelEnabled('debug')) log.debug('%s', highlight(query))
			},
		},
	})
}

// -------- the maintenance worker (see db-maintenance.worker.ts) --------

// The main connection checkpoints for itself only once the WAL reaches this many pages, as a backstop for a
// maintenance worker that has fallen behind. While no worker is running it checkpoints at sqlite's default instead.
const BACKSTOP_AUTOCHECKPOINT_PAGES = 10_000
const DEFAULT_AUTOCHECKPOINT_PAGES = 1000
const CHECKPOINT_INTERVAL_MS = 250
const MAINTENANCE_REBOOT_DELAYS = [1_000, 5_000, 30_000]

const maintenance = {
	worker: undefined as Worker | undefined,
	nextSeq: 1,
	pending: new Map<number, { resolve: () => void; reject: (err: unknown) => void }>(),
	rebootAttempts: 0,
	rebootTimer: undefined as ReturnType<typeof setTimeout> | undefined,
	shuttingDown: false,
}

function bootMaintenanceWorker() {
	// under tsx this module's url is the .ts source and the worker needs the loader passed along; from the prod bundle
	// both are built .js chunks side by side in dist-server/
	const isTs = import.meta.url.endsWith('.ts')
	const url = new URL(isTs ? './db-maintenance.worker.ts' : './db-maintenance.worker.js', import.meta.url)
	let w: Worker
	try {
		w = new Worker(url, {
			workerData: { dbPath: ENV.DB_PATH, checkpointIntervalMs: CHECKPOINT_INTERVAL_MS } satisfies MaintenanceWorker.WorkerData,
			execArgv: isTs ? ['--import', 'tsx'] : undefined,
		})
	} catch (err) {
		log.error(err, 'db maintenance worker failed to boot; checkpoints run on the main connection until it does')
		scheduleMaintenanceReboot()
		return
	}
	const onDown = (err: unknown) => {
		if (maintenance.worker !== w) return
		maintenance.worker = undefined
		driver.pragma(`wal_autocheckpoint = ${DEFAULT_AUTOCHECKPOINT_PAGES}`)
		for (const p of maintenance.pending.values()) p.reject(err)
		maintenance.pending.clear()
		scheduleMaintenanceReboot()
	}
	w.on('message', (msg: MaintenanceWorker.Response) => {
		if ('ready' in msg) {
			maintenance.rebootAttempts = 0
			driver.pragma(`wal_autocheckpoint = ${BACKSTOP_AUTOCHECKPOINT_PAGES}`)
			return
		}
		const p = maintenance.pending.get(msg.seq)
		if (!p) return
		maintenance.pending.delete(msg.seq)
		if (msg.err) p.reject(Object.assign(new Error(msg.err.message), { stack: msg.err.stack }))
		else p.resolve()
	})
	w.on('error', (err) => {
		if (!maintenance.shuttingDown)
			log.error(err, 'db maintenance worker failed; checkpoints run on the main connection until it restarts')
		onDown(err)
	})
	w.on('exit', () => onDown(new Error('db maintenance worker exited')))
	// the worker must never hold the process open
	w.unref()
	maintenance.worker = w
}

function scheduleMaintenanceReboot() {
	if (maintenance.shuttingDown || maintenance.worker || maintenance.rebootTimer) return
	const delay = MAINTENANCE_REBOOT_DELAYS[Math.min(maintenance.rebootAttempts, MAINTENANCE_REBOOT_DELAYS.length - 1)]
	maintenance.rebootAttempts++
	maintenance.rebootTimer = setTimeout(() => {
		maintenance.rebootTimer = undefined
		bootMaintenanceWorker()
	}, delay)
	maintenance.rebootTimer.unref()
}

// Writes a consistent, compacted copy of the database to destPath with VACUUM INTO, on the maintenance worker's
// connection. Writes on the main connection carry on while it runs and are not in the copy. The destination must not
// exist, and is written by sqlite itself, so callers should hand it a temp path and rename into place: a crash
// mid-snapshot otherwise leaves a truncated file that looks whole.
export async function backupTo(destPath: string) {
	const w = maintenance.worker
	// while the worker is down, sqlite's online backup on the main connection, which copies 100 pages per turn of the
	// event loop and carries the free pages along
	if (!w) return void (await driver.backup(destPath))
	const seq = maintenance.nextSeq++
	// held open while a snapshot is owed, which the unref'd worker would not otherwise do
	w.ref()
	try {
		await new Promise<void>((resolve, reject) => {
			maintenance.pending.set(seq, { resolve, reject })
			w.postMessage({ seq, snapshotTo: destPath } satisfies MaintenanceWorker.Request)
		})
	} finally {
		if (maintenance.pending.size === 0) w.unref()
	}
}

// the build that owns this database, stamped on boot (see db-meta.ts). null only if setup() hasn't run or the db
// predates stamping. Used to name a periodic backup after the version it belongs to.
export function readBuildStamp() {
	return DbMeta.readBuildStamp(driver)
}

// the raw better-sqlite3 connection, for the plugin migration runner (same contract as core migrations:
// DDL and data reshaping outside drizzle). Everything else goes through ctx.db().
export function rawDriver(): Database {
	return driver
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
// rolled back with the transaction anyway). See docs/developers/architecture.md.
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
	const msg =
		'transaction callback yielded to the event loop: only queries may be awaited inside runTransaction, ' +
		'because the transaction lock is process-wide. Hoist the call above runTransaction if the write needs its ' +
		'result, or defer it with ctx.tx.unlockTasks if it is a side effect of the write. See docs/developers/architecture.md.'
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

// A transaction held open across many small synchronous writes, so a burst of them shares one COMMIT. Each write
// runs in its own savepoint, so one that throws rolls back alone. It holds the process-wide lock from open to
// commit, so the code between the two must await nothing but other writes to it, the same rule runTransaction
// enforces. Committing on a later turn of the event loop is reported the same way.
export type WriteBatch = {
	write<V>(cb: () => V): V
	commit(): void
}

export async function openWriteBatch(): Promise<WriteBatch> {
	const callSite = new Error()
	const release = await acquireTxLock()
	try {
		driver.exec('BEGIN IMMEDIATE')
	} catch (err) {
		release()
		throw err
	}
	let yielded = false
	const immediate = setImmediate(() => {
		yielded = true
	})
	let open = true
	return {
		write(cb) {
			if (!open) throw new Error('write to a committed batch')
			driver.exec('SAVEPOINT batch_write')
			try {
				const res = cb()
				driver.exec('RELEASE batch_write')
				return res
			} catch (err) {
				driver.exec('ROLLBACK TO batch_write')
				driver.exec('RELEASE batch_write')
				throw err
			}
		},
		commit() {
			if (!open) return
			open = false
			clearImmediate(immediate)
			try {
				driver.exec('COMMIT')
			} catch (err) {
				if (driver.inTransaction) driver.exec('ROLLBACK')
				throw err
			} finally {
				release()
			}
			if (yielded) {
				callSite.message = 'write batch was held open across a turn of the event loop. See openWriteBatch.'
				log.error({ err: callSite }, callSite.message)
			}
		},
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
				}),
			)
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
