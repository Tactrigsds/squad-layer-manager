import DatabaseConstructor from 'better-sqlite3'
import * as E from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { parentPort, workerData } from 'node:worker_threads'

import type * as CHAT from '@/models/chat.models'
import * as CS from '@/models/context-shared'
import * as MH from '@/models/match-history.models'
import * as Env from '@/server/env'
import { ensureLoggerSetup, initModule } from '@/server/logger'
import { mh, pendingCombatStatsCond } from '@/systems/combat-stats.shared'
import * as LayerData from '@/systems/layer-data.server'
import * as MatchEventsCache from '@/systems/match-events-cache.server'

// Tallying a match's scoreline means replaying its whole feed against the roster it happened to, which is the
// only way a kill names a team. That is tens of thousands of synchronous iterations per match plus a zstd
// decompress for an archived one -- and on a server with years of history there are tens of thousands of
// matches to get through. On the main thread that would be sitting on the rcon and websocket loop for hours,
// so it runs here, on the same reasoning (and the same shape) as the history query engine.
//
// This thread only reads and computes. The main thread writes the columns, so the app keeps one writer and
// this connection stays read-only.

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

export type EngineResponse = {
	tallies: { matchId: number; stats: MH.MatchCombatStats }[]
	// matches whose events would not read. Reported so the caller can stop asking for them, rather than the
	// worklist handing back the same unreadable match every round.
	failed: number[]
}

/** The next matches to tally, newest first, so the page the history panel is showing fills in before the rest. */
async function pendingMatches(ctx: C, req: EngineRequest): Promise<number[]> {
	const rows = await ctx
		.db()
		.select({ id: mh.id })
		.from(mh)
		.where(pendingCombatStatsCond(req.serverId, req.skip))
		.orderBy(E.desc(mh.ordinal))
		.limit(req.limit)
	return rows.map((r) => r.id)
}

export async function runEngineRequest(ctx: C, req: EngineRequest): Promise<EngineResponse> {
	const matchIds = await pendingMatches(ctx, req)
	const tallies: EngineResponse['tallies'] = []
	const failed: number[] = []
	// One match at a time, so neither a corrupt archive blob nor a match's memory footprint is charged to the
	// rest of the batch: an enriched feed embeds a player per event, and a busy match is most of a round's cost.
	for (const matchId of matchIds) {
		try {
			const events = (await MatchEventsCache.readMatchFeeds(ctx, [matchId])).get(matchId) ?? []
			tallies.push({ matchId, stats: MH.tallyCombatStats(MatchEventsCache.enrichMatchFeed(events, req.opts)) })
		} catch (err) {
			ctx.log.error(err, 'could not tally the scoreline of match %d', matchId)
			failed.push(matchId)
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
const db = drizzle(driver)

// bound to the same module name the main thread's half logs under, so a failed tally reads as one thing
const ctx = { ...CS.init(), db: () => db, log: initModule('combat-stats').getLogger(), signal: new AbortController().signal }
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
