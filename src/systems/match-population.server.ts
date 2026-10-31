import * as E from 'drizzle-orm'
import { promisify } from 'node:util'
import zlib from 'node:zlib'

import * as Schema from '$root/drizzle/schema'
import { LRUMap } from '@/lib/lru-map'
import type * as CS from '@/models/context-shared.models'
import * as L from '@/models/layer.models'
import * as Pop from '@/models/population.models'
import type * as C from '@/server/context'
import * as DB from '@/server/db'
import { initModule } from '@/server/logger'
import * as Sql from '@/server/sql'

// Stored population samples: written by the match-tallies catch-up, read back in ranges for the population chart.

const zstdCompress = promisify(zlib.zstdCompress)
const zstdDecompress = promisify(zlib.zstdDecompress)

const module = initModule('match-population')
const SQL = Sql.forModule(module)

const mh = Schema.matchHistory
const mp = Schema.matchPopulation

export async function store(ctx: C.Db & CS.AbortSignal, matchId: number, samples: Pop.Samples) {
	const blob = await zstdCompress(Buffer.from(JSON.stringify(samples), 'utf8'))
	DB.run(ctx, Q.upsertSamples({ matchId, samples: blob }))
	decoded.delete(matchId)
}

// A finished match's samples never change once stored, so a range refetched every minute decompresses each once.
// Sized for a week of matches on a few servers.
const decoded = new LRUMap<number, Pop.Samples>(1000)

async function decode(matchId: number, blob: Buffer): Promise<Pop.Samples> {
	let samples = decoded.get(matchId)
	if (!samples) {
		samples = JSON.parse((await zstdDecompress(blob)).toString('utf8')) as Pop.Samples
		decoded.set(matchId, samples)
	}
	return samples
}

// How far before a range a match with no end time may have started and still reach into it.
const MATCH_REACH_MS = 6 * 3_600_000
// How long a match's samples can run past its end time, through its post-game.
const POST_GAME_REACH_MS = 3_600_000

namespace Q {
	const storeP = SQL.params({ matchId: mp.matchId, samples: mp.samples })
	export const upsertSamples = SQL.def(
		'upsertSamples',
		storeP,
		SQL.insert(mp)
			.values({ matchId: storeP.matchId, version: SQL.lit(Pop.SAMPLER_VERSION), samples: storeP.samples })
			.onConflictDoUpdate({ target: mp.matchId, set: { version: SQL.lit(Pop.SAMPLER_VERSION), samples: storeP.samples } }),
	)
	const rangeP = SQL.params({ serverId: mh.serverId, startedSince: mh.startTime, endedSince: mh.endTime })
	export const matchesReaching = SQL.def(
		'matchesReaching',
		rangeP,
		SQL.select({
			id: mh.id,
			ordinal: mh.ordinal,
			layerId: mh.layerId,
			startTime: mh.startTime,
			createdAt: mh.createdAt,
			endTime: mh.endTime,
			version: mp.version,
			samples: mp.samples,
		})
			.from(mh)
			.leftJoin(mp, E.eq(mp.matchId, mh.id))
			.where(
				E.and(
					E.eq(mh.serverId, rangeP.serverId),
					E.or(
						E.gte(mh.endTime, rangeP.endedSince),
						E.and(
							E.isNull(mh.endTime),
							E.or(
								E.gte(mh.startTime, rangeP.startedSince),
								E.and(E.isNull(mh.startTime), E.gte(mh.createdAt, rangeP.startedSince)),
							),
						),
					),
				),
			)
			.orderBy(E.asc(mh.ordinal)),
	)
	const serverP = SQL.params({ serverId: mh.serverId })
	export const newestOrdinal = SQL.def(
		'newestOrdinal',
		serverP,
		SQL.select({ ordinal: E.max(mh.ordinal) })
			.from(mh)
			.where(E.eq(mh.serverId, serverP.serverId)),
	)
}

/** Every finished match on the server in `range` up to `now`, bucketed, with their bands. `cap` counts as full. */
export async function getRange(ctx: C.Db & CS.ServerId, range: Pop.Range, now: number, cap: number): Promise<Pop.RangeData> {
	const bucketMs = Pop.BUCKET_MS[range]
	const start = Math.floor((now - Pop.RANGE_MS[range]) / bucketMs) * bucketMs
	const rows = DB.all(
		ctx,
		Q.matchesReaching({
			serverId: ctx.serverId,
			startedSince: new Date(start - MATCH_REACH_MS),
			endedSince: new Date(start - POST_GAME_REACH_MS),
		}),
	)

	// the server's newest match is the current one, which the client draws from its live feed
	const newest = DB.get(ctx, Q.newestOrdinal({ serverId: ctx.serverId }))
	const finished = rows.filter((row) => row.ordinal < (newest?.ordinal ?? -1))
	// a match's last sample lands on the grid time after its last event, which for a match that just ended is still ahead
	const buckets = Pop.emptyBuckets(start, now + Pop.SAMPLE_STEP_MS, bucketMs)
	const bands: Pop.Band[] = []
	let pending = 0
	for (const row of finished) {
		const matchStart = (row.startTime ?? row.createdAt)?.getTime()
		if (matchStart === undefined) continue
		if (row.samples === null || row.version !== Pop.SAMPLER_VERSION) {
			if ((row.endTime?.getTime() ?? now) >= start) pending++
		} else {
			Pop.addToBuckets(buckets, await decode(row.id, row.samples), row.ordinal, cap)
		}
		bands.push({
			ordinal: row.ordinal,
			layerId: L.readStoredLayerId(row.layerId),
			start: matchStart,
			roundEnd: row.endTime?.getTime() ?? null,
		})
	}
	return { buckets, bands, pending }
}
