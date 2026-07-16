import * as Schema from '$root/drizzle/schema'
import { isAbortError, sleep } from '@/lib/async'
import * as SFS from '@/lib/sftp-file-store'
import { formatDurationApprox, formatHumanTime, parseHumanTime } from '@/lib/zod'
import * as AppEvents from '@/models/app-events.models'
import * as CS from '@/models/context-shared'
import * as MH from '@/models/match-history.models'
import * as C from '@/server/context'
import * as DB from '@/server/db'
import * as DbBackup from '@/server/db-backup'
import * as Env from '@/server/env'
import { initModule } from '@/server/logger'
import * as AppEventsSys from '@/systems/app-events.server'
import * as CleanupSys from '@/systems/cleanup.server'
import * as E from 'drizzle-orm'
import fs from 'node:fs'
import path from 'node:path'
import * as Timers from 'node:timers/promises'

const module = initModule('backups')
let log!: CS.Logger

const buildEnv = Env.getEnvBuilder({ ...Env.groups.general, ...Env.groups.db, ...Env.groups.backups })
let ENV!: ReturnType<typeof buildEnv>

// the most recent matches per server are never pruned, however old they are. MAX_RECENT_MATCHES of them are loaded
// into match-history state at boot (with their events), so pruning below that line would leave the recent-match feed
// with matches whose events have been deleted.
const MIN_RETAINED_MATCHES = Math.max(100, MH.MAX_RECENT_MATCHES)

// how long a boot that comes up already due for a backup waits before taking it, so the snapshot doesn't land while
// the rest of the app is still setting itself up
const BOOT_SETTLE_DELAY = parseHumanTime('1m')
const FAILED_BACKUP_RETRY_DELAY = parseHumanTime('30m')

export function setup() {
	log = module.getLogger()
	ENV = buildEnv()
	void run()
}

async function run() {
	const ctx = DB.addPooledDb({ ...CS.init(), log, signal: CleanupSys.shutdownSignal })

	// before anything else, and whether or not the periodic schedule is even on: a pre-migration backup may have just
	// been taken, and until it's adopted this system doesn't know it exists.
	try {
		await adoptUnrecordedBackups(ctx)
	} catch (err) {
		if (!isAbortError(err)) log.error(err, 'failed to account for backups taken outside the schedule')
	}

	if (ENV.AUTOMATIC_BACKUPS_PERIODIC === undefined) {
		log.info('automatic backups disabled (AUTOMATIC_BACKUPS_PERIODIC unset)')
		return
	}
	const sftp = getSftpTarget()
	log.info(
		'automatic backups every %s to %s%s, event history retention: %s',
		formatHumanTime(ENV.AUTOMATIC_BACKUPS_PERIODIC),
		ENV.BACKUPS_DIR,
		sftp ? ` (uploading to ${sftp.username}@${sftp.host}:${ENV.BACKUP_SFTP_DIR})` : '',
		ENV.EVENT_HISTORY_RETENTION_PERIOD === undefined ? 'disabled' : formatHumanTime(ENV.EVENT_HISTORY_RETENTION_PERIOD),
	)
	await runBackupLoop(ENV.AUTOMATIC_BACKUPS_PERIODIC, ctx)
}

// A pre-migration snapshot is taken by the migration runner (see server/migrate.ts) before the app exists, so it can't
// record itself, ship itself offsite, or tell the schedule that it happened. Rather than a handoff, we notice it here:
// a pre-migration backup newer than the newest BACKUP_CREATED event is one nothing has accounted for. Adopting it is
// what stops the two triggers producing two snapshots of the same database a minute apart -- and it's also how the
// audit log gets to mention pre-migration backups at all, and how they reach the sftp target.
//
// Deliberately driven off what's on disk rather than a handoff file: it costs nothing, it's self-healing, and it
// equally covers a snapshot taken by an out-of-band `pnpm db:migrate:prod` days before this boot.
const adoptUnrecordedBackups = C.spanOp('adoptUnrecordedBackups', { module }, async (ctx: C.Db & CS.AbortSignal) => {
	if (!fs.existsSync(ENV.BACKUPS_DIR)) return
	const loggedAt = await getLastBackupEventTime(ctx)
	// only pre-migration backups: a periodic one is written by the loop below, which records its own event, so an
	// unrecorded periodic file means the event failed to write and re-adopting it would say it happened twice.
	const unrecorded = DbBackup.backupFiles(fs.readdirSync(ENV.BACKUPS_DIR), ENV.DB_PATH)
		.filter(f => f.kind === 'pre-migration')
		.map(f => ({ fileName: f.name, stat: fs.statSync(path.join(ENV.BACKUPS_DIR, f.name)) }))
		.filter(f => loggedAt === undefined || f.stat.mtimeMs > loggedAt)
		.reverse() // oldest first, so the audit log reads in the order they were taken

	for (const { fileName, stat } of unrecorded) {
		ctx.signal.throwIfAborted()
		const uploaded = await uploadBackup(ctx, path.join(ENV.BACKUPS_DIR, fileName), fileName)
		await AppEventsSys.persistAppEvent(
			ctx,
			AppEvents.create<AppEvents.BackupCreated>({
				type: 'BACKUP_CREATED',
				actor: { type: 'system' },
				serverId: null,
				matchId: null,
				causeId: null,
				// when the snapshot was taken, not when we noticed it: this event is what anchors the schedule
				time: stat.mtimeMs,
				fileName,
				sizeBytes: stat.size,
				reason: 'pre-migration',
				uploaded,
			}),
		)
		log.info('recorded pre-migration backup %s, taken %s ago', fileName, formatDurationApprox(Date.now() - stat.mtimeMs))
	}
})

