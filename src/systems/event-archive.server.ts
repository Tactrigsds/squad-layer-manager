import * as E from 'drizzle-orm'
import * as Timers from 'node:timers/promises'

import * as Schema from '$root/drizzle/schema'
import type * as SchemaModels from '$root/drizzle/schema.models'
import * as Arr from '@/lib/array-utils'
import * as Prom from '@/lib/promise-utils'
import * as CS from '@/models/context-shared'
import * as EA from '@/models/event-archive.models'
import type * as C from '@/server/context'
import * as DB from '@/server/db'
import * as Env from '@/server/env'
import * as Instr from '@/server/instrumentation'
import { initModule } from '@/server/logger'
import * as CleanupSys from '@/systems/cleanup.server'

const module = initModule('event-archive')
let log!: CS.Logger

const buildEnv = Env.getEnvBuilder({ ...Env.groups.general, ...Env.groups.db, ...Env.groups.backups })
let ENV!: ReturnType<typeof buildEnv>

// Compaction runs on its own schedule rather than alongside backups: an install with backups switched off
// still has to keep its hot table bounded, and the work is cheap enough that catching up hourly is plenty.
// The first pass is one interval in, which doubles as the settle delay boot wants.

export function setup() {
	log = module.getLogger()
	ENV = buildEnv()
	void runCompactionLoop()
}

async function runCompactionLoop() {
	const ctx = DB.addPooledDb({ ...CS.init(), log, signal: CleanupSys.shutdownSignal })
	try {
		for (;;) {
			await Timers.setTimeout(ENV.EVENT_ARCHIVE_INTERVAL, undefined, { signal: ctx.signal })
			try {
				await compactAgedMatches(ctx, { window: ENV.EVENT_ARCHIVE_WINDOW, minHotMatches: ENV.EVENT_ARCHIVE_MIN_HOT_MATCHES })
			} catch (err) {
				if (Prom.isAbortError(err)) return
				log.error(err, 'event compaction pass failed')
			}
		}
	} catch (err) {
		if (!Prom.isAbortError(err)) throw err
	}
}

// how many matches one pass will pack, so a long-idle install catches up over several passes rather than
// spending minutes in one. Each match costs a few ms of compression plus a short write transaction.
const COMPACT_BATCH = 200

// how many matches one retention transaction drops. Each is a scan of the two tables with no matchId index,
// so bigger is cheaper -- bounded only to keep the write lock short.
const PRUNE_BATCH = 500

// Which of a batch's events pruning must keep, moved into retainedEvents by the sieve itself before it
// returns. Registered by history-retention.server.ts rather than imported: that module reaches back into
// this one through the layer engine chain, so an import here would close a cycle.
export type RetentionSieve = (ctx: C.Db & CS.AbortSignal, matchIds: number[]) => Promise<Set<number>>
let retentionSieve: RetentionSieve | undefined
export function registerRetentionSieve(sieve: RetentionSieve) {
	retentionSieve = sieve
}

// The ordinal below which matches may leave the hot table, or undefined while the server has not yet played
// enough of them for any to be eligible.
async function hotFloorOrdinal(ctx: C.Db, serverId: string, minHotMatches: number): Promise<number | undefined> {
	if (minHotMatches === 0) {
		const [newest] = await ctx
			.db()
			.select({ ordinal: Schema.matchHistory.ordinal })
			.from(Schema.matchHistory)
			.where(E.eq(Schema.matchHistory.serverId, serverId))
			.orderBy(E.desc(Schema.matchHistory.ordinal))
			.limit(1)
		// still never the current match: its events are being written as it plays
		return newest ? newest.ordinal : undefined
	}
	const [floor] = await ctx
		.db()
		.select({ ordinal: Schema.matchHistory.ordinal })
		.from(Schema.matchHistory)
		.where(E.eq(Schema.matchHistory.serverId, serverId))
		.orderBy(E.desc(Schema.matchHistory.ordinal))
		.limit(1)
		.offset(minHotMatches - 1)
	return floor?.ordinal
}

/**
 * Packs the server events of matches that have left the recent window into one compressed row each, and
 * deletes the rows they came from.
 *
 * The archive is the source of truth for a compacted match: `loadMatchEvents` reads back exactly the rows
 * that went in, so no caller can tell the difference. What survives compaction relationally is the part
 * searches run on -- playerEventIndex for the player dimension, matchHistory for the layer dimension --
 * and both are written when the event is recorded, not here.
 */
