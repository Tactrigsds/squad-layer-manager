import * as DateFns from 'date-fns'
import fs from 'node:fs'
import path from 'node:path'
import * as Stream from 'node:stream/promises'
import * as Zlib from 'node:zlib'

// Naming, writing and retention of database backups, shared by the two things that take them: the periodic
// backup loop (backups.server.ts) and the pre-migration snapshot (migrate.ts). This module deliberately knows
// nothing about env, logging or the driver -- the pre-migration path runs before any of that is set up.
//
// Backups are named slm-backup-<db filename>[-pre-migration]-<sha>-<yyyyMMdd>-<HHmmss>.sqlite3.gz, e.g.
// slm-backup-db-a6047f44deb0-20260713-134016.sqlite3.gz for the default ./data/db.sqlite3. Naming them after the
// source db means backups of different databases (two SLM instances pointed at one sftp directory, say) can't be
// mistaken for each other -- which matters because retention deletes everything matching the prefix. Restore with
// `gunzip -c <backup> > db.sqlite3`.
//
// <sha> is the short git sha of the build that owned the database when the snapshot was taken (see db-meta.ts). It
// rides in the name so a backup can be selected and listed by version without unpacking it. Backups written before
// this segment existed simply have no sha, and still parse (with sha null) -- the parser makes it optional.
export const BACKUP_FILE_EXT = '.sqlite3.gz'

// why a backup was taken. It is in the file name so that a pre-migration snapshot can be found (and restored) as
// what it is, and so that retention can pin the newest one -- not because the two are separate collections.
export const BACKUP_KINDS = ['periodic', 'pre-migration'] as const
export type BackupKind = typeof BACKUP_KINDS[number]

function filePrefix(dbPath: string, kind: BackupKind) {
	const db = path.basename(dbPath).replace(/\.sqlite3?$/, '')
	return kind === 'pre-migration' ? `slm-backup-${db}-pre-migration` : `slm-backup-${db}`
}

// the sha is optional in the pattern so backups written before the sha segment existed still parse. It can't be
// confused with the timestamp that follows: the timestamp is two fixed-width all-digit groups, and even a fully
// numeric short sha only matches the optional group when a second `-<8 digits>-<6 digits>` still follows it.
function filePattern(dbPath: string, kind: BackupKind) {
	return new RegExp(
		`^${escapeRegExp(filePrefix(dbPath, kind))}-(?:([0-9a-f]{7,40}|unknown)-)?(\\d{8})-(\\d{6})${escapeRegExp(BACKUP_FILE_EXT)}$`,
	)
}

// A filename-safe token for the owning build: a lowercased hex prefix of the git sha (see db-meta.ts), or `unknown`
// for a database that carries no stamp. Trimmed to 12 chars -- long enough to be unambiguous, short enough to read.
export function shaToken(sha: string | null | undefined): string {
	const hex = /^[0-9a-f]+/i.exec((sha ?? '').trim())?.[0]
	return hex && hex.length >= 7 ? hex.slice(0, 12).toLowerCase() : 'unknown'
}

export function fileName(dbPath: string, kind: BackupKind, sha: string | null | undefined, at = new Date()) {
	return `${filePrefix(dbPath, kind)}-${shaToken(sha)}-${DateFns.format(at, 'yyyyMMdd-HHmmss')}${BACKUP_FILE_EXT}`
}

// Whether a backup's sha token satisfies a `--commit-sha` request. The request may be a full sha, a short one, or a
// `commit-<sha>` image tag; a match is either being a prefix of the other, so 7-, 12- and 40-char forms all line up.
// A backup with no stamp (`unknown`, or an older name with no sha at all) never matches.
export function shaMatchesRequest(fileSha: string | null, requested: string): boolean {
	if (!fileSha || fileSha === 'unknown') return false
	const req = requested.trim().toLowerCase().replace(/^commit-/, '')
	return req.length > 0 && (fileSha.startsWith(req) || req.startsWith(fileSha))
}

// `stamp` is the file's yyyyMMddHHmmss, which sorts chronologically. The whole NAME does not: `-pre-migration`
// sits between the db name and the timestamp, so sorting on that orders every pre-migration backup after every
// periodic one, whatever their dates -- which, once the two share a retention window, silently means retention
// keeps the wrong files.
export type BackupFile = { name: string; kind: BackupKind; stamp: string; sha: string | null }

// null when the file isn't a backup of this database at all. Anything that returns null is left alone forever:
// retention only ever deletes files we wrote ourselves. `sha` is the owning build's short sha, or null for a backup
// named before the sha segment existed.
export function parseBackupFile(fileName: string, dbPath: string): BackupFile | null {
	// pre-migration first: the periodic pattern requires the timestamp immediately after the db name, so the two
	// can't both match, but trying the more specific one first makes that a property of this function rather than
	// of the regexes.
	for (const kind of ['pre-migration', 'periodic'] as const) {
		const match = filePattern(dbPath, kind).exec(fileName)
		if (match) return { name: fileName, kind, stamp: match[2] + match[3], sha: match[1] ?? null }
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