async function runBackupLoop(interval: number, ctx: C.Db & CS.AbortSignal) {
	// the schedule is anchored to the last backup that actually happened, not to boot: a server restarted more often
	// than the interval would otherwise never reach its first backup at all. A backup taken shortly before a restart
	// isn't taken again, and one that came due while we were down is taken now (BOOT_SETTLE_DELAY floors the first
	// sleep either way, so the snapshot doesn't land while the rest of the app is still coming up).
	const lastBackupAt = await getLastBackupTime(ctx)
	const overdueBy = lastBackupAt === null ? 0 : Date.now() - (lastBackupAt + interval)
	let wait = Math.max(BOOT_SETTLE_DELAY, -overdueBy)
	if (lastBackupAt === null) log.info('no previous backup found, taking one in %s', formatDurationApprox(wait))
	else if (overdueBy > 0) log.info('backup overdue by %s, taking one in %s', formatDurationApprox(overdueBy), formatDurationApprox(wait))
	else log.info('last backup was %s ago, next in %s', formatDurationApprox(Date.now() - lastBackupAt), formatDurationApprox(wait))

	while (!ctx.signal.aborted) {
		try {
			await sleep(wait, ctx.signal)
		} catch {
			break
		}
		try {
			await runBackup(ctx)
			wait = interval
		} catch (err) {
			if (isAbortError(err)) break
			// a failed backup must not kill the loop, but it must not spin either: retry sooner than the full interval,
			// since we're already past due.
			wait = Math.min(interval, FAILED_BACKUP_RETRY_DELAY)
			log.error(err, 'backup failed, retrying in %s', formatDurationApprox(wait))
		}
	}
}

async function getLastBackupEventTime(ctx: C.Db) {
	const [row] = await ctx.db()
		.select({ time: Schema.appEvents.time })
		.from(Schema.appEvents)
		.where(E.eq(Schema.appEvents.type, 'BACKUP_CREATED'))
		.orderBy(E.desc(Schema.appEvents.time))
		.limit(1)
	return row?.time.getTime()
}

// when the last backup was taken, or null if we can't account for one. The audit log records every backup this app
// took; the backups dir holds the artifacts. They normally agree, and when they don't (the db was restored from an
// older snapshot, or the backups dir lives on storage that didn't survive the restart) the older of the two is the
// honest answer: a missing signal means we have no backup we can point at, so we take one.
//
// Every backup counts, whatever it was taken for: having just snapshotted the database in order to migrate it, there
// is nothing for a periodic run to add a minute later, and taking one anyway is how the same database got copied twice
// per upgrade. This is only safe because adoption uploads what it adopts -- anchoring on a local-only file would
// quietly mean nothing reaches the sftp target for a whole interval, which is the one thing offsite exists to prevent.
async function getLastBackupTime(ctx: C.Db) {
	const loggedAt = await getLastBackupEventTime(ctx)

	const files = fs.existsSync(ENV.BACKUPS_DIR) ? DbBackup.backupFiles(fs.readdirSync(ENV.BACKUPS_DIR), ENV.DB_PATH) : []
	const writtenAt = files.length === 0
		? undefined
		: Math.max(...files.map(f => fs.statSync(path.join(ENV.BACKUPS_DIR, f.name)).mtimeMs))

	if (loggedAt === undefined || writtenAt === undefined) return null
	return Math.min(loggedAt, writtenAt)
}

