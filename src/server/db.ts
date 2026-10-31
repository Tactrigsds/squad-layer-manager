import * as Otel from '@opentelemetry/api'
import DatabaseConstructor, { type Database, type Statement } from 'better-sqlite3'
import { is } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { SQLiteInsertBase } from 'drizzle-orm/sqlite-core'
import fs from 'node:fs'
import path from 'node:path'
import { Worker } from 'node:worker_threads'
import { highlight } from 'sql-highlight'

import { tsMigrations } from '@/migrations/registry'
import type * as CS from '@/models/context-shared.models'
import * as ATTRS from '@/models/otel-attrs.models'
import * as Instr from '@/server/instrumentation'
import { initModule } from '@/server/logger'
import * as Sql from '@/server/sql'
import * as CleanupSys from '@/systems/cleanup.server'

import type * as C from './context.ts'
import type * as MaintenanceWorker from './db-maintenance.worker.ts'
import * as DbMeta from './db-meta.ts'
import * as Env from './env.ts'
import * as Migrate from './migrate.ts'

const module = initModule('db')
// a stand-in until setup(), for connections a test opens itself
let log: CS.Logger = console as unknown as CS.Logger

let driver!: Database

// backups: boot takes a pre-migration snapshot, which is named after DB_PATH and retained in BACKUPS_DIR
const envBuilder = Env.getEnvBuilder({ ...Env.groups.general, ...Env.groups.db, ...Env.groups.backups })
let ENV!: ReturnType<typeof envBuilder>
let main!: Conn
// development and test, at debug level: each statement's values go to its module's logger
let logValues = false

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
// schema it doesn't know.
function assertNotNewerThanBuild(driver: Database, migrateOpts: { sqlDir: string; tsMigrations: Migrate.TsMigration[] }) {
	const unknown = Migrate.getUnknownAppliedMigrations(driver, migrateOpts)
	if (unknown.length === 0) return
	const stamp = DbMeta.readBuildStamp(driver)
	const tag = stamp && DbMeta.imageTagFor(stamp.gitSha)
	const remedy =
		ENV.NODE_ENV !== 'production'
			? 'In a dev workspace, `pnpm dev --reset-data` replaces it with a fresh one.'
			: (tag ? `Set SLM_IMAGE_TAG=${tag}, the build that last ran against it, ` : 'Run the build that last ran against it, ') +
				'or restore a backup taken before the upgrade (see docs/guide/operations/backups.md).'
	throw new Error(
		`Refusing to start: the database was migrated by a newer build of SLM than this one (${ENV.PUBLIC_GIT_SHA}), and records ` +
			`${unknown.length} migration(s) this build does not have: ${unknown.join(', ')}. SLM cannot be downgraded. ${remedy}`,
	)
}

export async function setup(opts?: { skipMigrationCheck?: boolean }) {
	log = module.getLogger()
	ENV = envBuilder()
	assertNotLegacyDbPath()

	fs.mkdirSync(path.dirname(ENV.DB_PATH), { recursive: true })
	driver = new DatabaseConstructor(ENV.DB_PATH)
	// only takes on a file with no pages yet, which is a fresh install; an existing database is switched by migrate.ts.
	// Before WAL, which writes the first page.
	driver.pragma('auto_vacuum = INCREMENTAL')
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

	main = connect(driver)
	logValues = ENV.NODE_ENV !== 'production' && log.isLevelEnabled('debug')
	Sql.observeStats()
}

export function mainConn(): Conn {
	return main
}

// -------- the maintenance worker (see db-maintenance.worker.ts) --------

