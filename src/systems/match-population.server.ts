import * as E from 'drizzle-orm'
import { promisify } from 'node:util'
import zlib from 'node:zlib'

import * as Schema from '$root/drizzle/schema'
import { LRUMap } from '@/lib/lru-map'
import type * as CS from '@/models/context-shared'
import * as Pop from '@/models/population.models'
import type * as C from '@/server/context'
import * as DB from '@/server/db'

// Stored population samples: written by the match-tallies catch-up, read back in ranges for the population chart.

const zstdCompress = promisify(zlib.zstdCompress)
const zstdDecompress = promisify(zlib.zstdDecompress)

const mh = Schema.matchHistory
const mp = Schema.matchPopulation

export async function store(ctx: C.Db & CS.AbortSignal, matchId: number, samples: Pop.Samples) {
	const blob = await zstdCompress(Buffer.from(JSON.stringify(samples), 'utf8'))
	await DB.runTransaction(ctx, async (ctx) => {
		await ctx
			.db()
			.insert(mp)
			.values({ matchId, version: Pop.SAMPLER_VERSION, samples: blob })
			.onConflictDoUpdate({ target: mp.matchId, set: { version: Pop.SAMPLER_VERSION, samples: blob } })
	})
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

/** Every finished match on the server in `range` up to `now`, bucketed, with their bands. `cap` counts as full. */
export async function getRange(ctx: C.Db & CS.ServerId, range: Pop.Range, now: number, cap: number): Promise<Pop.RangeData> {
	const bucketMs = Pop.BUCKET_MS[range]
	const start = Math.floor((now - Pop.RANGE_MS[range]) / bucketMs) * bucketMs
	// both columns hold ms since the epoch; a raw expression skips their Date mapping, so it binds a number
	const rows = await ctx
		.db()
		.select({
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
				E.eq(mh.serverId, ctx.serverId),
				E.sql`case when ${mh.endTime} is null
					then coalesce(${mh.startTime}, ${mh.createdAt}) >= ${start - MATCH_REACH_MS}
					else ${mh.endTime} >= ${start - POST_GAME_REACH_MS} end`,
			),
		)
		.orderBy(E.asc(mh.ordinal))

	// the server's newest match is the current one, which the client draws from its live feed
	const [newest] = await ctx
		.db()
		.select({ ordinal: E.max(mh.ordinal) })
		.from(mh)
		.where(E.eq(mh.serverId, ctx.serverId))
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
		bands.push({ ordinal: row.ordinal, layerId: row.layerId, start: matchStart, roundEnd: row.endTime?.getTime() ?? null })
	}
	return { buckets, bands, pending }
}