// prunes stale event history, then snapshots the db and (if configured) ships it offsite. The prune runs first so
// the snapshot is of the pruned db -- a backup taken before it would carry the rows we just decided to drop, which
// would make the prune pointless the moment the backup is restored.
export const runBackup = C.spanOp('runBackup', { module }, async (ctx: C.Db & CS.AbortSignal) => {
	const startedAt = Date.now()
	const pruned = await pruneEventHistory(ctx)

	const fileName = DbBackup.fileName(ENV.DB_PATH, 'periodic')
	const destPath = path.join(ENV.BACKUPS_DIR, fileName)
	const { sizeBytes, snapshotBytes } = await DbBackup.writeBackup({
		destPath,
		snapshot: DB.backupTo,
		signal: ctx.signal,
	})
	log.info(
		'wrote backup %s (%d bytes, %sx smaller than the %d byte snapshot)',
		destPath,
		sizeBytes,
		(snapshotBytes / Math.max(sizeBytes, 1)).toFixed(1),
		snapshotBytes,
	)

	const uploaded = await uploadBackup(ctx, destPath, fileName)
	pruneOldBackups(fileName)

	await AppEventsSys.persistAppEvent(
		ctx,
		AppEvents.create<AppEvents.BackupCreated>({
			type: 'BACKUP_CREATED',
			actor: { type: 'system' },
			serverId: null,
			matchId: null,
			causeId: null,
			fileName,
			sizeBytes,
			reason: 'periodic',
			durationMs: Date.now() - startedAt,
			uploaded,
			pruned,
		}),
	)
})

// deletes the server events of matches that both ended before the retention cutoff and fall outside the most recent
// MIN_RETAINED_MATCHES on their server. The matchHistory rows themselves stay: they're small, and they're what the
// balance/repeat-rule history is computed from. player/squad event associations go with the events via FK cascade.
//
// The deleting is done in bounded batches rather than one statement. better-sqlite3 is synchronous, so a DELETE is an
// unyielding block of the event loop -- and the first prune on a long-lived server is a big one (a 600k-event db here
// froze the process for ~3s, which is 3s of no websocket, rcon or http). A batch is small enough to be unnoticeable,
// gets its own short-lived write lock, and the loop breathes in between.
const PRUNE_BATCH_SIZE = 5_000

const pruneEventHistory = C.spanOp('pruneEventHistory', { module }, async (ctx: C.Db & CS.AbortSignal) => {
	const retention = ENV.EVENT_HISTORY_RETENTION_PERIOD
	if (retention === undefined) return undefined

	const cutoff = new Date(Date.now() - retention)
	const serverIds = await ctx.db().selectDistinct({ serverId: Schema.matchHistory.serverId }).from(Schema.matchHistory)

	let events = 0
	let matches = 0
	for (const { serverId } of serverIds) {
		ctx.signal.throwIfAborted()

		// the ordinal of the oldest match we must keep regardless of age. absent when the server hasn't played
		// MIN_RETAINED_MATCHES matches yet, in which case nothing on it is prunable.
		const [floor] = await ctx.db()
			.select({ ordinal: Schema.matchHistory.ordinal })
			.from(Schema.matchHistory)
			.where(E.eq(Schema.matchHistory.serverId, serverId))
			.orderBy(E.desc(Schema.matchHistory.ordinal))
			.limit(1)
			.offset(MIN_RETAINED_MATCHES - 1)
		if (!floor) continue

		// a match that never recorded an end (crashed, or was never finalized) is dated by its start, and failing
		// that by when we first saw it. a null time compares as null here, so such a match is kept.
		const matchTime = E.sql<
			number
		>`coalesce(${Schema.matchHistory.endTime}, ${Schema.matchHistory.startTime}, ${Schema.matchHistory.createdAt})`
		const staleMatches = ctx.db()
			.select({ id: Schema.matchHistory.id })
			.from(Schema.matchHistory)
			.where(E.and(
				E.eq(Schema.matchHistory.serverId, serverId),
				E.lt(Schema.matchHistory.ordinal, floor.ordinal),
				E.lt(matchTime, cutoff.getTime()),
			))

		const [matchCount] = await ctx.db()
			.select({ matches: E.countDistinct(Schema.serverEvents.matchId) })
			.from(Schema.serverEvents)
			.where(E.inArray(Schema.serverEvents.matchId, staleMatches))
		if (!matchCount?.matches) continue

		let deleted = 0
		for (;;) {
			ctx.signal.throwIfAborted()
			// the batch is picked and deleted in one statement, inside one transaction, so nothing can slip in between
			// the pick and the delete
			const batch = await DB.runTransaction(ctx, async (ctx) => {
				const ids = ctx.db()
					.select({ id: Schema.serverEvents.id })
					.from(Schema.serverEvents)
					.where(E.inArray(Schema.serverEvents.matchId, staleMatches))
					.limit(PRUNE_BATCH_SIZE)
				return await ctx.db().delete(Schema.serverEvents).where(E.inArray(Schema.serverEvents.id, ids))
			})
			deleted += batch.changes
			if (batch.changes < PRUNE_BATCH_SIZE) break
			// hand the loop back before taking the write lock again, so a batch never queues up behind another
			await Timers.setImmediate(undefined, { signal: ctx.signal })
		}

		events += deleted
		matches += matchCount.matches
		log.info('pruned %d events from %d matches on server %s', deleted, matchCount.matches, serverId)
	}

	return { events, matches }
})

