import type * as CS from '@/models/context-shared'
import { initModule } from '@/server/logger'
import DatabaseConstructor, { type Database } from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { highlight } from 'sql-highlight'

import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import type * as C from './context.ts'
import * as Env from './env.ts'

export type Db = BetterSQLite3Database<Record<string, never>>

const module = initModule('db')
let log!: CS.Logger

let driver!: Database

const envBuilder = Env.getEnvBuilder({ ...Env.groups.general, ...Env.groups.db })
let ENV!: ReturnType<typeof envBuilder>
let db: Db
let dbRedactParams: Db

export async function setup() {
	log = module.getLogger()
	ENV = envBuilder()

	fs.mkdirSync(path.dirname(ENV.DB_PATH), { recursive: true })
	driver = new DatabaseConstructor(ENV.DB_PATH)
	driver.pragma('journal_mode = WAL')
	driver.pragma('synchronous = NORMAL')
	// mysql enforced the schema's FK cascades; sqlite only does so with this pragma (per-connection)
	driver.pragma('foreign_keys = ON')
	driver.pragma('busy_timeout = 5000')

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
	if (ctx.tx) return callback(ctx as T & C.Tx)

	let res!: Awaited<V>
	let shouldRollback = false
	const unlockTasks: C.Tx['tx']['unlockTasks'] = []
	const release = await acquireTxLock()
	try {
		driver.exec('BEGIN IMMEDIATE')
		try {
			res = await callback({
				...ctx,
				tx: {
					rollback: () => {
						shouldRollback = true
					},
					unlockTasks,
				},
				db: () => ctx.db(opts),
			})
			driver.exec(shouldRollback ? 'ROLLBACK' : 'COMMIT')
		} catch (err) {
			if (driver.inTransaction) driver.exec('ROLLBACK')
			throw err
		}
	} finally {
		release()
	}
	await Promise.all(unlockTasks.map((task) => task()))
	return res
}