// The main connection checkpoints for itself only once the WAL reaches this many pages, as a backstop for a
// maintenance worker that has fallen behind. While no worker is running it checkpoints at sqlite's default instead.
const BACKSTOP_AUTOCHECKPOINT_PAGES = 10_000
const DEFAULT_AUTOCHECKPOINT_PAGES = 1000
const CHECKPOINT_INTERVAL_MS = 250
// 10MB of 4KB pages: below this, free pages wait to be reused by the next writes rather than handed back
const VACUUM_START_PAGES = 2_560
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
			workerData: {
				dbPath: ENV.DB_PATH,
				checkpointIntervalMs: CHECKPOINT_INTERVAL_MS,
				vacuumStartPages: VACUUM_START_PAGES,
			} satisfies MaintenanceWorker.WorkerData,
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
// DDL and data reshaping outside drizzle). Everything else goes through the executors below.
export function rawDriver(): Database {
	return driver
}

// -------- connections --------

// A connection as a ctx carries it (`ctx.db`). `session` prepares through the text cache, for statements built per
// call; `direct` prepares outside it, for definitions, which hold their statement for the life of the connection.
export type Conn = {
	readonly driver: Database
	readonly session: unknown
	readonly direct: unknown
}

const TEXT_CACHE_SIZE = 500

// Drizzle calls only `prepare` on its client (and `transaction`, which is never used), so it gets one of its own that
// keeps a sqlite statement per SQL text. Drizzle binds literals as parameters, so a statement built per call renders
// the same text every time and reuses one sqlite statement.
function textCache(d: Database, max: number) {
	const cache = new Map<string, Statement>()
	return {
		prepare(text: string) {
			let stmt = cache.get(text)
			if (stmt) {
				// most recently used goes last
				cache.delete(text)
				cache.set(text, stmt)
				// drizzle sets raw() before every run that wants array rows, and expects object rows straight after
				// prepare, so a reader goes back out in object mode. raw() throws on statements that return no rows.
				return stmt.reader ? stmt.raw(false) : stmt
			}
			stmt = d.prepare(text)
			cache.set(text, stmt)
			if (cache.size > max) cache.delete(cache.keys().next().value!)
			return stmt
		},
		transaction(): never {
			throw new Error('use DB.transaction(ctx, opts, cb)')
		},
	}
}

function sessionOf(db: object): unknown {
	return (db as { session: unknown }).session
}

export function connect(d: Database): Conn {
	return {
		driver: d,
		session: sessionOf(drizzle({ client: textCache(d, TEXT_CACHE_SIZE) as unknown as Database })),
		direct: sessionOf(drizzle({ client: d })),
	}
}

export function withDb<T extends CS.Ctx>(ctx: T): T & C.Db {
	if ('db' in ctx) return ctx as T & C.Db
	return { ...ctx, db: main }
}

// -------- transactions --------

// what a transaction callback returns: `ok` commits, `err:` rolls back, and `commitDespiteError` commits an error
export type TxResult = { code: 'ok'; commitDespiteError?: never } | { code: `err:${string}`; commitDespiteError?: true }
// what the caller gets back: the instruction is spent by the scope that ran it
export type Spent<R> = R extends { commitDespiteError: true } ? Omit<R, 'commitDespiteError'> : R
// the ctx a transactional op is called with: the callback's, outside a transaction or inside one
export type Outer<P> = Omit<P, 'tx'> & { tx?: TxHandle }

export class TxHandle {
	open = true
	readonly tasks: (() => void)[] = []
	constructor(
		readonly conn: Conn,
		// shared by every scope of one transaction: set once sqlite has ended the transaction on its own
		readonly root: { aborted: boolean },
		readonly depth: number,
	) {}
	// Runs `task` synchronously after the outermost COMMIT, once the transaction has ended, so a task may open a
	// transaction of its own. A rolled-back scope drops its tasks. Cache changes, in-memory mirrors, socket closes and
	// every emission go through here.
	afterCommit(task: () => void) {
		if (!this.open) throw new Error('afterCommit on a transaction that has ended: its task would never run')
		this.tasks.push(task)
	}
}

// Runs `task` once the ctx's transaction commits, or now when the ctx is in none. For in-memory state that mirrors a
// write, which a rollback would otherwise leave changed.
export function afterCommit(ctx: object, task: () => void) {
	const tx = (ctx as { tx?: TxHandle }).tx
	if (tx) tx.afterCommit(task)
	else task()
}

