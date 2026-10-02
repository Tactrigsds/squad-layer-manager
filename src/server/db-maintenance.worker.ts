import DatabaseConstructor from 'better-sqlite3'
import { parentPort, workerData } from 'node:worker_threads'

// WAL checkpoints and backup snapshots, on a thread and a connection of their own. On the main connection both run
// synchronously on the event loop: sqlite runs a checkpoint inside whichever COMMIT pushes the WAL past
// wal_autocheckpoint, which during ingest is a ~13ms stall every few hundred events, longer on a slower disk.
// A snapshot of a large database takes seconds.
//
// A PASSIVE checkpoint never waits on a lock, so it runs alongside the main connection's writes. A snapshot is a
// read transaction, which sees one consistent state of the database while writes carry on.

export type WorkerData = { dbPath: string; checkpointIntervalMs: number }
export type Request = { seq: number; snapshotTo: string }
export type Response = { ready: true } | { seq: number; err?: { message: string; stack?: string } }

const { dbPath, checkpointIntervalMs } = workerData as WorkerData

const driver = new DatabaseConstructor(dbPath, { fileMustExist: true })
driver.pragma('busy_timeout = 5000')
// a checkpoint syncs at this connection's level, so it matches the main connection's
driver.pragma('synchronous = NORMAL')

const checkpoint = driver.prepare('PRAGMA wal_checkpoint(PASSIVE)')
// VACUUM INTO writes a compacted copy, with none of the free pages a page-by-page backup would carry over
const snapshot = driver.prepare('VACUUM INTO ?')

// a checkpoint that throws (disk full, an io error) takes the thread down, and the main thread falls back to
// checkpointing on its own connection
setInterval(() => checkpoint.get(), checkpointIntervalMs)

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
