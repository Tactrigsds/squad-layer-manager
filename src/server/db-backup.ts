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

// why a backup was taken. It is in the file name so that a pre-migration snapshot can be found (and restored) as
// what it is, and so that retention can pin the newest one -- not because the two are separate collections.
export const BACKUP_KINDS = ['periodic', 'pre-migration'] as const
export type BackupKind = typeof BACKUP_KINDS[number]

function filePrefix(dbPath: string, kind: BackupKind) {
	const db = path.basename(dbPath).replace(/\.sqlite3?$/, '')
	return kind === 'pre-migration' ? `slm-backup-${db}-pre-migration` : `slm-backup-${db}`
}

function filePattern(dbPath: string, kind: BackupKind) {
	return new RegExp(`^${escapeRegExp(filePrefix(dbPath, kind))}-(\\d{8})-(\\d{6})${escapeRegExp(BACKUP_FILE_EXT)}$`)
}

export function fileName(dbPath: string, kind: BackupKind, at = new Date()) {
	return `${filePrefix(dbPath, kind)}-${DateFns.format(at, 'yyyyMMdd-HHmmss')}${BACKUP_FILE_EXT}`
}

// `stamp` is the file's yyyyMMddHHmmss, which sorts chronologically. The whole NAME does not: `-pre-migration`
// sits between the db name and the timestamp, so sorting on that orders every pre-migration backup after every
// periodic one, whatever their dates -- which, once the two share a retention window, silently means retention
// keeps the wrong files.
export type BackupFile = { name: string; kind: BackupKind; stamp: string }

// null when the file isn't a backup of this database at all. Anything that returns null is left alone forever:
// retention only ever deletes files we wrote ourselves.
export function parseBackupFile(fileName: string, dbPath: string): BackupFile | null {
	// pre-migration first: the periodic pattern requires the timestamp immediately after the db name, so the two
	// can't both match, but trying the more specific one first makes that a property of this function rather than
	// of the regexes.
	for (const kind of ['pre-migration', 'periodic'] as const) {
		const match = filePattern(dbPath, kind).exec(fileName)
		if (match) return { name: fileName, kind, stamp: match[1] + match[2] }
	}
	return null
}

export function kindOf(fileName: string, dbPath: string): BackupKind | null {
	return parseBackupFile(fileName, dbPath)?.kind ?? null
}

// every backup of THIS database in a directory listing, newest first, of either kind
export function backupFiles(fileNames: string[], dbPath: string): BackupFile[] {
	return fileNames
		.map(name => parseBackupFile(name, dbPath))
		.filter((f): f is BackupFile => f !== null)
		.sort((a, b) => (a.stamp < b.stamp ? 1 : a.stamp > b.stamp ? -1 : 0))
}

// The backups outside the retention window: one window over both kinds, because a backup is a backup and the
// database only has one past. retainCount 0 keeps all of them.
//
// One exception, and it is the reason the kinds are distinguishable at all: the newest pre-migration backup is
// never pruned, however far out of the window it has fallen. It is the only thing a bad upgrade can be rolled
// back to, and it is precisely the deployments backing up most often that would otherwise age it out within the
// day. That makes the count a floor rather than a hard cap -- you can end up holding retainCount + 1.
export function staleBackupFiles(fileNames: string[], opts: { dbPath: string; retainCount: number; keep?: string }) {
	if (opts.retainCount === 0) return []
	const all = backupFiles(fileNames, opts.dbPath)
	const kept = new Set(all.slice(0, opts.retainCount).map(f => f.name))
	const rollbackPoint = all.find(f => f.kind === 'pre-migration')
	if (rollbackPoint) kept.add(rollbackPoint.name)
	if (opts.keep) kept.add(opts.keep)
	return all.filter(f => !kept.has(f.name)).map(f => f.name)
}

export function pruneBackups(opts: { dir: string; dbPath: string; retainCount: number; keep?: string }) {
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