// The ctx against its connection, in both directions. Types cannot prove a property absent, so a ctx captured outside
// a transaction can reach into one, and a ctx whose transaction has ended would otherwise run in autocommit.
function checkConn(ctx: object, conn: Conn) {
	const tx = (ctx as { tx?: TxHandle }).tx
	if (tx) {
		if (!tx.open)
			throw new Error('a statement ran with a ctx whose transaction has ended: a ctx captured by a callback, timer or afterCommit task')
		if (tx.conn !== conn) throw new Error('a statement ran on one connection with a transaction open on another')
		if (tx.root.aborted || !conn.driver.inTransaction)
			throw new Error('sqlite ended this transaction after an earlier error, so its writes are gone and nothing more may run in it')
	} else if (conn.driver.inTransaction) {
		throw new Error('a statement ran outside the transaction that is open: a ctx captured from outside its transaction() callback')
	}
}

function isThenable(v: unknown): v is PromiseLike<unknown> {
	return v !== null && (typeof v === 'object' || typeof v === 'function') && typeof (v as { then?: unknown }).then === 'function'
}

function spend<R>(res: R): Spent<R> {
	if (res && typeof res === 'object' && 'commitDespiteError' in res) {
		const { commitDespiteError: _, ...rest } = res as R & { commitDespiteError?: true }
		return rest as Spent<R>
	}
	return res as Spent<R>
}

// Ends a scope without its writes. Rethrows nothing: the caller rethrows the error that ended the scope.
function rollbackScope(conn: Conn, handle: TxHandle) {
	const d = conn.driver
	// sqlite has already rolled the whole transaction back (SQLITE_FULL, INSERT OR ROLLBACK)
	if (!d.inTransaction) {
		handle.root.aborted = true
		return
	}
	try {
		if (handle.depth === 0) d.exec('ROLLBACK')
		else d.exec(`ROLLBACK TO tx_${handle.depth}; RELEASE tx_${handle.depth}`)
	} catch (err) {
		log.error(err, 'could not roll back a transaction scope')
		if (!d.inTransaction) handle.root.aborted = true
	}
}

function setOutcome(outcome: ATTRS.Db.TxOutcome) {
	Otel.trace.getActiveSpan()?.setAttribute(ATTRS.Db.TX_OUTCOME, outcome)
}

/**
 * Runs `cb` in a transaction, synchronously, and commits or rolls back by what it returns:
 *
 * | the callback | the scope |
 * | --- | --- |
 * | returns `{ code: 'ok', ... }` or nothing | commits |
 * | returns `{ code: 'err:...' }` | rolls back |
 * | returns `{ code: 'err:...', commitDespiteError: true }` | commits, and the caller gets the result without the flag |
 * | throws | rolls back |
 *
 * Inside a transaction it opens a savepoint, so a nested scope's error undoes only that scope's writes. `dryRun` rolls
 * back whatever the callback returns.
 */
