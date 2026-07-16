import * as DateFns from 'date-fns'
import fs from 'node:fs'
import path from 'node:path'
import * as Stream from 'node:stream/promises'
import * as Zlib from 'node:zlib'

// Naming, writing and retention of database backups, shared by the two things that take them: the periodic
// backup loop (backups.server.ts) and the pre-migration snapshot (migrate.ts). This module deliberately knows
// nothing about env, logging or the driver -- the pre-migration path runs before any of that is set up.
//
// Backups are named slm-backup-<db filename>[-pre-migration]-<yyyyMMdd>-<HHmmss>.sqlite3.gz, e.g.
// slm-backup-db-20260713-134016.sqlite3.gz for the default ./data/db.sqlite3. Naming them after the source db
// means backups of different databases (two SLM instances pointed at one sftp directory, say) can't be mistaken
// for each other -- which matters because retention deletes everything matching the prefix. Restore with
// `gunzip -c <backup> > db.sqlite3`.
export const BACKUP_FILE_EXT = '.sqlite3.gz'

// the two kinds are named apart because they are retained apart: each kind's retention only ever sees, and only
// ever deletes, files of its own kind. A pre-migration snapshot is the one backup you want to still be there
// after a migration went wrong, so a busy periodic schedule must not be able to age it out.
export type BackupKind = 'periodic' | 'pre-migration'

function filePrefix(dbPath: string, kind: BackupKind) {
	const db = path.basename(dbPath).replace(/\.sqlite3?$/, '')
	return kind === 'pre-migration' ? `slm-backup-${db}-pre-migration` : `slm-backup-${db}`
}

function filePattern(dbPath: string, kind: BackupKind) {
	return new RegExp(`^${escapeRegExp(filePrefix(dbPath, kind))}-\\d{8}-\\d{6}${escapeRegExp(BACKUP_FILE_EXT)}$`)
}

export function fileName(dbPath: string, kind: BackupKind, at = new Date()) {
	return `${filePrefix(dbPath, kind)}-${DateFns.format(at, 'yyyyMMdd-HHmmss')}${BACKUP_FILE_EXT}`
}

// the backups of THIS database, of THIS kind, in a directory, newest first (the timestamp is in the name, so
// lexical order is chronological). Anything else there is left alone: retention only ever deletes files we wrote
// ourselves. The periodic pattern requires the timestamp immediately after the db name, so it can't match a
// pre-migration backup.
export function backupFiles(fileNames: string[], dbPath: string, kind: BackupKind) {
	const pattern = filePattern(dbPath, kind)
	return fileNames.filter(name => pattern.test(name)).sort().reverse()
}

// the backups beyond retainCount, and never the one we just took. retainCount 0 keeps all of them.
export function staleBackupFiles(fileNames: string[], opts: { dbPath: string; kind: BackupKind; retainCount: number; keep?: string }) {
	if (opts.retainCount === 0) return []
	return backupFiles(fileNames, opts.dbPath, opts.kind).slice(opts.retainCount).filter(name => name !== opts.keep)
}

export function pruneBackups(opts: { dir: string; dbPath: string; kind: BackupKind; retainCount: number; keep?: string }) {
	const stale = staleBackupFiles(fs.readdirSync(opts.dir), opts)
	for (const name of stale) fs.rmSync(path.join(opts.dir, name), { force: true })
	return stale
}

// streamed, so a multi-GB db never lands in memory. gzip is a big win here: a sqlite file is mostly repetitive page
// structure and text, and the archive is what we ship over sftp and keep N copies of at both ends.
async function gzipFile(sourcePath: string, destPath: string, signal?: AbortSignal) {
	await Stream.pipeline(
		fs.createReadStream(sourcePath),
		Zlib.createGzip(),
		fs.createWriteStream(destPath),
		{ signal },
	)
}

// Snapshots the db via `snapshot` (which sqlite writes itself) and gzips it into destPath. Both stages land on temp
// names and only the finished archive is renamed into place (atomic within the directory): a crash at either step
// would otherwise leave a partial file that still looks like a complete backup.
export async function writeBackup(
	opts: { destPath: string; snapshot: (destPath: string) => Promise<unknown>; signal?: AbortSignal },
) {
	fs.mkdirSync(path.dirname(opts.destPath), { recursive: true })
	const snapshotPath = `${opts.destPath}.snapshot.tmp`
	const tmpPath = `${opts.destPath}.tmp`
	let snapshotBytes: number
	try {
		await opts.snapshot(snapshotPath)
		snapshotBytes = fs.statSync(snapshotPath).size
		await gzipFile(snapshotPath, tmpPath, opts.signal)
		fs.renameSync(tmpPath, opts.destPath)
	} finally {
		// the snapshot is an intermediate: it's the archive we keep. removed on the happy path too.
		fs.rmSync(snapshotPath, { force: true })
		fs.rmSync(tmpPath, { force: true })
	}
	return { sizeBytes: fs.statSync(opts.destPath).size, snapshotBytes }
}

function escapeRegExp(str: string) {
	return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
