import * as E from 'drizzle-orm'
import * as Timers from 'node:timers/promises'

import * as Schema from '$root/drizzle/schema'
import type * as SchemaModels from '$root/drizzle/schema.models'
import * as Prom from '@/lib/promise-utils'
import * as CS from '@/models/context-shared.models'
import * as EA from '@/models/event-archive.models'
import type * as C from '@/server/context'
import * as DB from '@/server/db'
import * as Env from '@/server/env'
import * as Instr from '@/server/instrumentation'
import { initModule } from '@/server/logger'
import * as Sql from '@/server/sql'
import * as CleanupSys from '@/systems/cleanup.server'

const module = initModule('event-archive')
const SQL = Sql.forModule(module)
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
	const ctx = DB.withDb({ ...CS.init(), log, signal: CleanupSys.shutdownSignal })
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

// The ordinal below which matches may leave the hot table, or undefined while the server has not yet played
// enough of them for any to be eligible.
function hotFloorOrdinal(ctx: C.Db, serverId: string, minHotMatches: number): number | undefined {
	// with minHotMatches 0 this is the newest match, which is still never compacted: its events are being written as it
	// plays
	return DB.get(ctx, Q.newestOrdinal({ serverId, offset: Math.max(minHotMatches - 1, 0) }))?.ordinal
}

const se = Schema.serverEvents

namespace Q {
	export const serverIds = SQL.def(
		'serverIds',
		SQL.params({}),
		SQL.selectDistinct({ serverId: Schema.matchHistory.serverId }).from(Schema.matchHistory),
		{ scans: ['matchHistory'] },
	)
	const newestOrdinalP = SQL.params({ serverId: Schema.matchHistory.serverId, offset: SQL.count() })
	export const newestOrdinal = SQL.def(
		'newestOrdinal',
		newestOrdinalP,
		SQL.select({ ordinal: Schema.matchHistory.ordinal })
			.from(Schema.matchHistory)
			.where(E.eq(Schema.matchHistory.serverId, newestOrdinalP.serverId))
			.orderBy(E.desc(Schema.matchHistory.ordinal))
			.limit(1)
			.offset(newestOrdinalP.offset),
	)
	// a match that never recorded an end (crashed, or was never finalized) is dated by its start, and failing that by
	// when we first saw it. a null time compares as null, so such a match is kept hot.
	const candidatesP = SQL.params({
		serverId: Schema.matchHistory.serverId,
		floor: Schema.matchHistory.ordinal,
		cutoff: SQL.value<number>(),
	})
	export const candidates = SQL.def(
		'candidates',
		candidatesP,
		SQL.select({ id: Schema.matchHistory.id })
			.from(Schema.matchHistory)
			.where(
				E.and(
					E.eq(Schema.matchHistory.serverId, candidatesP.serverId),
					E.lt(Schema.matchHistory.ordinal, candidatesP.floor),
					E.lt(
						E.sql<number>`coalesce(${Schema.matchHistory.endTime}, ${Schema.matchHistory.startTime}, ${Schema.matchHistory.createdAt})`,
						candidatesP.cutoff,
					),
					E.notExists(
						SQL.select({ one: E.sql`1` })
							.from(Schema.archivedMatches)
							.where(E.eq(Schema.archivedMatches.matchId, Schema.matchHistory.id)),
					),
				),
			)
			.orderBy(E.asc(Schema.matchHistory.ordinal))
			.limit(COMPACT_BATCH),
	)
	const matchIdP = SQL.params({ matchId: se.matchId })
	// time and data as stored, since packing only writes them back out (see EA.pack). json_valid stands in for the parse a
	// mapped select does, so a row the archive could not read back is refused here.
	export const storedEventsOfMatch = SQL.def(
		'storedEventsOfMatch',
		matchIdP,
		SQL.select({
			id: se.id,
			type: se.type,
			time: E.sql<number>`${se.time}`,
			appEventId: se.appEventId,
			version: se.version,
			data: E.sql<string>`${se.data}`,
			valid: E.sql<number>`json_valid(${se.data})`,
		})
			.from(se)
			.where(E.eq(se.matchId, matchIdP.matchId))
			.orderBy(E.asc(se.id)),
	)
	const archiveP = SQL.params(E.getTableColumns(Schema.archivedMatches))
	export const insertArchive = SQL.def('insertArchive', archiveP, SQL.insert(Schema.archivedMatches).values(archiveP))
	export const deleteEventsOfMatch = SQL.def('deleteEventsOfMatch', matchIdP, SQL.delete(se).where(E.eq(se.matchId, matchIdP.matchId)))
	const matchIdsP = SQL.params({ ids: SQL.list(se.matchId) })
	export const hotEventsOfMatches = SQL.def(
		'hotEventsOfMatches',
		matchIdsP,
		SQL.select().from(se).where(SQL.inJson(se.matchId, matchIdsP.ids)).orderBy(E.asc(se.id)),
	)
	export const archivesOfMatches = SQL.def(
		'archivesOfMatches',
		matchIdsP,
		SQL.select().from(Schema.archivedMatches).where(SQL.inJson(Schema.archivedMatches.matchId, matchIdsP.ids)),
	)
}