export function transaction<Ctx extends C.Db, R extends TxResult | void>(
	ctx: Ctx,
	opts: { dryRun?: boolean },
	cb: (ctx: Ctx & C.Tx) => R,
): Spent<R> {
	const conn = ctx.db
	const parent = (ctx as Partial<C.Tx>).tx
	checkConn(ctx, conn)
	const handle = new TxHandle(conn, parent ? parent.root : { aborted: false }, parent ? parent.depth + 1 : 0)
	conn.driver.exec(parent ? `SAVEPOINT tx_${handle.depth}` : 'BEGIN IMMEDIATE')
	let res: R
	try {
		res = cb({ ...ctx, tx: handle })
		if (isThenable(res)) {
			// the statements after its first await fail the ctx check on their own
			Promise.resolve(res).catch(() => {})
			throw new Error('a transaction callback returned a promise: transactions are synchronous, so it may not await')
		}
	} catch (err) {
		handle.open = false
		rollbackScope(conn, handle)
		setOutcome('rolled-back')
		throw err
	}
	handle.open = false
	if (handle.root.aborted) {
		rollbackScope(conn, handle)
		setOutcome('rolled-back')
		throw new Error('sqlite ended this transaction after an error its callback caught, so its writes are gone')
	}
	const r = res as { code?: string; commitDespiteError?: true } | undefined
	const commit = !opts.dryRun && (r === undefined || r.code === 'ok' || r.commitDespiteError === true)
	if (!commit) {
		rollbackScope(conn, handle)
		setOutcome('rolled-back')
		return spend(res)
	}
	if (parent) {
		conn.driver.exec(`RELEASE tx_${handle.depth}`)
		parent.tasks.push(...handle.tasks)
		setOutcome('released')
		return spend(res)
	}
	try {
		conn.driver.exec('COMMIT')
	} catch (err) {
		// a deferred foreign-key violation fails COMMIT and leaves the transaction open
		if (conn.driver.inTransaction) conn.driver.exec('ROLLBACK')
		setOutcome('rolled-back')
		throw err
	}
	setOutcome('committed')
	for (const task of handle.tasks) {
		try {
			task()
		} catch (err) {
			// the write has committed, so the task's failure is not the caller's
			log.error(err, 'an afterCommit task failed')
		}
	}
	return spend(res)
}

/**
 * A transactional server function: `spanOpSync` plus `transaction()`. The callback declares the ctx it needs, and the
 * op is callable with that ctx outside a transaction or inside one, where it runs in a savepoint.
 */
export function txOp<P extends C.Db & C.Tx, A extends unknown[], R extends TxResult | void>(
	name: string,
	opts: Instr.SpanOpSyncOpts<(ctx: Outer<P>, ...args: A) => Spent<R>> & { dryRun?: boolean },
	cb: (ctx: P, ...args: A) => R,
): (ctx: Outer<P>, ...args: A) => Spent<R> {
	const txOpts = { dryRun: opts.dryRun }
	return Instr.spanOpSync(name, opts, (ctx: Outer<P>, ...args: A) =>
		transaction(ctx as unknown as P, txOpts, (tx) => cb(tx as P, ...args)),
	) as (ctx: Outer<P>, ...args: A) => Spent<R>
}

// -------- executors --------

// A statement an executor runs: a builder from SQL.select/insert/update/delete, or a definition called with its values.
type Runnable<M extends string> = { [K in M]: (...args: any[]) => unknown }
type Stmt<M extends string> = Runnable<M> | Sql.Called<Runnable<M>>
type Result<S, M extends string> =
	S extends Sql.Called<infer T> ? (T extends Runnable<M> ? ReturnType<T[M]> : never) : S extends Runnable<M> ? ReturnType<S[M]> : never

type Ran = Sql.Preparable & { session: Sql.Unbound }

const SLOW_MS = 100

type ExecCtx = C.Db & { tx?: TxHandle; sqlStats?: Instr.SqlStats }

function prepare(conn: Conn, stmt: Ran | Sql.Called<unknown>): { prepared: Sql.PreparedQuery; entry?: Sql.Entry; stats: Sql.Stats } {
	if (Sql.CALLED in stmt) {
		const entry = stmt[Sql.CALLED]
		let prepared = entry.prepared.get(conn)
		if (!prepared) {
			// a view whose session is the connection's own: the definition's builder is frozen
			prepared = entry.stmt._prepare.call(Object.create(entry.stmt, { session: { value: conn.direct } }), false)
			entry.prepared.set(conn, prepared)
		}
		return { prepared, entry, stats: entry.stats }
	}
	const unbound = stmt.session
	if (!(unbound instanceof Sql.Unbound)) {
		if (typeof stmt === 'function') throw new TypeError('a definition must be called with its values before it runs')
		throw new TypeError('build a statement with SQL.select/insert/update/delete from Sql.forModule')
	}
	stmt.session = conn.session as Sql.Unbound
	try {
		return { prepared: stmt._prepare(true), stats: unbound.stats }
	} finally {
		stmt.session = unbound
	}
}

