import DatabaseConstructor from 'better-sqlite3'
import * as E from 'drizzle-orm'
import { sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { parentPort, workerData } from 'node:worker_threads'

import * as Schema from '$root/drizzle/schema'
import type * as SchemaModels from '$root/drizzle/schema.models'
import { assertNever } from '@/lib/type-guards'
import * as CS from '@/models/context-shared'
import * as F from '@/models/filter.models'
import * as HQ from '@/models/history.models'
import type * as C from '@/server/context'
import {
	ae,
	appEventBoundsCond,
	compileAppEventCond,
	compileEventCond,
	compileMatchCond,
	eventBoundsCond,
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
} from '@/systems/history-query.shared'
import * as LayerData from '@/systems/layer-data.server'

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
// separately (playerEventIndex vs appEvents) and their ids are not even the same type.
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

// A single positive player constraint under the root `and` also constrains which index rows can produce
// hits, so it is added as a direct pk condition. Purely an optimization: the subselect the comp compiled to
// stays, this just lets sqlite drive the scan off the pk instead of the whole index.
export function playerAnchor(root: HQ.Node, art: ResolvedArtifacts): string[] | undefined {
	if (!HQ.isBlockNode(root) || root.type !== 'and') return undefined
	for (const child of root.children) {
		if (!HQ.isCompNode(child)) continue
		const comp = child as F.CompNode
		if (comp.neg || F.compAnchorColumn(comp) !== 'player') continue
		const playerIds = art.playerValues.get(child)
		if (playerIds && playerIds.length > 0) return playerIds
	}
	return undefined
}

/**
 * One page of hits, merged from both event families.
 *
 * Each source is asked for a full page and the two are merged, so the page is correct however lopsided the
 * split: a page can legitimately be all server events or all app events. Both read a page's worth even when
 * one contributes nothing, which is the cost of the merge and is bounded by the page size.
 */
export async function queryEventHits(
	ctx: C.Db & CS.AbortSignal,
	opts: { node: HQ.Node; art: ResolvedArtifacts; bounds: Bounds; cursor?: EventCursor; pageSize: number; order: EventOrder },
): Promise<EventHit[]> {
	const [serverHits, appHits] = await Promise.all([queryServerEventHits(ctx, opts), queryAppEventHits(ctx, opts)])
	return [...serverHits, ...appHits].sort(comparator(opts.order)).slice(0, opts.pageSize)
}

async function queryServerEventHits(
	ctx: C.Db & CS.AbortSignal,
	opts: { node: HQ.Node; art: ResolvedArtifacts; bounds: Bounds; cursor?: EventCursor; pageSize: number; order: EventOrder },
): Promise<EventHit[]> {
	const anchor = playerAnchor(opts.node, opts.art)
	const cursor = opts.cursor
	const newest = opts.order === 'newest'
	const rows = await ctx
		.db()
		.select({ serverEventId: pei.serverEventId, matchId: pei.matchId, time: pei.time })
		.from(pei)
		.where(
			E.and(
				anchor ? (anchor.length === 1 ? E.eq(pei.playerId, anchor[0]) : inJsonSet(pei.playerId, anchor)) : undefined,
				E.ne(pei.assocType, GAME_PARTICIPANT),
				eventBoundsCond(opts.bounds),
				compileEventCond(opts.node, opts.art),
				// Newest first, a cursor sitting on an app event has already passed every server event of that
				// millisecond, since server events sort first within one. Oldest first reverses the sequence, so
				// app events come first within a millisecond and none of that millisecond's server events are
				// passed yet -- hence the inclusive bound on that side.
				cursor === undefined
					? undefined
					: cursor.serverEventId === undefined
						? newest
							? sql`${pei.time} < ${cursor.time}`
							: sql`${pei.time} >= ${cursor.time}`
						: newest
							? sql`(${pei.time} < ${cursor.time} OR (${pei.time} = ${cursor.time} AND ${pei.serverEventId} < ${cursor.serverEventId}))`
							: sql`(${pei.time} > ${cursor.time} OR (${pei.time} = ${cursor.time} AND ${pei.serverEventId} > ${cursor.serverEventId}))`,
			),
		)
		.groupBy(pei.serverEventId)
		.orderBy(...(newest ? [E.desc(pei.time), E.desc(pei.serverEventId)] : [E.asc(pei.time), E.asc(pei.serverEventId)]))
		.limit(opts.pageSize)
	return rows
}

async function queryAppEventHits(
	ctx: C.Db & CS.AbortSignal,
	opts: { node: HQ.Node; art: ResolvedArtifacts; bounds: Bounds; cursor?: EventCursor; pageSize: number; order: EventOrder },
): Promise<EventHit[]> {
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
		eventBoundsCond(opts.bounds),
		compileEventCond(opts.node, opts.art),
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
		})),
	}
}

