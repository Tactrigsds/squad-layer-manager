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

// The history query engine, on its own thread so a heavy scan never stalls the main event loop (which is also
// the rcon and websocket loop; better-sqlite3 is synchronous). It opens its own read-only connection: WAL lets
// readers run beside the main connection's writes.
//
// This file owns query execution -- everything below the conditions history-query.shared.ts compiles -- because
// nothing on the main thread runs a history query. There is no in-process fallback: a query with no worker to
// run it fails, rather than quietly moving the scan onto the loop the worker exists to protect.

const pei = Schema.playerEventIndex
const mh = Schema.matchHistory

// the one shape both engines share for the events hit list: which event, in which match, when
export type EventHit = { serverEventId: number; matchId: number; time: Date }

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

export async function queryEventHits(
	ctx: C.Db & CS.AbortSignal,
	opts: {
		node: HQ.Node
		art: ResolvedArtifacts
		bounds: Bounds
		cursor?: { time: number; serverEventId: number }
		pageSize: number
	},
): Promise<EventHit[]> {
	const anchor = playerAnchor(opts.node, opts.art)
	const cond = E.and(
		anchor ? (anchor.length === 1 ? E.eq(pei.playerId, anchor[0]) : inJsonSet(pei.playerId, anchor)) : undefined,
		E.ne(pei.assocType, GAME_PARTICIPANT),
		eventBoundsCond(opts.bounds),
		compileEventCond(opts.node, opts.art),
		opts.cursor
			? sql`(${pei.time} < ${opts.cursor.time} OR (${pei.time} = ${opts.cursor.time} AND ${pei.serverEventId} < ${opts.cursor.serverEventId}))`
			: undefined,
	)
	return await ctx
		.db()
		.select({ serverEventId: pei.serverEventId, matchId: pei.matchId, time: pei.time })
		.from(pei)
		.where(cond)
		.groupBy(pei.serverEventId)
		.orderBy(E.desc(pei.time), E.desc(pei.serverEventId))
		.limit(opts.pageSize)
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
			cursor?: { time: number; serverEventId: number }
			pageSize: number
			// count is a second full scan, so it is only asked for on the first page
			withTotal?: boolean
	  }
	| {
			kind: 'players'
			node: HQ.Node
			bounds: Bounds
			// which player rows to show, as opposed to which events count (see HQ.groupPlayerRefs)
			group: { player?: string; name?: string }
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
	return row?.n ?? 0
}

export async function runEngineRequest(ctx: C.Db & CS.AbortSignal, req: EngineRequest): Promise<EngineResponse | QueryError> {
	const res = await resolveArtifacts(ctx, req.node, req.bounds)
	if (res.code !== 'ok') return res
	const art = res.artifacts
	switch (req.kind) {
		case 'events': {
			const opts = { node: req.node, art, bounds: req.bounds }
			const hits = await queryEventHits(ctx, { ...opts, cursor: req.cursor, pageSize: req.pageSize })
			const total = req.withTotal ? await countEventHits(ctx, opts) : undefined
			return { code: 'ok', kind: 'events', hits, total }
		}
		case 'players': {
			let groupPlayerIds: string[] | undefined
			if (req.group.player) groupPlayerIds = await resolvePlayerRefs(ctx, [req.group.player])
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

parentPort!.on('message', ({ seq, req }: Request) => {
	void (async (): Promise<Response> => {
		try {
			return { seq, res: await runEngineRequest(ctx, req) }
		} catch (err) {
			const e = err instanceof Error ? { message: err.message, stack: err.stack } : { message: String(err) }
			return { seq, err: e }
		}
	})().then((msg) => parentPort!.postMessage(msg))
})
