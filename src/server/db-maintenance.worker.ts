import DatabaseConstructor from 'better-sqlite3'
import { parentPort, workerData } from 'node:worker_threads'

// WAL checkpoints, backup snapshots and incremental vacuuming, on a thread and a connection of their own. On the main connection both run
// synchronously on the event loop: sqlite runs a checkpoint inside whichever COMMIT pushes the WAL past
// wal_autocheckpoint, which during ingest is a ~13ms stall every few hundred events, longer on a slower disk.
// A snapshot of a large database takes seconds.
//
// A PASSIVE checkpoint never waits on a lock, so it runs alongside the main connection's writes. A snapshot is a
// read transaction, which sees one consistent state of the database while writes carry on.
//
// The database runs with auto_vacuum=INCREMENTAL (see db.ts), so pages freed by deletes stay in the file until
// incremental_vacuum hands them back. That takes the write lock, and a main-connection write arriving meanwhile waits
// for it, synchronously. So it frees VACUUM_STEP_PAGES per tick: on a production copy 128 pages held the lock 1.6ms
// at the median. It starts once more than `vacuumStartPages` are free and runs until none are.

export type WorkerData = { dbPath: string; checkpointIntervalMs: number; vacuumStartPages: number }
export type Request = { seq: number; snapshotTo: string }
export type Response = { ready: true } | { seq: number; err?: { message: string; stack?: string } }

const VACUUM_STEP_PAGES = 128

const { dbPath, checkpointIntervalMs, vacuumStartPages } = workerData as WorkerData

const driver = new DatabaseConstructor(dbPath, { fileMustExist: true })
driver.pragma('busy_timeout = 5000')
// a checkpoint syncs at this connection's level, so it matches the main connection's
driver.pragma('synchronous = NORMAL')

const checkpoint = driver.prepare('PRAGMA wal_checkpoint(PASSIVE)')
const freePages = driver.prepare('PRAGMA freelist_count').pluck()
// VACUUM INTO writes a compacted copy, with none of the free pages a page-by-page backup would carry over
const snapshot = driver.prepare('VACUUM INTO ?')

let vacuuming = false
// a checkpoint or vacuum step that throws (disk full, an io error) takes the thread down, and the main thread falls
// back to checkpointing on its own connection
setInterval(() => {
	const free = freePages.get() as number
	vacuuming = free > 0 && (vacuuming || free > vacuumStartPages)
	// exec, not a prepared statement's run(): run() steps once, and each step frees one page
	if (vacuuming) driver.exec(`PRAGMA incremental_vacuum(${VACUUM_STEP_PAGES})`)
	checkpoint.get()
}, checkpointIntervalMs)

parentPort!.on('message', ({ seq, snapshotTo }: Request) => {
	let res: Response
	try {
		snapshot.run(snapshotTo)
		res = { seq }
	} catch (err) {
		res = { seq, err: err instanceof Error ? { message: err.message, stack: err.stack } : { message: String(err) } }
	}
	parentPort!.postMessage(res satisfies Response)
})

parentPort!.postMessage({ ready: true } satisfies Response)