function getSftpTarget() {
	if (!ENV.BACKUP_SFTP_HOST) return null
	if (!ENV.BACKUP_SFTP_USERNAME) throw new Error('BACKUP_SFTP_HOST is set but BACKUP_SFTP_USERNAME is not')
	if (!ENV.BACKUP_SFTP_PASSWORD && !ENV.BACKUP_SFTP_PRIVATE_KEY_PATH) {
		throw new Error('BACKUP_SFTP_HOST is set but neither BACKUP_SFTP_PASSWORD nor BACKUP_SFTP_PRIVATE_KEY_PATH is')
	}
	const target: SFS.SftpTarget = {
		host: ENV.BACKUP_SFTP_HOST,
		port: ENV.BACKUP_SFTP_PORT,
		username: ENV.BACKUP_SFTP_USERNAME,
		password: ENV.BACKUP_SFTP_PASSWORD,
		privateKey: ENV.BACKUP_SFTP_PRIVATE_KEY_PATH ? SFS.readPrivateKey(ENV.BACKUP_SFTP_PRIVATE_KEY_PATH) : undefined,
		passphrase: ENV.BACKUP_SFTP_PRIVATE_KEY_PASSPHRASE,
	}
	return target
}

// returns undefined when no target is configured, false when the upload failed. An unreachable backup host is not
// worth failing the run over: the local backup is already on disk, and the app event records that it never left.
const uploadBackup = C.spanOp('uploadBackup', { module }, async (ctx: CS.AbortSignal, localPath: string, fileName: string) => {
	const target = getSftpTarget()
	if (!target) return undefined

	const remoteDir = ENV.BACKUP_SFTP_DIR
	let uploaded = false
	try {
		await SFS.withSftp(target, async (sftp) => {
			await sftp.mkdirp(remoteDir)
			await sftp.uploadFile(localPath, `${remoteDir}/${fileName}`)
			uploaded = true
			log.info('uploaded backup %s to %s@%s:%s', fileName, target.username, target.host, remoteDir)

			// retention is best-effort, and deliberately not part of whether the upload succeeded: once the snapshot is
			// offsite the run has done its job, and a delete we're not permitted to make must not get recorded as a
			// backup that never left the box.
			try {
				for (const stale of DbBackup.staleBackupFiles(await sftp.listDir(remoteDir), { ...retentionOpts(), keep: fileName })) {
					await sftp.unlink(`${remoteDir}/${stale}`)
					log.info('deleted remote backup %s', stale)
				}
			} catch (err) {
				if (isAbortError(err)) throw err
				log.error(err, 'failed to prune old backups on %s (the upload itself succeeded)', target.host)
			}
		}, ctx.signal)
		return true
	} catch (err) {
		if (isAbortError(err)) throw err
		log.error(err, 'failed to upload backup %s to %s', fileName, target.host)
		return uploaded
	}
})

function pruneOldBackups(currentFileName: string) {
	for (const stale of DbBackup.pruneBackups({ ...retentionOpts(), dir: ENV.BACKUPS_DIR, keep: currentFileName })) {
		log.info('deleted local backup %s', stale)
	}
}

function retentionOpts() {
	return { dbPath: ENV.DB_PATH, retainCount: ENV.BACKUPS_RETAIN_COUNT }
}