export const compactAgedMatches = Instr.spanOp(
	'compactAgedMatches',
	{ module },
	async (ctx: C.Db & CS.AbortSignal, opts: { window: number; minHotMatches: number }) => {
		const cutoff = Date.now() - opts.window
		const serverIds = await ctx.db().selectDistinct({ serverId: Schema.matchHistory.serverId }).from(Schema.matchHistory)

		let matches = 0
		let events = 0
		let rawBytes = 0
		let packedBytes = 0

		for (const { serverId } of serverIds) {
			ctx.signal.throwIfAborted()

			// the ordinal of the oldest match kept hot regardless of age. absent while the server is still
			// inside its first minHotMatches, in which case nothing on it can be compacted yet.
			const floor = await hotFloorOrdinal(ctx, serverId, opts.minHotMatches)
			if (floor === undefined) continue

			// a match that never recorded an end (crashed, or was never finalized) is dated by its start, and
			// failing that by when we first saw it. a null time compares as null, so such a match is kept hot.
			const matchTime = E.sql<number>`coalesce(${Schema.matchHistory.endTime}, ${Schema.matchHistory.startTime}, ${Schema.matchHistory.createdAt})`
			const candidates = await ctx
				.db()
				.select({ id: Schema.matchHistory.id })
				.from(Schema.matchHistory)
				.where(
					E.and(
						E.eq(Schema.matchHistory.serverId, serverId),
						E.lt(Schema.matchHistory.ordinal, floor),
						E.lt(matchTime, cutoff),
						E.notExists(
							ctx
								.db()
								.select({ one: E.sql`1` })
								.from(Schema.archivedMatches)
								.where(E.eq(Schema.archivedMatches.matchId, Schema.matchHistory.id)),
						),
					),
				)
				.orderBy(E.asc(Schema.matchHistory.ordinal))
				.limit(COMPACT_BATCH)

			for (const { id: matchId } of candidates) {
				ctx.signal.throwIfAborted()

				const rows = await ctx
					.db()
					.select()
					.from(Schema.serverEvents)
					.where(E.eq(Schema.serverEvents.matchId, matchId))
					.orderBy(E.asc(Schema.serverEvents.id))
				if (rows.length === 0) continue

				// packed before the transaction opens: zlib runs on the threadpool, and awaiting it under the
				// process-wide transaction lock would stall every other write in the process for its duration.
				const blob = await EA.pack(rows)

				await DB.runTransaction(ctx, async (ctx) => {
					await ctx.db().insert(Schema.archivedMatches).values({
						matchId,
						serverId,
						eventCount: rows.length,
						minEventId: rows[0].id,
						maxEventId: rows[rows.length - 1].id,
						encoding: EA.ENCODING,
						events: blob,
					})
					await ctx.db().delete(Schema.serverEvents).where(E.eq(Schema.serverEvents.matchId, matchId))
				})

				matches++
				events += rows.length
				for (const row of rows) rawBytes += JSON.stringify(row.data).length
				packedBytes += blob.length

				// hand the loop back between matches: compression and the write lock are both blocking enough
				// that a long run would otherwise be felt as rcon and websocket latency
				await Timers.setImmediate(undefined, { signal: ctx.signal })
			}
		}

		if (matches > 0) {
			log.info(
				'compacted %d events from %d matches, %d -> %d bytes (%sx)',
				events,
				matches,
				rawBytes,
				packedBytes,
				(rawBytes / Math.max(packedBytes, 1)).toFixed(1),
			)
		}
		return { matches, events, rawBytes, packedBytes }
	},
)

/**
 * A match's server events, from the hot table or the archive, in the shape a `select` from serverEvents
 * returns either way. Callers pass any mix of the two and never learn which was which.
 */
export const loadMatchEvents = Instr.spanOp(
	'loadMatchEvents',
	{ module, levels: { event: 'trace' } },
	async (ctx: C.Db & CS.AbortSignal, matchIds: number[]): Promise<Map<number, SchemaModels.ServerEvent[]>> => {
		const byMatch = new Map<number, SchemaModels.ServerEvent[]>()
		if (matchIds.length === 0) return byMatch
		for (const matchId of matchIds) byMatch.set(matchId, [])

		const hotRows = await ctx
			.db()
			.select()
			.from(Schema.serverEvents)
			.where(E.inArray(Schema.serverEvents.matchId, matchIds))
			.orderBy(E.asc(Schema.serverEvents.id))
		for (const row of hotRows) byMatch.get(row.matchId)?.push(row)

		// compaction inserts the archive row and deletes the hot rows in one transaction, so a match is in
		// exactly one of the two. Reading both and preferring the hot rows costs one indexed lookup and means
		// a half-applied state (which only a corrupted db could produce) reads as the un-compacted match.
		const archivedIds = matchIds.filter((id) => byMatch.get(id)!.length === 0)
		if (archivedIds.length > 0) {
			const archived = await ctx.db().select().from(Schema.archivedMatches).where(E.inArray(Schema.archivedMatches.matchId, archivedIds))
			for (const row of archived) {
				byMatch.set(row.matchId, await EA.unpack(row.matchId, row.encoding, row.events as Buffer))
			}
		}

		// a pruned match may still have events a retention rule kept; the row shape mirrors serverEvents
		const prunedIds = matchIds.filter((id) => byMatch.get(id)!.length === 0)
		if (prunedIds.length > 0) {
			const kept = await ctx
				.db()
				.select()
				.from(Schema.retainedEvents)
				.where(E.inArray(Schema.retainedEvents.matchId, prunedIds))
				.orderBy(E.asc(Schema.retainedEvents.serverEventId))
			for (const row of kept) {
				byMatch.get(row.matchId)?.push({
					id: row.serverEventId,
					type: row.type,
					time: row.time,
					matchId: row.matchId,
					appEventId: row.appEventId,
					version: row.version,
					data: row.data,
				})
			}
		}

		return byMatch
	},
)