function exec(ctx: ExecCtx, stmt: unknown, method: 'all' | 'get' | 'run', checked: boolean): unknown {
	const conn = ctx.db
	if (!checked) checkConn(ctx, conn)
	const t0 = performance.now()
	const { prepared, entry, stats } = prepare(conn, stmt as Ran)
	const values = entry ? (stmt as Sql.Called<unknown>).values : undefined
	try {
		return prepared[method](values)
	} catch (err) {
		stats.errors++
		// sqlite rolls back the whole transaction on some errors (SQLITE_FULL), not only the statement
		if (ctx.tx && !conn.driver.inTransaction) ctx.tx.root.aborted = true
		throw err
	} finally {
		const ms = performance.now() - t0
		stats.record(ms)
		const st = ctx.sqlStats
		if (st) {
			st.count++
			st.ms += ms
		}
		if (ms > SLOW_MS || logValues) {
			const l = (entry?.module ?? (stmt as Ran).session.module).getLogger()
			const statement = entry?.name ?? stats.name
			if (ms > SLOW_MS) l.warn({ statement, ms: Math.round(ms) }, 'slow statement: %s', prepared.query.sql)
			// never in production; Secrets are masked by the logger
			if (logValues) {
				const logged =
					entry && values ? loggedValues(values, entry.unlogged) : (prepared.query.params as unknown[]).map((v) => loggedValue(v, 0))
				l.debug({ statement, values: logged }, '%s', highlight(prepared.query.sql))
			}
		}
	}
}

const LOGGED_CHARS = 200
const LOGGED_ITEMS = 20
const LOGGED_DEPTH = 3

function loggedValues(values: Record<string, unknown>, unlogged: ReadonlySet<string>) {
	const out: Record<string, unknown> = {}
	for (const k in values) out[k] = unlogged.has(k) ? '[redacted]' : loggedValue(values[k], 0)
	return out
}

// a value as the debug log shows it, cut short where it is long or deep
function loggedValue(v: unknown, depth: number): unknown {
	if (typeof v === 'string') return v.length > LOGGED_CHARS ? `${v.slice(0, LOGGED_CHARS)}… (${v.length} chars)` : v
	if (v instanceof Uint8Array) return `[${v.byteLength} bytes]`
	if (v === null || typeof v !== 'object') return v
	const isArray = Array.isArray(v)
	if (!isArray && Object.getPrototypeOf(v) !== Object.prototype) return v
	if (depth >= LOGGED_DEPTH) return isArray ? `[${v.length} items]` : '[object]'
	if (isArray) {
		const head = v.slice(0, LOGGED_ITEMS).map((x) => loggedValue(x, depth + 1))
		return v.length > LOGGED_ITEMS ? [...head, `… (${v.length} items)`] : head
	}
	const out: Record<string, unknown> = {}
	for (const k in v) out[k] = loggedValue((v as Record<string, unknown>)[k], depth + 1)
	return out
}

export function all<S extends Stmt<'all'>>(ctx: C.Db, stmt: S): Result<S, 'all'> {
	return exec(ctx, stmt, 'all', false) as Result<S, 'all'>
}

export function get<S extends Stmt<'get'>>(ctx: C.Db, stmt: S): Result<S, 'get'> {
	return exec(ctx, stmt, 'get', false) as Result<S, 'get'>
}

export type RunResult = { changes: number; lastInsertRowid: number | bigint }
export type Changes = number | { atLeast?: number; atMost?: number }
export type Checked<O extends string> = { code: 'ok'; changes: number; lastInsertRowid?: number | bigint } | { code: O; changes: number }

/**
 * Runs a write. With `changes`, compares sqlite's count of rows the statement wrote (`sqlite3_changes`: not rows
 * written by triggers, cascades or REPLACE) and returns `otherwise` when it does not match. A write that fails a check
 * with an upper bound is undone, in a transaction of its own or a savepoint, so when the executor returns either the
 * statement's effect is in the current scope and the result is `ok`, or the effect is absent.
 */
