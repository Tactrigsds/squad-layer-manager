import DatabaseConstructor from 'better-sqlite3'
import * as E from 'drizzle-orm'
import { sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import * as Timers from 'node:timers/promises'
import { parentPort, workerData } from 'node:worker_threads'

import * as Schema from '$root/drizzle/schema'
import type * as SchemaModels from '$root/drizzle/schema.models'
import { assertNever } from '@/lib/type-guards'
import * as CHAT from '@/models/chat.models'
import * as CS from '@/models/context-shared.models'
import type * as HQ from '@/models/history.models'
import type * as C from '@/server/context'
import * as Env from '@/server/env'
import { ensureLoggerSetup, initModule } from '@/server/logger'
import {
	ae,
	aea,
	appEventBoundsCond,
	compileAppEventCond,
	compileEventCond,
	COMBAT_EXPRS,
	compileMatchCond,
	durationOf,
	eventBoundsCond,
	type EventTable,
	GAME_PARTICIPANT,
	inJsonSet,
	matchBoundsCond,
	matchTime,
	type Bounds,
	type QueryError,
	type ResolvedArtifacts,
	resolveArtifacts,
	resolveNamedPlayerIds,
	resolvePlayerRefs,
	sei,
	soleEventPlayer,
	ticketDiffOf,
} from '@/systems/history-query.shared'
import * as LayerData from '@/systems/layer-data.server'
import * as MatchEventsCache from '@/systems/match-events-cache.server'

// The history query engine, on its own thread so a heavy scan never stalls the main event loop (which is also
// the rcon and websocket loop; better-sqlite3 is synchronous). It opens its own read-only connection: WAL lets
// readers run beside the main connection's writes.
//
// This file owns query execution -- everything below the conditions history-query.shared.ts compiles -- because
// nothing on the main thread runs a history query. There is no in-process fallback: a query with no worker to
// run it fails, rather than quietly moving the scan onto the loop the worker exists to protect.

const pei = Schema.playerEventIndex
const mh = Schema.matchHistory

// One hit: which event, in which match, when. Exactly one of the two ids is set -- the families are indexed
// separately (serverEventIndex vs appEvents) and their ids are not even the same type.
export type EventHit = { matchId: number; time: Date } & (
	| { serverEventId: number; appEventId?: undefined }
	| { appEventId: string; serverEventId?: undefined }
)

// The page cursor is a position in the merge, so it names which family it sits in.
export type EventCursor = { time: number; serverEventId?: number; appEventId?: string }

// Newest first is the default. Oldest first is the exact reverse of that sequence rather than an order of
// its own -- so within a millisecond app events come first and ids ascend -- which is what lets every cursor
// comparison below be the mirror of its counterpart instead of a second set of rules.
export type EventOrder = 'newest' | 'oldest'

// The total order the two sources merge into: newest first, server events before app events within a
// millisecond, then descending id. Arbitrary but total, which is all a cursor needs.
function hitRank(hit: { serverEventId?: number }): number {
	return hit.serverEventId !== undefined ? 0 : 1
}

function compareHits(a: EventHit, b: EventHit): number {
	const byTime = b.time.getTime() - a.time.getTime()
	if (byTime !== 0) return byTime
	const byRank = hitRank(a) - hitRank(b)
	if (byRank !== 0) return byRank
	if (a.serverEventId !== undefined && b.serverEventId !== undefined) return b.serverEventId - a.serverEventId
	return (b.appEventId ?? '').localeCompare(a.appEventId ?? '')
}

function comparator(order: EventOrder) {
	return order === 'newest' ? compareHits : (a: EventHit, b: EventHit) => -compareHits(a, b)
}

/**
 * One page of hits, merged from both event families.
 *
 * Each source is asked for a full page and the two are merged, so the page is correct however lopsided the
 * split: a page can legitimately be all server events or all app events. Both read a page's worth even when
 * one contributes nothing, which is the cost of the merge and is bounded by the page size.
 */
export async function queryEventHits(ctx: C.Db & CS.AbortSignal, opts: EventPageOpts): Promise<EventHit[]> {
	const [serverHits, appHits] = await Promise.all([queryServerEventHits(ctx, opts), queryAppEventHits(ctx, opts)])
	return [...serverHits, ...appHits].sort(comparator(opts.order)).slice(0, opts.pageSize)
}

type EventQueryOpts = { node: HQ.Node; art: ResolvedArtifacts; bounds: Bounds }
type EventPageOpts = EventQueryOpts & { cursor?: EventCursor; pageSize: number; order: EventOrder }

// Newest first, a cursor sitting on an app event has already passed every server event of that millisecond,
// since server events sort first within one. Oldest first reverses the sequence, so app events come first
// within a millisecond and none of that millisecond's server events are passed yet -- hence the inclusive
// bound on that side.
function serverCursorCond(t: EventTable, cursor: EventCursor | undefined, order: EventOrder): E.SQL | undefined {
	if (cursor === undefined) return undefined
	const newest = order === 'newest'
	if (cursor.serverEventId === undefined) return newest ? sql`${t.time} < ${cursor.time}` : sql`${t.time} >= ${cursor.time}`
	return newest
		? sql`(${t.time} < ${cursor.time} OR (${t.time} = ${cursor.time} AND ${t.serverEventId} < ${cursor.serverEventId}))`
		: sql`(${t.time} > ${cursor.time} OR (${t.time} = ${cursor.time} AND ${t.serverEventId} > ${cursor.serverEventId}))`
}

function serverOrder(t: EventTable, order: EventOrder) {
	return order === 'newest' ? [E.desc(t.time), E.desc(t.serverEventId)] : [E.asc(t.time), E.asc(t.serverEventId)]
}

type SoleEventPlayer = NonNullable<ReturnType<typeof soleEventPlayer>>

// One player's events walk that player's playerEventIndex range, which is already in page order, joining each
// row to its event. The general form would materialize and sort the player's whole history for every page
// (44ms against 0.2ms for a player with 51k events). Grouped because one event can name a player twice, as
// both ends of a suicide.
function playerEventHits(ctx: C.Db, opts: EventQueryOpts, sole: SoleEventPlayer, cursor: E.SQL | undefined) {
	return ctx
		.db()
		.select({ serverEventId: sei.serverEventId, matchId: sei.matchId, time: sei.time })
		.from(pei)
		.innerJoin(sei, E.eq(sei.serverEventId, pei.serverEventId))
		.where(
			E.and(
				E.eq(pei.playerId, sole.playerId),
				sole.assoc,
				eventBoundsCond(opts.bounds, pei),
				compileEventCond(sole.rest, opts.art),
				cursor,
			),
		)
		.groupBy(pei.time, pei.serverEventId)
}

async function queryServerEventHits(ctx: C.Db & CS.AbortSignal, opts: EventPageOpts): Promise<EventHit[]> {
	const sole = soleEventPlayer(opts.node, opts.art)
	if (sole) {
		return await playerEventHits(ctx, opts, sole, serverCursorCond(pei, opts.cursor, opts.order))
			.orderBy(...serverOrder(pei, opts.order))
			.limit(opts.pageSize)
	}
	return await ctx
		.db()
		.select({ serverEventId: sei.serverEventId, matchId: sei.matchId, time: sei.time })
		.from(sei)
		.where(E.and(eventBoundsCond(opts.bounds), compileEventCond(opts.node, opts.art), serverCursorCond(sei, opts.cursor, opts.order)))
		.orderBy(...serverOrder(sei, opts.order))
		.limit(opts.pageSize)
}

async function queryAppEventHits(ctx: C.Db & CS.AbortSignal, opts: EventPageOpts): Promise<EventHit[]> {
	const cursor = opts.cursor
	const newest = opts.order === 'newest'
	const rows = await ctx
		.db()
		.select({ appEventId: ae.id, matchId: ae.matchId, time: ae.time })
		.from(ae)
		.where(
			E.and(
				appEventBoundsCond(opts.bounds),
				compileAppEventCond(opts.node, opts.art),
				// the mirror of the server side, in both directions
				cursor === undefined
					? undefined
					: cursor.appEventId === undefined
						? newest
							? sql`${ae.time} <= ${cursor.time}`
							: sql`${ae.time} > ${cursor.time}`
						: newest
							? sql`(${ae.time} < ${cursor.time} OR (${ae.time} = ${cursor.time} AND ${ae.id} < ${cursor.appEventId}))`
							: sql`(${ae.time} > ${cursor.time} OR (${ae.time} = ${cursor.time} AND ${ae.id} > ${cursor.appEventId}))`,
			),
		)
		.orderBy(...(newest ? [E.desc(ae.time), E.desc(ae.id)] : [E.asc(ae.time), E.asc(ae.id)]))
		.limit(opts.pageSize)
	// appEventBoundsCond keeps only rows with a match, so the null is unreachable; narrowing rather than casting
	return rows.flatMap((r) => (r.matchId === null ? [] : [{ appEventId: r.appEventId, matchId: r.matchId, time: r.time }]))
}

/**
 * How many events the query matches, per player or per match, for the rows of one page.
 *
 * Both families, because that is what the expanded list shows: a count that disagreed with the list it opens
 * would be worse than no count at all. One grouped query per family over the page's keys, rather than a
 * correlated subquery per row.
 */
async function eventCountsFor(
	ctx: C.Db & CS.AbortSignal,
	opts: { node: HQ.Node; art: ResolvedArtifacts; bounds: Bounds },
	dimension: 'player' | 'match',
	keys: (string | number)[],
): Promise<Record<string, number>> {
	const counts: Record<string, number> = {}
	if (keys.length === 0) return counts

	// a player's events are the ones playerEventIndex names them in, and it has a row per player to group on
	const serverRows =
		dimension === 'player'
			? await ctx
					.db()
					.select({ key: pei.playerId, n: sql<number>`count(DISTINCT ${pei.serverEventId})` })
					.from(pei)
					.where(
						E.and(
							inJsonSet(pei.playerId, keys),
							E.ne(pei.assocType, GAME_PARTICIPANT),
							eventBoundsCond(opts.bounds, pei),
							compileEventCond(opts.node, opts.art, pei),
						),
					)
					.groupBy(pei.playerId)
			: await ctx
					.db()
					.select({ key: sei.matchId, n: sql<number>`count(*)` })
					.from(sei)
					.where(E.and(inJsonSet(sei.matchId, keys), eventBoundsCond(opts.bounds), compileEventCond(opts.node, opts.art)))
					.groupBy(sei.matchId)
	for (const row of serverRows) counts[String(row.key)] = (counts[String(row.key)] ?? 0) + row.n

	const appCond = E.and(appEventBoundsCond(opts.bounds), compileAppEventCond(opts.node, opts.art))
	if (dimension === 'match') {
		const appRows = await ctx
			.db()
			.select({ key: ae.matchId, n: sql<number>`count(DISTINCT ${ae.id})` })
			.from(ae)
			.where(E.and(inJsonSet(ae.matchId, keys), appCond))
			.groupBy(ae.matchId)
		for (const row of appRows) counts[String(row.key)] = (counts[String(row.key)] ?? 0) + row.n
		return counts
	}

	// a player's app events are the ones the association sidecar attributes to them, which is the same
	// dimension the `player` column compiles against
	const appRows = await ctx
		.db()
		.select({ key: aea.value, n: sql<number>`count(DISTINCT ${ae.id})` })
		.from(aea)
		.innerJoin(ae, E.eq(ae.id, aea.appEventId))
		.where(E.and(E.eq(aea.dimension, 'player'), inJsonSet(aea.value, keys), appCond))
		.groupBy(aea.value)
	for (const row of appRows) counts[row.key] = (counts[row.key] ?? 0) + row.n
	return counts
}

export async function queryPlayerRows(
	ctx: C.Db & CS.AbortSignal,
	opts: {
		node: HQ.Node
		art: ResolvedArtifacts
		bounds: Bounds
		groupPlayerIds?: string[]
		minMatches?: number
		sort: { column: HQ.PlayerSortColumn; dir: 'asc' | 'desc' }
		limit: number
		offset: number
	},
): Promise<{ rows: HQ.PlayerRow[]; total: number }> {
	const cond = E.and(
		opts.groupPlayerIds ? inJsonSet(pei.playerId, opts.groupPlayerIds) : undefined,
		eventBoundsCond(opts.bounds, pei),
		compileEventCond(opts.node, opts.art, pei),
	)
	const aggregates = {
		playerId: pei.playerId,
		matches: sql<number>`count(DISTINCT ${pei.matchId})`,
		kills: sql<number>`sum(${pei.type} = 'PLAYER_DIED' AND ${pei.assocType} = 'attacker' AND ${pei.variant} = 'normal')`,
		deaths: sql<number>`sum(${pei.type} = 'PLAYER_DIED' AND ${pei.assocType} = 'victim')`,
		teamkills: sql<number>`sum(${pei.type} = 'PLAYER_DIED' AND ${pei.assocType} = 'attacker' AND ${pei.variant} = 'teamkill')`,
		chatMessages: sql<number>`sum(${pei.type} = 'CHAT_MESSAGE')`,
		lastSeen: sql<number>`max(${pei.time})`,
		total: sql<number>`count(*) OVER ()`,
	}
	const sortCol = aggregates[opts.sort.column]
	const rows = await ctx
		.db()
		.select(aggregates)
		.from(pei)
		.where(cond)
		.groupBy(pei.playerId)
		.having(opts.minMatches ? sql`count(DISTINCT ${pei.matchId}) >= ${opts.minMatches}` : undefined)
		.orderBy(opts.sort.dir === 'asc' ? E.asc(sortCol) : E.desc(sortCol), E.asc(pei.playerId))
		.limit(opts.limit)
		.offset(opts.offset)

	const total = rows[0]?.total ?? 0
	if (rows.length === 0) return { rows: [], total }
	await yieldToCancel(ctx)

	const nameRows = await ctx
		.db()
		.select({ eosId: Schema.players.eosId, username: Schema.players.username, steamId: Schema.players.steamId })
		.from(Schema.players)
		.where(
			E.inArray(
				Schema.players.eosId,
				rows.map((r) => r.playerId),
			),
		)
	const names = new Map(nameRows.map((r) => [r.eosId, r]))
	const events = await eventCountsFor(
		ctx,
		opts,
		'player',
		rows.map((r) => r.playerId),
	)

	return {
		total,
		rows: rows.map((r): HQ.PlayerRow => ({
			playerId: r.playerId,
			username: names.get(r.playerId)?.username ?? null,
			steamId: names.get(r.playerId)?.steamId?.toString() ?? null,
			matches: r.matches,
			kills: r.kills ?? 0,
			deaths: r.deaths ?? 0,
			teamkills: r.teamkills ?? 0,
			chatMessages: r.chatMessages ?? 0,
			lastSeen: r.lastSeen,
			events: events[r.playerId] ?? 0,
		})),
	}
}

// The same expressions the length and ticket-difference filters compile to, so ordering by a column and
// filtering on it cannot disagree.
const MATCH_SORT_EXPRS: Record<HQ.MatchSortColumn, E.SQL> = {
	time: matchTime,
	duration: durationOf(mh),
	ticketDiff: ticketDiffOf(mh),
	kills: COMBAT_EXPRS['match.kills'](mh),
	killDiff: COMBAT_EXPRS['match.killDiff'](mh),
}

export async function queryMatchRows(
	ctx: C.Db & CS.AbortSignal,
	opts: {
		node: HQ.Node
		art: ResolvedArtifacts
		bounds: Bounds
		sort: { column: HQ.MatchSortColumn; dir: HQ.SortDir }
		limit: number
		offset: number
	},
): Promise<{ rows: SchemaModels.MatchHistory[]; total: number; events: Record<string, number> }> {
	const cond = E.and(matchBoundsCond(opts.bounds), compileMatchCond(opts.node, opts.art, opts.bounds))
	const [{ count: total } = { count: 0 }] = await ctx.db().select({ count: E.count() }).from(mh).where(cond)
	await yieldToCancel(ctx)
	const sortExpr = MATCH_SORT_EXPRS[opts.sort.column]
	const rows = await ctx
		.db()
		.select()
		.from(mh)
		.where(cond)
		// nulls last in both directions: a match still running has neither a length nor a ticket difference,
		// and a page of blanks is not what "shortest first" was asking for
		.orderBy(sql`${sortExpr} IS NULL`, opts.sort.dir === 'asc' ? E.asc(sortExpr) : E.desc(sortExpr), E.desc(mh.id))
		.limit(opts.limit)
		.offset(opts.offset)
	const events = await eventCountsFor(
		ctx,
		opts,
		'match',
		rows.map((r) => r.id),
	)
	return { rows, total, events }
}

// -------- event bodies --------

// Enriched feeds of finished matches, held across requests: paging, a selection's page loop and the player
// window keep coming back to the same matches, and replaying one costs 20-50ms. Bounded by events rather than
// matches, since one match can be a hundred times the size of another. The match a server is still playing is
// never held, since its feed grows as it plays.
const FEED_CACHE_MAX_EVENTS = 100_000
const feedCache = new Map<number, CHAT.EventEnriched[]>()
let feedCacheEvents = 0
// the interpolation config the held feeds were replayed with. A different one makes all of them stale.
let feedCacheOptsKey: string | undefined

function cachedFeed(matchId: number): CHAT.EventEnriched[] | undefined {
	const feed = feedCache.get(matchId)
	if (feed) {
		feedCache.delete(matchId)
		feedCache.set(matchId, feed)
	}
	return feed
}

function cacheFeed(matchId: number, feed: CHAT.EventEnriched[]) {
	if (feed.length > FEED_CACHE_MAX_EVENTS) return
	feedCache.set(matchId, feed)
	feedCacheEvents += feed.length
	for (const [id, held] of feedCache) {
		if (feedCacheEvents <= FEED_CACHE_MAX_EVENTS) break
		feedCache.delete(id)
		feedCacheEvents -= held.length
	}
}

// uncached matches read and replayed together, so a page spanning a hundred matches never holds all of their
// rows at once, and a cancel can land between batches
const FEED_READ_BATCH = 8

export type EventPage = { events: CHAT.Wire.Batch | null; matches: SchemaModels.MatchHistory[] }

/**
 * The enriched events behind one page of hits, in the order they were paged in, with the matches they belong to.
 *
 * Each match is replayed whole and then filtered to the page's hits, since a slice would replay against a partial
 * roster. The replay is the one every reader of a past match gets (see getEnrichedEventsForMatches), so `chat` has
 * to be the config the live feed replays with.
 */
async function loadEventPage(
	ctx: C.Db & CS.Log & CS.AbortSignal,
	hits: EventHit[],
	opts: { chat: CHAT.InterpolationOptions; includeMatchBoundaries: boolean; order: EventOrder },
): Promise<EventPage> {
	if (hits.length === 0) return { events: null, matches: [] }
	const matchIds = [...new Set(hits.map((h) => h.matchId))]
	const matchRows = await ctx.db().select().from(mh).where(E.inArray(mh.id, matchIds))

	const optsKey = JSON.stringify(opts.chat)
	if (optsKey !== feedCacheOptsKey) {
		feedCache.clear()
		feedCacheEvents = 0
		feedCacheOptsKey = optsKey
	}

	const byServer = new Map<string, SchemaModels.MatchHistory[]>()
	for (const row of matchRows) {
		let rows = byServer.get(row.serverId)
		if (!rows) byServer.set(row.serverId, (rows = []))
		rows.push(row)
	}
	const newestRows = await ctx
		.db()
		.select({ serverId: mh.serverId, ordinal: sql<number>`max(${mh.ordinal})` })
		.from(mh)
		.where(E.inArray(mh.serverId, [...byServer.keys()]))
		.groupBy(mh.serverId)
	const newestOrdinal = new Map(newestRows.map((r) => [r.serverId, r.ordinal]))

	// hits from either family; a replayed entry is kept when it stands for one of them (see iterContainedEventIds)
	const wanted = new Set<number>(hits.flatMap((h) => (h.serverEventId === undefined ? [] : [h.serverEventId])))
	const wantedAppEvents = new Set<string>(hits.flatMap((h) => (h.appEventId === undefined ? [] : [h.appEventId])))
	// by containment, not by id: a hit whose event replay folded into another entry -- a warn collapsed under the
	// app event that issued it, one of a burst merged into a WARNS_AGGREGATED -- is shown by that entry, and
	// matching on the top-level id alone would drop it from the page
	const isHit = (e: CHAT.EventEnriched) => {
		if (opts.includeMatchBoundaries && e.type === 'NEW_GAME') return true
		if (typeof e.id === 'string' && wantedAppEvents.has(e.id)) return true
		for (const id of CHAT.iterContainedEventIds(e)) {
			if (wanted.has(id)) return true
		}
		return false
	}

	// servers in the order their matches came back, each one's matches ascending: the order that events of the
	// same millisecond keep through the sort below
	const ordered: SchemaModels.MatchHistory[] = []
	for (const rows of byServer.values()) ordered.push(...rows.toSorted((a, b) => a.id - b.id))

	const kept = new Map<number, CHAT.EventEnriched[]>()
	const uncached: SchemaModels.MatchHistory[] = []
	for (const row of ordered) {
		const feed = cachedFeed(row.id)
		if (feed) kept.set(row.id, feed.filter(isHit))
		else uncached.push(row)
	}
	for (let i = 0; i < uncached.length; i += FEED_READ_BATCH) {
		await yieldToCancel(ctx)
		const batch = uncached.slice(i, i + FEED_READ_BATCH)
		const feeds = await MatchEventsCache.readMatchFeeds(
			ctx,
			batch.map((row) => row.id),
		)
		for (const row of batch) {
			const feed = MatchEventsCache.enrichMatchFeed(feeds.get(row.id) ?? [], opts.chat)
			if (row.ordinal < (newestOrdinal.get(row.serverId) ?? row.ordinal)) cacheFeed(row.id, feed)
			kept.set(row.id, feed.filter(isHit))
		}
	}

	const events = ordered.flatMap((row) => kept.get(row.id) ?? [])
	// the same direction the hits were paged in, so each further page stacks on in reading order
	events.sort((a, b) => (opts.order === 'newest' ? b.time - a.time : a.time - b.time))
	const revived = await MatchEventsCache.reviveNoops(ctx, events, { keepSuppressed: true })
	return { events: revived.length > 0 ? CHAT.Wire.encode(revived) : null, matches: matchRows }
}

// -------- the engine entrypoint --------
// One request shape for all three result types. Everything in it survives structured clone: the tree is plain
// data (match-layer nodes were rewritten to match-ids before dispatch), and node-keyed artifact maps are rebuilt
// on the receiving side.

export type EngineRequest =
	| {
			kind: 'events'
			node: HQ.Node
			bounds: Bounds
			cursor?: EventCursor
			pageSize: number
			order: EventOrder
			// count is a second scan, so it is only asked for on the first page
			withTotal?: boolean
			// the interpolation config the live feed replays with (see loadEventPage)
			chat: CHAT.InterpolationOptions
			// keep the NEW_GAME of every match on the page, even though no filter selected it
			includeMatchBoundaries: boolean
	  }
	| {
			kind: 'players'
			node: HQ.Node
			bounds: Bounds
			// which player rows to show, as opposed to which events count (see HQ.groupPlayerRefs)
			group: { players?: string[]; name?: string }
			minMatches?: number
			sort: { column: HQ.PlayerSortColumn; dir: 'asc' | 'desc' }
			limit: number
			offset: number
	  }
	| {
			kind: 'matches'
			node: HQ.Node
			bounds: Bounds
			sort: { column: HQ.MatchSortColumn; dir: HQ.SortDir }
			limit: number
			offset: number
	  }

export type EngineResponse =
	| ({ code: 'ok'; kind: 'events'; hits: EventHit[]; total?: number; totalCapped: boolean } & EventPage)
	| { code: 'ok'; kind: 'players'; rows: HQ.PlayerRow[]; total: number }
	| { code: 'ok'; kind: 'matches'; rows: SchemaModels.MatchHistory[]; total: number; events: Record<string, number> }

// A full count reads every hit, so it grows with history (~200ms over 1M events), where a capped one stops at
// the cap (~8ms). Past the cap an exact number tells a reader nothing they can use.
export const EVENT_TOTAL_CAP = 10_000

async function countEventHits(ctx: C.Db & CS.AbortSignal, opts: EventQueryOpts): Promise<{ total: number; capped: boolean }> {
	const sole = soleEventPlayer(opts.node, opts.art)
	const serverHits = sole
		? playerEventHits(ctx, opts, sole, undefined).limit(EVENT_TOTAL_CAP + 1)
		: ctx
				.db()
				.select({ one: sql`1` })
				.from(sei)
				.where(E.and(eventBoundsCond(opts.bounds), compileEventCond(opts.node, opts.art)))
				.limit(EVENT_TOTAL_CAP + 1)
	const appHits = ctx
		.db()
		.select({ one: sql`1` })
		.from(ae)
		.where(E.and(appEventBoundsCond(opts.bounds), compileAppEventCond(opts.node, opts.art)))
		.limit(EVENT_TOTAL_CAP + 1)
	const [row] = await ctx
		.db()
		.select({ n: sql<number>`count(*)` })
		.from(serverHits.as('hits'))
	await yieldToCancel(ctx)
	const [appRow] = await ctx
		.db()
		.select({ n: sql<number>`count(*)` })
		.from(appHits.as('hits'))
	const n = (row?.n ?? 0) + (appRow?.n ?? 0)
	return { total: Math.min(n, EVENT_TOTAL_CAP), capped: n > EVENT_TOTAL_CAP }
}

export async function runEngineRequest(ctx: C.Db & CS.Log & CS.AbortSignal, req: EngineRequest): Promise<EngineResponse | QueryError> {
	const res = await resolveArtifacts(ctx, req.node, req.bounds)
	if (res.code !== 'ok') return res
	const art = res.artifacts
	switch (req.kind) {
		case 'events': {
			const opts = { node: req.node, art, bounds: req.bounds }
			const hits = await queryEventHits(ctx, { ...opts, cursor: req.cursor, pageSize: req.pageSize, order: req.order })
			await yieldToCancel(ctx)
			const counted = req.withTotal ? await countEventHits(ctx, opts) : undefined
			const page = await loadEventPage(ctx, hits, req)
			return { code: 'ok', kind: 'events', hits, total: counted?.total, totalCapped: counted?.capped ?? false, ...page }
		}
		case 'players': {
			let groupPlayerIds: string[] | undefined
			if (req.group.players?.length) groupPlayerIds = await resolvePlayerRefs(ctx, req.group.players)
			if (req.group.name) {
				const named = await resolveNamedPlayerIds(ctx, req.group.name)
				groupPlayerIds = groupPlayerIds ? groupPlayerIds.filter((id) => named.includes(id)) : named
			}
			const { rows, total } = await queryPlayerRows(ctx, {
				node: req.node,
				art,
				bounds: req.bounds,
				groupPlayerIds,
				minMatches: req.minMatches,
				sort: req.sort,
				limit: req.limit,
				offset: req.offset,
			})
			return { code: 'ok', kind: 'players', rows, total }
		}
		case 'matches': {
			const { rows, total, events } = await queryMatchRows(ctx, {
				node: req.node,
				art,
				bounds: req.bounds,
				sort: req.sort,
				limit: req.limit,
				offset: req.offset,
			})
			return { code: 'ok', kind: 'matches', rows, total, events }
		}
		default:
			assertNever(req)
	}
}

// -------- the thread --------

// A cancel names the seq of a request whose caller stopped waiting for it.
export type Request = { seq: number; req: EngineRequest } | { cancel: number }
export type Response = {
	seq: number
	res?: EngineResponse | QueryError
	err?: { message: string; stack?: string }
}

// better-sqlite3 is synchronous, so a posted cancel is only read once the event loop turns. Called between a
// request's phases, so an abandoned request stops at the next one.
async function yieldToCancel(ctx: CS.AbortSignal) {
	await Timers.setImmediate()
	ctx.signal.throwIfAborted()
}

const { dbPath } = workerData as { dbPath: string }

// A worker gets its own module instances, so the env and the logger are unbuilt here however far along the main
// thread is. Event bodies are read here, and that read logs through the ctx.
Env.ensureEnvSetup()
ensureLoggerSetup()

const driver = new DatabaseConstructor(dbPath, { readonly: true })
driver.pragma('busy_timeout = 5000')
driver.pragma(`mmap_size = ${256 * 1024 * 1024}`)
const db = drizzle(driver)

const baseCtx = { ...CS.init(), db: () => db, log: initModule('history').getLogger() }

// layer predicates read their parts out of the layer id, so this thread needs the components the
// abbreviations index into. Not the layer engine's wasm artifact, which stays on the main thread: a
// match-layer node is resolved to match ids before it is ever dispatched here.
const componentsLoaded = LayerData.loadComponents()

// One request at a time, in arrival order, so a cancel only ever has to stop the one running or drop one queued.
const queue: { seq: number; req: EngineRequest; abort: AbortController }[] = []
const live = new Map<number, AbortController>()
let draining = false

async function drain() {
	while (queue.length > 0) {
		const { seq, req, abort } = queue.shift()!
		const ctx = { ...baseCtx, signal: abort.signal }
		try {
			await componentsLoaded
			await yieldToCancel(ctx)
			parentPort!.postMessage({ seq, res: await runEngineRequest(ctx, req) } satisfies Response)
		} catch (err) {
			if (abort.signal.aborted) continue
			const e = err instanceof Error ? { message: err.message, stack: err.stack } : { message: String(err) }
			parentPort!.postMessage({ seq, err: e } satisfies Response)
		} finally {
			live.delete(seq)
		}
	}
	draining = false
}

parentPort!.on('message', (msg: Request) => {
	if ('cancel' in msg) {
		live.get(msg.cancel)?.abort()
		return
	}
	const abort = new AbortController()
	live.set(msg.seq, abort)
	queue.push({ seq: msg.seq, req: msg.req, abort })
	if (draining) return
	draining = true
	void drain()
})
