import DatabaseConstructor, { type Database } from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Worker } from 'node:worker_threads'
import { afterEach, beforeEach, expect, test } from 'vitest'

import type * as MaintenanceWorker from './db-maintenance.worker.ts'

// The worker runs beside a connection that keeps writing. A snapshot must complete while that connection holds a write
// transaction open, and hold only what was committed. A checkpoint must move that connection's writes into the file.
// Free pages past the threshold must be handed back until none are left.

let dir: string
let dbPath: string
let driver: Database
let worker: Worker

beforeEach(async () => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slm-db-maintenance-test-'))
	dbPath = path.join(dir, 'db.sqlite3')
	driver = new DatabaseConstructor(dbPath)
	// set before the first table, so it takes effect without a VACUUM
	driver.pragma('auto_vacuum = INCREMENTAL')
	driver.pragma('journal_mode = WAL')
	driver.pragma('wal_autocheckpoint = 0')
	driver.exec('CREATE TABLE t (x INTEGER)')
	worker = new Worker(new URL('./db-maintenance.worker.ts', import.meta.url), {
		workerData: { dbPath, checkpointIntervalMs: 20, vacuumStartPages: 100 } satisfies MaintenanceWorker.WorkerData,
		execArgv: ['--import', 'tsx'],
	})
	await new Promise((resolve) => worker.once('message', resolve))
})

afterEach(async () => {
	await worker.terminate()
	driver.close()
	fs.rmSync(dir, { recursive: true, force: true })
})

function snapshot(seq: number, snapshotTo: string) {
	return new Promise<MaintenanceWorker.Response>((resolve) => {
		worker.once('message', resolve)
		worker.postMessage({ seq, snapshotTo } satisfies MaintenanceWorker.Request)
	})
}

test('a snapshot runs during an open write transaction and holds only committed rows', async () => {
	driver.prepare('INSERT INTO t VALUES (1)').run()
	driver.exec('BEGIN IMMEDIATE')
	driver.prepare('INSERT INTO t VALUES (2)').run()

	const dest = path.join(dir, 'snapshot.sqlite3')
	expect(await snapshot(1, dest)).toEqual({ seq: 1 })
	driver.exec('COMMIT')

	const copy = new DatabaseConstructor(dest, { readonly: true })
	expect(copy.prepare('SELECT x FROM t').pluck().all()).toEqual([1])
	copy.close()
})

test('a snapshot onto an existing file is reported, not thrown', async () => {
	const dest = path.join(dir, 'taken.sqlite3')
	fs.writeFileSync(dest, 'not empty')
	expect(await snapshot(2, dest)).toMatchObject({ seq: 2, err: { message: expect.any(String) } })
})

test('checkpoints the writes of another connection', async () => {
	// with autocheckpoint off on the writer, only a checkpoint moves pages from the WAL into the database file
	const before = fs.statSync(dbPath).size
	driver
		.prepare(
			'WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1000) INSERT INTO t SELECT randomblob(1000) FROM n',
		)
		.run()
	await expect.poll(() => fs.statSync(dbPath).size - before, { timeout: 2000 }).toBeGreaterThan(1_000_000)
})

test('hands free pages back once more than the threshold are free, until none are', async () => {
	const fill = driver.prepare(
		'WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 2000) INSERT INTO t SELECT randomblob(1000) FROM n',
	)
	fill.run()
	const pages = () => driver.pragma('page_count', { simple: true }) as number
	const free = () => driver.pragma('freelist_count', { simple: true }) as number
	const filled = pages()
	driver.prepare('DELETE FROM t').run()
	expect(free()).toBeGreaterThan(100)
	await expect.poll(free, { timeout: 5000 }).toBe(0)
	expect(pages()).toBeLessThan(filled / 2)
})