export function run(ctx: C.Db, stmt: Stmt<'run'>): RunResult
export function run<O extends `err:${string}`>(ctx: C.Db, stmt: Stmt<'run'>, opts: { changes: Changes; otherwise: O }): Checked<O>
export function run(ctx: C.Db, stmt: Stmt<'run'>, opts?: { changes: Changes; otherwise: string }): RunResult | Checked<string> {
	if (!opts) return exec(ctx, stmt, 'run', false) as RunResult
	const c = opts.changes
	const min = typeof c === 'number' ? c : (c.atLeast ?? 0)
	const max = typeof c === 'number' ? c : (c.atMost ?? Infinity)
	const built = Sql.CALLED in (stmt as object) ? (stmt as Sql.Called<unknown>)[Sql.CALLED].stmt : stmt
	const isInsert = is(built, SQLiteInsertBase)
	const result = (r: RunResult): Checked<string> =>
		r.changes >= min && r.changes <= max
			? isInsert && r.changes > 0
				? { code: 'ok', changes: r.changes, lastInsertRowid: r.lastInsertRowid }
				: { code: 'ok', changes: r.changes }
			: { code: opts.otherwise, changes: r.changes }
	// a write that falls short of a lower bound changed nothing beyond what it reports, so it runs bare
	if (max === Infinity) return result(exec(ctx, stmt, 'run', false) as RunResult)
	const conn = ctx.db
	checkConn(ctx, conn)
	const inTx = Boolean((ctx as Partial<C.Tx>).tx)
	conn.driver.exec(inTx ? 'SAVEPOINT stmt_check' : 'BEGIN IMMEDIATE')
	let r: RunResult
	try {
		r = exec(ctx, stmt, 'run', true) as RunResult
	} catch (err) {
		if (conn.driver.inTransaction) conn.driver.exec(inTx ? 'ROLLBACK TO stmt_check; RELEASE stmt_check' : 'ROLLBACK')
		throw err
	}
	const out = result(r)
	if (out.code === 'ok') conn.driver.exec(inTx ? 'RELEASE stmt_check' : 'COMMIT')
	else conn.driver.exec(inTx ? 'ROLLBACK TO stmt_check; RELEASE stmt_check' : 'ROLLBACK')
	return out
}

const totalChangesStmts = new WeakMap<Conn, Statement>()

// sqlite's count of rows written on the ctx's connection since it opened (`sqlite3_total_changes`), which, unlike a
// statement's own count, includes the rows foreign-key actions deleted or updated
export function totalChanges(ctx: C.Db): number {
	let stmt = totalChangesStmts.get(ctx.db)
	if (!stmt) {
		stmt = ctx.db.driver.prepare('SELECT total_changes() AS n').pluck()
		totalChangesStmts.set(ctx.db, stmt)
	}
	return stmt.get() as number
}

// -------- the boot check --------

// Development and test: prepares every defined statement, and fails on a table scan the definition did not declare.
// Runs once every system is set up, so every module has defined its statements.
export function checkStatements(conn: Conn) {
	const problems: string[] = []
	for (const r of Sql.registry.values()) {
		r.enumerate?.()
		for (const entry of r.entries()) {
			try {
				conn.driver.prepare(entry.text)
				const plan = conn.driver.prepare(`EXPLAIN QUERY PLAN ${entry.text}`).all(
					...entry.text
						.split('?')
						.slice(1)
						.map(() => null),
				) as {
					detail: string
				}[]
				for (const { detail } of plan) {
					// a scan through an index still reads the whole index; json_each's virtual table reads only its argument
					const m = /^SCAN (\S+)/.exec(detail)
					if (m && !/VIRTUAL TABLE/.test(detail) && !entry.scans.includes(m[1])) problems.push(`${entry.name}: ${detail}`)
				}
			} catch (err) {
				problems.push(`${entry.name}: ${(err as Error).message}`)
			}
		}
	}
	return problems
}
