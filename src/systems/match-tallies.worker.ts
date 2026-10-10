import DatabaseConstructor from 'better-sqlite3'
import * as E from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { parentPort, workerData } from 'node:worker_threads'

import type * as CHAT from '@/models/chat.models'
import * as CS from '@/models/context-shared.models'
import * as MH from '@/models/match-history.models'
import * as Pop from '@/models/population.models'
import * as Env from '@/server/env'
import { ensureLoggerSetup, initModule } from '@/server/logger'
import * as LayerData from '@/systems/layer-data.server'
import * as MatchEventsCache from '@/systems/match-events-cache.server'
import { mh, mp, pendingColumns, pendingTalliesCond } from '@/systems/match-tallies.shared'

// Tallying a match -- its scoreline and its population samples -- means replaying its whole feed against the roster
// it happened to, which is the only way a kill names a team. That is tens of thousands of synchronous iterations per
// match plus a zstd decompress for an archived one -- and on a server with years of history there are tens of
// thousands of matches to get through. On the main thread that would be sitting on the rcon and websocket loop for hours,
// so it runs here, on the same reasoning (and the same shape) as the history query engine.
//
// One replay serves both tallies, so a match owing either costs one replay. This thread only reads and computes.
// The main thread writes the results, so the app keeps one writer and this connection stays read-only.

export type Request = { seq: number; req: EngineRequest }
export type Response = { seq: number; res?: EngineResponse; err?: { message: string; stack?: string } }

export type EngineRequest = {
	serverId: string
	// the interpolation config the live feed replays with, and must be, or this reading of a match disagrees
	// with the one the activity panel shows (see getEnrichedEventsForMatches)
	opts: CHAT.InterpolationOptions
	limit: number
	// matches this caller has already been told it cannot tally, so the worklist stops handing them back
	skip: number[]
}

// a match's tallies, each present only when the match was owed it
export type Tally = { matchId: number; stats?: MH.MatchCombatStats; population?: Pop.Samples }

export type EngineResponse = {
	tallies: Tally[]
	// matches whose events would not read. Reported so the caller can stop asking for them, rather than the
	// worklist handing back the same unreadable match every round.
	failed: number[]
}

/** The next matches to tally, newest first, so the page the history panel is showing fills in before the rest. */
async function pendingMatches(ctx: C, req: EngineRequest) {
	return await ctx
		.db()
		.select(pendingColumns)
		.from(mh)
		.leftJoin(mp, E.eq(mp.matchId, mh.id))
		.where(pendingTalliesCond(req.serverId, req.skip))
		.orderBy(E.desc(mh.ordinal))
		.limit(req.limit)
}

export async function runEngineRequest(ctx: C, req: EngineRequest): Promise<EngineResponse> {
	const pending = await pendingMatches(ctx, req)
	const tallies: EngineResponse['tallies'] = []
	const failed: number[] = []
	// One match at a time, so neither a corrupt archive blob nor a match's memory footprint is charged to the
	// rest of the batch: an enriched feed embeds a player per event, and a busy match is most of a round's cost.
	for (const match of pending) {
		try {
			const events = (await MatchEventsCache.readMatchFeeds(ctx, [match.id])).get(match.id) ?? []
			const enriched = MatchEventsCache.enrichMatchFeed(events, req.opts)
			tallies.push({
				matchId: match.id,
				stats: match.needsScoreline ? MH.tallyCombatStats(enriched) : undefined,
				population: match.needsPopulation ? Pop.sampleMatch(enriched) : undefined,
			})
		} catch (err) {
			ctx.log.error(err, 'could not tally match %d', match.id)
			failed.push(match.id)
		}
	}
	return { tallies, failed }
}

// -------- the thread --------

const { dbPath } = workerData as { dbPath: string }

// A worker gets its own module instances, so the env and the logger are unbuilt here however far along the
// main thread is. Both are needed: the feed read logs through the ctx this thread hands it, and the logger
// reads NODE_ENV to pick its format.
Env.ensureEnvSetup()
ensureLoggerSetup()

const driver = new DatabaseConstructor(dbPath, { readonly: true })
driver.pragma('busy_timeout = 5000')
driver.pragma(`mmap_size = ${256 * 1024 * 1024}`)
const db = drizzle(driver)

// bound to the same module name the main thread's half logs under, so a failed tally reads as one thing
const ctx = { ...CS.init(), db: () => db, log: initModule('match-tallies').getLogger(), signal: new AbortController().signal }
type C = typeof ctx

// A feed carries layer ids (NEW_GAME names the layer that started), and parsing one indexes into the layer
// components. Not the layer engine's wasm artifact, which stays on the main thread: nothing here queries layers.
const componentsLoaded = LayerData.loadComponents()

parentPort!.on('message', ({ seq, req }: Request) => {
	void (async (): Promise<Response> => {
		try {
			await componentsLoaded
			return { seq, res: await runEngineRequest(ctx, req) }
		} catch (err) {
			const e = err instanceof Error ? { message: err.message, stack: err.stack } : { message: String(err) }
			return { seq, err: e }
		}
	})().then((msg) => parentPort!.postMessage(msg))
})