/**
 * Packs the server events of matches that have left the recent window into one compressed row each, and
 * deletes the rows they came from.
 *
 * The archive is the source of truth for a compacted match: `loadMatchEvents` reads back exactly the rows
 * that went in, so no caller can tell the difference. What survives compaction relationally is the part
 * searches run on -- serverEventIndex for each event, playerEventIndex for the player dimension, matchHistory
 * for the layer dimension -- and all are written when the event is recorded, not here.
 */
export const compactAgedMatches = Instr.spanOp(
	'compactAgedMatches',
	{ module },
	async (ctx: C.Db & CS.AbortSignal, opts: { window: number; minHotMatches: number }) => {
		const cutoff = Date.now() - opts.window
		const servers = DB.all(ctx, Q.serverIds({}))

		let matches = 0
		let events = 0
		let rawBytes = 0
		let packedBytes = 0

		for (const { serverId } of servers) {
			ctx.signal.throwIfAborted()

			// the ordinal of the oldest match kept hot regardless of age. absent while the server is still
			// inside its first minHotMatches, in which case nothing on it can be compacted yet.
			const floor = hotFloorOrdinal(ctx, serverId, opts.minHotMatches)
			if (floor === undefined) continue

			const toCompact = DB.all(ctx, Q.candidates({ serverId, floor, cutoff }))

			for (const { id: matchId } of toCompact) {
				ctx.signal.throwIfAborted()

				const rows = DB.all(ctx, Q.storedEventsOfMatch({ matchId }))
				if (rows.length === 0) continue
				const invalid = rows.find((row) => row.valid !== 1)
				if (invalid) throw new Error(`server event ${invalid.id} of match ${matchId} does not hold valid json`)

				// packed before the transaction opens: zlib runs on the threadpool, and a transaction may not await
				const blob = await EA.pack(rows)

				DB.transaction(ctx, {}, (ctx) => {
					DB.run(
						ctx,
						Q.insertArchive({
							matchId,
							serverId,
							eventCount: rows.length,
							minEventId: rows[0].id,
							maxEventId: rows[rows.length - 1].id,
							encoding: EA.ENCODING,
							events: blob,
							createdAt: new Date(),
						}),
					)
					DB.run(ctx, Q.deleteEventsOfMatch({ matchId }))
				})

				matches++
				events += rows.length
				for (const row of rows) rawBytes += row.data.length
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

		const hotRows = DB.all(ctx, Q.hotEventsOfMatches({ ids: matchIds }))
		for (const row of hotRows) byMatch.get(row.matchId)?.push(row)

		// compaction inserts the archive row and deletes the hot rows in one transaction, so a match is in
		// exactly one of the two. Reading both and preferring the hot rows costs one indexed lookup and means
		// a half-applied state (which only a corrupted db could produce) reads as the un-compacted match.
		const archivedIds = matchIds.filter((id) => byMatch.get(id)!.length === 0)
		if (archivedIds.length > 0) {
			const archived = DB.all(ctx, Q.archivesOfMatches({ ids: archivedIds }))
			for (const row of archived) {
				byMatch.set(row.matchId, await EA.unpack(row.matchId, row.encoding, row.events as Buffer))
			}
		}

		return byMatch
	},
)