export async function queryMatchRows(
	ctx: C.Db & CS.AbortSignal,
	opts: { node: HQ.Node; art: ResolvedArtifacts; bounds: Bounds; limit: number; offset: number },
): Promise<{ rows: SchemaModels.MatchHistory[]; total: number }> {
	const cond = E.and(matchBoundsCond(opts.bounds), compileMatchCond(opts.node, opts.art, opts.bounds))
	const [{ count: total } = { count: 0 }] = await ctx.db().select({ count: E.count() }).from(mh).where(cond)
	const rows = await ctx
		.db()
		.select()
		.from(mh)
		.where(cond)
		.orderBy(sql`${matchTime} DESC`, E.desc(mh.id))
		.limit(opts.limit)
		.offset(opts.offset)
	return { rows, total }
}

// -------- the engine entrypoint --------
// One request shape for all three result types, so the worker protocol and the in-process fallback are the
// same call. Everything in it survives structured clone: the tree is plain data (match-layer nodes were
// rewritten to match-ids before dispatch), and node-keyed artifact maps are rebuilt on the receiving side.

export type EngineRequest =
	| {
			kind: 'events'
			node: HQ.Node
			bounds: Bounds
			cursor?: EventCursor
			pageSize: number
			order: EventOrder
			// count is a second full scan, so it is only asked for on the first page
			withTotal?: boolean
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
	| { kind: 'matches'; node: HQ.Node; bounds: Bounds; limit: number; offset: number }

export type EngineResponse =
	| { code: 'ok'; kind: 'events'; hits: EventHit[]; total?: number }
	| { code: 'ok'; kind: 'players'; rows: HQ.PlayerRow[]; total: number }
	| { code: 'ok'; kind: 'matches'; rows: SchemaModels.MatchHistory[]; total: number }

async function countEventHits(
	ctx: C.Db & CS.AbortSignal,
	opts: { node: HQ.Node; art: ResolvedArtifacts; bounds: Bounds },
): Promise<number> {
	const cond = E.and(E.ne(pei.assocType, GAME_PARTICIPANT), eventBoundsCond(opts.bounds), compileEventCond(opts.node, opts.art))
	const [row] = await ctx
		.db()
		.select({ n: sql<number>`count(DISTINCT ${pei.serverEventId})` })
		.from(pei)
		.where(cond)
	const [appRow] = await ctx
		.db()
		.select({ n: sql<number>`count(*)` })
		.from(ae)
		.where(E.and(appEventBoundsCond(opts.bounds), compileAppEventCond(opts.node, opts.art)))
	return (row?.n ?? 0) + (appRow?.n ?? 0)
}

export async function runEngineRequest(ctx: C.Db & CS.AbortSignal, req: EngineRequest): Promise<EngineResponse | QueryError> {
	const res = await resolveArtifacts(ctx, req.node, req.bounds)
	if (res.code !== 'ok') return res
	const art = res.artifacts
	switch (req.kind) {
		case 'events': {
			const opts = { node: req.node, art, bounds: req.bounds }
			const hits = await queryEventHits(ctx, { ...opts, cursor: req.cursor, pageSize: req.pageSize, order: req.order })
			const total = req.withTotal ? await countEventHits(ctx, opts) : undefined
			return { code: 'ok', kind: 'events', hits, total }
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
			const { rows, total } = await queryMatchRows(ctx, {
				node: req.node,
				art,
				bounds: req.bounds,
				limit: req.limit,
				offset: req.offset,
			})
			return { code: 'ok', kind: 'matches', rows, total }
		}
		default:
			assertNever(req)
	}
}

// -------- the thread --------

export type Request = { seq: number; req: EngineRequest }
export type Response = {
	seq: number
	res?: EngineResponse | QueryError
	err?: { message: string; stack?: string }
}

const { dbPath } = workerData as { dbPath: string }

const driver = new DatabaseConstructor(dbPath, { readonly: true })
driver.pragma('busy_timeout = 5000')
const db = drizzle(driver)

const ctx = { ...CS.init(), db: () => db, signal: new AbortController().signal }

// layer predicates read their parts out of the layer id, so this thread needs the components the
// abbreviations index into. Not the layer engine's wasm artifact, which stays on the main thread: a
// match-layer node is resolved to match ids before it is ever dispatched here.
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