/**
 * Drops archived matches that fell past the retention period, with the index entries and chat text that point
 * into them.
 * The matchHistory rows stay: they are small, and they are what the balance and repeat rules read.
 *
 * This is the second half of the event lifecycle -- compaction moves a match from hot to archived, and this
 * moves it from archived to gone. Only ever deletes what compaction has already packed, so an install with
 * retention set still keeps every match hot for its window first.
 */
export const pruneArchivedMatches = Instr.spanOp(
	'pruneArchivedMatches',
	{ module },
	async (ctx: C.Db & CS.AbortSignal, opts: { retention: number }) => {
		const cutoff = Date.now() - opts.retention
		const minHotMatches = ENV.EVENT_ARCHIVE_MIN_HOT_MATCHES
		const serverIds = await ctx.db().selectDistinct({ serverId: Schema.matchHistory.serverId }).from(Schema.matchHistory)

		let matches = 0
		let events = 0
		for (const { serverId } of serverIds) {
			ctx.signal.throwIfAborted()

			const floor = await hotFloorOrdinal(ctx, serverId, minHotMatches)
			if (floor === undefined) continue

			const matchTime = E.sql<number>`coalesce(${Schema.matchHistory.endTime}, ${Schema.matchHistory.startTime}, ${Schema.matchHistory.createdAt})`
			const stale = await ctx
				.db()
				.select({ matchId: Schema.archivedMatches.matchId, eventCount: Schema.archivedMatches.eventCount })
				.from(Schema.archivedMatches)
				.innerJoin(Schema.matchHistory, E.eq(Schema.matchHistory.id, Schema.archivedMatches.matchId))
				.where(E.and(E.eq(Schema.matchHistory.serverId, serverId), E.lt(Schema.matchHistory.ordinal, floor), E.lt(matchTime, cutoff)))
			if (stale.length === 0) continue

			// Both deletes below scan a table that has no index on matchId -- by design in each case (see the
			// note on playerEventIndex, and fts5's UNINDEXED columns). So each runs ONCE for the server's whole
			// stale set rather than once per match, which is what keeps pruning linear rather than quadratic.
			const staleIds = stale.map((s) => s.matchId)
			for (const batch of Arr.paged(staleIds, PRUNE_BATCH)) {
				ctx.signal.throwIfAborted()
				// outside the transaction: the sieve unpacks archive blobs, which yields to the threadpool
				const retained = retentionSieve ? await retentionSieve(ctx, batch) : new Set<number>()
				const keep = retained.size > 0 ? JSON.stringify([...retained]) : undefined
				await DB.runTransaction(ctx, async (ctx) => {
					await ctx
						.db()
						.delete(Schema.playerEventIndex)
						.where(
							E.and(
								E.inArray(Schema.playerEventIndex.matchId, batch),
								keep ? E.sql`${Schema.playerEventIndex.serverEventId} NOT IN (SELECT value FROM json_each(${keep}))` : undefined,
							),
						)
					// not awaited: run() on the better-sqlite3 driver is synchronous (see the insert in squad-server)
					ctx
						.db()
						.run(
							keep
								? E.sql`DELETE FROM chatSearch WHERE matchId IN ${batch} AND serverEventId NOT IN (SELECT value FROM json_each(${keep}))`
								: E.sql`DELETE FROM chatSearch WHERE matchId IN ${batch}`,
						)
					await ctx.db().delete(Schema.archivedMatches).where(E.inArray(Schema.archivedMatches.matchId, batch))
				})
				await Timers.setImmediate(undefined, { signal: ctx.signal })
			}
			matches += stale.length
			for (const s of stale) events += s.eventCount

			log.info('pruned %d archived matches on server %s', stale.length, serverId)
		}

		return { matches, events }
	},
)
