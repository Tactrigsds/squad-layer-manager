import * as E from 'drizzle-orm'
import { sql } from 'drizzle-orm'

import * as Schema from '$root/drizzle/schema'
import * as SchemaModels from '$root/drizzle/schema.models'
import { assertNever } from '@/lib/type-guards'
import type * as CS from '@/models/context-shared'
import * as F from '@/models/filter.models'
import * as HQ from '@/models/history.models'
import * as SE from '@/models/server-events.models'
import type * as C from '@/server/context'

// Compiles a history query's node tree to sql. The whole vocabulary is projected -- playerEventIndex,
// chatSearch and matchHistory hold every filterable dimension -- so no query ever unpacks an archived match
// to decide membership; bodies are read only to display a page (history.server.ts) and by the retention
// sieve, which uses the in-memory evaluator at the bottom of this file.
//
// Semantics are per-event, not per-index-row: `and[player = X, player = Y]` matches an event involving both.
// Player-valued predicates therefore compile to serverEventId subselects rather than row conditions, since
// the player is the one dimension that varies between an event's index rows.

// caps on how many ids a resolved set may carry into an IN (via json_each, so these are memory caps, not
// sqlite variable limits)
const MAX_SUBQUERY_MATCHES = 100_000
const MAX_SUBQUERY_PLAYERS = 50_000
const MAX_NAME_MATCHES = 5_000
const MAX_SUBQUERY_DEPTH = 3

const pei = Schema.playerEventIndex
const mh = Schema.matchHistory

export type QueryError =
	| { code: 'err:invalid-query'; message: string }
	| { code: 'err:too-broad'; message: string }
	// a passthrough error from the layer query engine; every error code in the app follows the err: convention,
	// which is what lets `res.code !== 'ok'` narrow
	| { code: `err:${string}`; message?: string }

export type Bounds = {
	serverIds: string[] | undefined // undefined = all servers the user may view resolved upstream
	from?: number
	to?: number
	idMin?: number
	idMax?: number
}

export function boundsOf(query: HQ.Query, visibleServerIds: string[]): Bounds {
	const serverIds = query.server ? visibleServerIds.filter((id) => id === query.server) : visibleServerIds
	return { serverIds, from: query.from, to: query.to, idMin: query.idMin, idMax: query.idMax }
}

function inJsonSet(col: E.SQL | E.AnyColumn, ids: readonly (number | string)[]): E.SQL {
	return sql`${col} IN (SELECT value FROM json_each(${JSON.stringify(ids)}))`
}

// matches are dated like compaction dates them: end, else start, else first-seen
const matchTime = sql<number>`coalesce(${mh.endTime}, ${mh.startTime}, ${mh.createdAt})`

// -------- resolution --------
// Everything the sql can't say on its own, resolved once per query and keyed by node identity: layer
// filters against the played-layer set, subqueries to id sets, steam64s to eos ids, damage-source names to
// interned ids.

export type ResolvedArtifacts = {
	matchSets: Map<HQ.Node, number[]>
	playerSets: Map<HQ.Node, string[]>
	playerValues: Map<HQ.Node, string[]>
	damageSourceIds: Map<HQ.Node, number[]>
}

const STEAM64_RE = /^7656\d{13}$/
const EOS_ID_RE = /^[0-9a-f]{32}$/i

// a ref is an eos id, a steam64 to resolve to one, or anything else, which reads as a name substring
async function resolvePlayerRefs(ctx: C.Db, refs: string[]): Promise<string[]> {
	const eosIds: string[] = []
	const steam64s: bigint[] = []
	for (const ref of refs) {
		if (STEAM64_RE.test(ref)) steam64s.push(BigInt(ref))
		else if (EOS_ID_RE.test(ref)) eosIds.push(ref)
		else eosIds.push(...(await resolveNamedPlayerIds(ctx, ref)))
	}
	if (steam64s.length > 0) {
		const rows = await ctx
			.db()
			.select({ eosId: Schema.players.eosId })
			.from(Schema.players)
			.where(E.inArray(Schema.players.steamId, steam64s))
		eosIds.push(...rows.map((r) => r.eosId))
	}
	return eosIds
}

export async function resolveNamedPlayerIds(ctx: C.Db, name: string): Promise<string[]> {
	const trimmed = name.trim()
	if (trimmed === '') return []
	// the trigram index answers substring matches of three or more characters (see migration 0108); a
	// shorter needle falls back to scanning players, which is what every needle cost before the index
	if (trimmed.length >= 3) {
		const rows = ctx
			.db()
			.all<{ eosId: string }>(
				sql`SELECT eosId FROM usernameSearch WHERE usernameSearch MATCH ${`"${trimmed.replaceAll('"', '""')}"`} LIMIT ${MAX_NAME_MATCHES}`,
			)
		return rows.map((r) => r.eosId)
	}
	const needle = `%${trimmed.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`
	const rows = await ctx
		.db()
		.select({ eosId: Schema.players.eosId })
		.from(Schema.players)
		.where(
			E.or(sql`${Schema.players.username} LIKE ${needle} ESCAPE '\\'`, sql`${Schema.players.usernameNoTag} LIKE ${needle} ESCAPE '\\'`),
		)
		.limit(MAX_NAME_MATCHES)
	return rows.map((r) => r.eosId)
}

function compValueList(node: F.CompNode): F.Value[] {
	switch (node.type) {
		case 'eq':
		case 'lt':
		case 'gt': {
			const arg = node.args[1]
			return arg.type === 'value' ? [arg.value] : []
		}
		case 'in': {
			const arg = node.args[1]
			return (arg.values ?? []).filter((v) => !F.isColumnListItem(v)) as F.Value[]
		}
		case 'inrange':
			return node.args.slice(1).map((arg) => (arg.type === 'value' ? arg.value : null))
		default:
			assertNever(node)
	}
}

export async function resolveArtifacts(
	ctx: C.Db & CS.AbortSignal,
	root: HQ.Node,
	bounds: Bounds,
	depth = 0,
): Promise<{ code: 'ok'; artifacts: ResolvedArtifacts } | QueryError> {
	const artifacts: ResolvedArtifacts = {
		matchSets: new Map(),
		playerSets: new Map(),
		playerValues: new Map(),
		damageSourceIds: new Map(),
	}
	if (depth > MAX_SUBQUERY_DEPTH) return { code: 'err:invalid-query', message: 'sub-queries nested too deeply' }

	for (const node of HQ.walkNodes(root)) {
		if (node.type === 'match-layer') {
			// the engine may be running on a thread without the layer artifact; resolution happens before
			// dispatch (see history-resolve.server.ts), so an unresolved layer node here is a caller bug
			return { code: 'err:invalid-query', message: 'unresolved match-layer node reached the engine' }
		}
		if (node.type === 'match-ids') {
			artifacts.matchSets.set(node, node.matchIds)
			continue
		}
		if (node.type === 'subquery') {
			const inner = await resolveArtifacts(ctx, node.filter, bounds, depth + 1)
			if (inner.code !== 'ok') return inner
			if (node.target === 'matches') {
				const cond = compileMatchCond(node.filter, inner.artifacts, bounds)
				const rows = await ctx
					.db()
					.select({ id: mh.id })
					.from(mh)
					.where(E.and(matchBoundsCond(bounds), cond))
					.limit(MAX_SUBQUERY_MATCHES + 1)
				if (rows.length > MAX_SUBQUERY_MATCHES)
					return { code: 'err:too-broad', message: 'a matches sub-query matched too many matches' }
				artifacts.matchSets.set(
					node,
					rows.map((r) => r.id),
				)
			} else if (node.target === 'players') {
				const cond = compileEventCond(node.filter, inner.artifacts)
				const rows = await ctx
					.db()
					.selectDistinct({ playerId: pei.playerId })
					.from(pei)
					.where(E.and(eventBoundsCond(bounds), cond))
					.limit(MAX_SUBQUERY_PLAYERS + 1)
				if (rows.length > MAX_SUBQUERY_PLAYERS)
					return { code: 'err:too-broad', message: 'a players sub-query matched too many players' }
				artifacts.playerSets.set(
					node,
					rows.map((r) => r.playerId),
				)
			} else {
				assertNever(node.target)
			}
			continue
		}
		if (!HQ.isCompNode(node)) continue
		const comp = node as F.CompNode
		const column = F.compAnchorColumn(comp)
		if (!column || !HQ.getColumnDef(column)) {
			return { code: 'err:invalid-query', message: `unknown column ${column ?? '(none)'}` }
		}
		if (column === 'player') {
			const refs = compValueList(comp).filter((v): v is string => typeof v === 'string')
			artifacts.playerValues.set(node, await resolvePlayerRefs(ctx, refs))
		}
		if (column === 'event.damageSource') {
			const names = compValueList(comp).filter((v): v is string => typeof v === 'string')
			const rows =
				names.length > 0 ? await ctx.db().select().from(Schema.damageSources).where(E.inArray(Schema.damageSources.name, names)) : []
			artifacts.damageSourceIds.set(
				node,
				rows.map((r) => r.id),
			)
		}
	}
	return { code: 'ok', artifacts }
}

// -------- sql compilation --------

const GAME_PARTICIPANT = SchemaModels.SERVER_EVENT_PLAYER_ASSOC_TYPE.enum['game-participant']

export function eventBoundsCond(bounds: Bounds): E.SQL | undefined {
	return E.and(
		bounds.serverIds ? inJsonSet(pei.serverId, bounds.serverIds) : undefined,
		bounds.from !== undefined ? E.gte(pei.time, new Date(bounds.from)) : undefined,
		bounds.to !== undefined ? E.lte(pei.time, new Date(bounds.to)) : undefined,
		bounds.idMin !== undefined ? E.gte(pei.serverEventId, bounds.idMin) : undefined,
		bounds.idMax !== undefined ? E.lte(pei.serverEventId, bounds.idMax) : undefined,
	)
}

export function matchBoundsCond(bounds: Bounds): E.SQL | undefined {
	// an id-bounded matches query keeps matches that *could* hold events in range: the hot table answers
	// exactly, the archive answers from its recorded id range, and a pre-range archive row (null min/max)
	// stays included rather than silently vanishing
	let idRange: E.SQL | undefined
	if (bounds.idMin !== undefined || bounds.idMax !== undefined) {
		const lo = bounds.idMin ?? 0
		const hi = bounds.idMax ?? Number.MAX_SAFE_INTEGER
		idRange = sql`(
			${mh.id} IN (SELECT DISTINCT matchId FROM serverEvents WHERE id BETWEEN ${lo} AND ${hi})
			OR ${mh.id} IN (
				SELECT matchId FROM archivedMatches
				WHERE (maxEventId IS NULL OR maxEventId >= ${lo}) AND (minEventId IS NULL OR minEventId <= ${hi})
			)
		)`
	}
	return E.and(
		bounds.serverIds ? inJsonSet(mh.serverId, bounds.serverIds) : undefined,
		bounds.from !== undefined ? sql`${matchTime} >= ${bounds.from}` : undefined,
		bounds.to !== undefined ? sql`${matchTime} <= ${bounds.to}` : undefined,
		idRange,
	)
}

// negation with the evaluator's semantics: a comparison that is unknown (a NULL operand) is simply "not a
// match", so its negation matches. Plain NOT would propagate the NULL and silently exclude the row -- e.g.
// `variant != 'suicide'` must match a chat message, whose variant is NULL.
function negate(cond: E.SQL): E.SQL {
	return sql`(${cond}) IS NOT TRUE`
}

// eq/in/lt/gt/inrange over one column expression, with `map` turning a comparison value into the column's
// stored form.
function compileComp(comp: F.CompNode, col: E.SQL | E.AnyColumn, map: (v: F.Value) => unknown): E.SQL {
	let cond: E.SQL
	switch (comp.type) {
		case 'eq': {
			const v = compValueList(comp)[0] ?? null
			cond = v === null ? sql`${col} IS NULL` : sql`${col} = ${map(v)}`
			break
		}
		case 'in': {
			const values = compValueList(comp)
			const nonNull = values.filter((v) => v !== null)
			const parts: E.SQL[] = []
			if (nonNull.length > 0) parts.push(sql`${col} IN (SELECT value FROM json_each(${JSON.stringify(nonNull.map((v) => map(v)))}))`)
			if (values.length !== nonNull.length) parts.push(sql`${col} IS NULL`)
			cond = parts.length === 0 ? sql`0 = 1` : (E.or(...parts) as E.SQL)
			break
		}
		case 'lt': {
			const v = compValueList(comp)[0]
			cond = v === null || v === undefined ? sql`0 = 1` : sql`${col} < ${map(v)}`
			break
		}
		case 'gt': {
			const v = compValueList(comp)[0]
			cond = v === null || v === undefined ? sql`0 = 1` : sql`${col} > ${map(v)}`
			break
		}
		case 'inrange': {
			const [lo, hi] = compValueList(comp)
			cond =
				lo === null || hi === null || lo === undefined || hi === undefined ? sql`0 = 1` : sql`${col} BETWEEN ${map(lo)} AND ${map(hi)}`
			break
		}
		default:
			assertNever(comp)
	}
	return comp.neg ? negate(cond) : cond
}

// comparison values reach sqlite through raw templates, so time stays epoch ms (how timestamp columns are
// stored) rather than the Date a mapped drizzle operator would want
const id = (v: F.Value) => v

function combineBlock(type: F.BlockType, children: (E.SQL | undefined)[]): E.SQL | undefined {
	const present = children.filter((c): c is E.SQL => c !== undefined)
	const semantics = F.BLOCK_TYPE_SEMANTICS[type]
	if (present.length === 0) {
		// an empty and/nand constrains nothing; an empty or matches nothing (and nor everything)
		if (semantics.conjunction) return semantics.negated ? sql`0 = 1` : undefined
		return semantics.negated ? undefined : sql`0 = 1`
	}
	const combined = semantics.conjunction ? (E.and(...present) as E.SQL) : (E.or(...present) as E.SQL)
	return semantics.negated ? negate(combined) : combined
}

/**
 * The tree as a condition over playerEventIndex rows, with per-event semantics for the player-valued nodes
 * (they vary between an event's rows, so they compile to serverEventId subselects; everything else is
 * constant across an event's rows and compiles directly).
 */
export function compileEventCond(node: HQ.Node, art: ResolvedArtifacts): E.SQL | undefined {
	if (HQ.isBlockNode(node)) {
		return combineBlock(
			node.type,
			node.children.map((child) => compileEventCond(child, art)),
		)
	}
	if (node.type === 'match-layer' || (node.type === 'subquery' && node.target === 'matches')) {
		const matchIds = art.matchSets.get(node) ?? []
		const cond = matchIds.length === 0 ? sql`0 = 1` : inJsonSet(pei.matchId, matchIds)
		return node.neg ? negate(cond) : cond
	}
	if (node.type === 'subquery') {
		const playerIds = art.playerSets.get(node) ?? []
		const cond =
			playerIds.length === 0
				? sql`0 = 1`
				: sql`${pei.serverEventId} IN (SELECT serverEventId FROM playerEventIndex WHERE ${inJsonSet(sql`playerId`, playerIds)})`
		return node.neg ? negate(cond) : cond
	}
	const comp = node as F.CompNode
	const column = F.compAnchorColumn(comp)!
	switch (column as HQ.ColumnKey) {
		case 'time':
			return compileComp(comp, pei.time, id)
		case 'eventId':
			return compileComp(comp, pei.serverEventId, id)
		case 'server':
			return compileComp(comp, pei.serverId, id)
		case 'event.type':
			return compileComp(comp, pei.type, id)
		case 'event.variant':
			return compileComp(comp, pei.variant, id)
		case 'event.damageSource': {
			const ids = art.damageSourceIds.get(node) ?? []
			const hasNull = compValueList(comp).includes(null)
			const parts: E.SQL[] = []
			if (ids.length > 0) parts.push(E.inArray(pei.damageSourceId, ids) as E.SQL)
			if (hasNull) parts.push(sql`${pei.damageSourceId} IS NULL`)
			const cond = parts.length === 0 ? sql`0 = 1` : (E.or(...parts) as E.SQL)
			return comp.neg ? negate(cond) : cond
		}
		case 'player': {
			const playerIds = art.playerValues.get(node) ?? []
			const cond =
				playerIds.length === 0
					? sql`0 = 1`
					: sql`${pei.serverEventId} IN (SELECT serverEventId FROM playerEventIndex WHERE ${inJsonSet(sql`playerId`, playerIds)})`
			return comp.neg ? negate(cond) : cond
		}
		case 'chat.message': {
			const needle = compValueList(comp)[0]
			if (typeof needle !== 'string' || needle.length === 0) return comp.neg ? undefined : sql`0 = 1`
			const cond = sql`${pei.serverEventId} IN (SELECT serverEventId FROM chatSearch WHERE chatSearch MATCH ${needle})`
			return comp.neg ? negate(cond) : cond
		}
		case 'match.outcome':
			return compileComp(comp, sql`(SELECT outcome FROM matchHistory WHERE id = ${pei.matchId})`, id)
		case 'match.setBy':
			return compileComp(comp, sql`(SELECT setByType FROM matchHistory WHERE id = ${pei.matchId})`, id)
		default:
			assertNever(column as never)
	}
}

/**
 * The tree as a condition over matchHistory rows. Event-valued leaves get exists-semantics: the match has
 * at least one event satisfying that leaf.
 */
export function compileMatchCond(node: HQ.Node, art: ResolvedArtifacts, bounds: Bounds): E.SQL | undefined {
	if (HQ.isBlockNode(node)) {
		return combineBlock(
			node.type,
			node.children.map((child) => compileMatchCond(child, art, bounds)),
		)
	}
	if (node.type === 'match-layer' || (node.type === 'subquery' && node.target === 'matches')) {
		const matchIds = art.matchSets.get(node) ?? []
		const cond = matchIds.length === 0 ? sql`0 = 1` : inJsonSet(mh.id, matchIds)
		return node.neg ? negate(cond) : cond
	}
	if (node.type === 'subquery') {
		const playerIds = art.playerSets.get(node) ?? []
		const cond =
			playerIds.length === 0
				? sql`0 = 1`
				: sql`${mh.id} IN (SELECT DISTINCT matchId FROM playerEventIndex WHERE ${inJsonSet(sql`playerId`, playerIds)})`
		return node.neg ? negate(cond) : cond
	}
	const comp = node as F.CompNode
	const column = F.compAnchorColumn(comp)!
	switch (column as HQ.ColumnKey) {
		case 'time':
			return compileComp(comp, matchTime, id)
		case 'match.outcome':
			return compileComp(comp, mh.outcome, id)
		case 'match.setBy':
			return compileComp(comp, mh.setByType, id)
		case 'server':
			return compileComp(comp, mh.serverId, id)
		case 'chat.message': {
			const needle = compValueList(comp)[0]
			if (typeof needle !== 'string' || needle.length === 0) return comp.neg ? undefined : sql`0 = 1`
			const cond = sql`${mh.id} IN (SELECT matchId FROM chatSearch WHERE chatSearch MATCH ${needle})`
			return comp.neg ? negate(cond) : cond
		}
		// event-valued leaves: the match contains a matching event
		case 'eventId':
		case 'player':
		case 'event.type':
		case 'event.variant':
		case 'event.damageSource': {
			const leafCond = compileEventCond(node, art)
			const inner = E.and(eventBoundsCond({ ...bounds, serverIds: undefined }), leafCond)
			const cond = sql`${mh.id} IN (SELECT DISTINCT matchId FROM playerEventIndex ${inner ? sql`WHERE ${inner}` : sql``})`
			return comp.neg ? negate(cond) : cond
		}
		default:
			assertNever(column as never)
	}
}

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

// -------- the in-memory evaluator --------
// The same semantics as compileEventCond, over a parsed event instead of index rows. The retention sieve
// runs this against the events of a match being pruned, whose rows live in the archive blob rather than any
// table. One deliberate deviation: chat.message is a case-insensitive substring test here, where sql uses
// fts MATCH -- for retention, matching slightly more than fts would is the safe direction.

export type EvalEventCtx = {
	event: SE.Event
	row: SchemaModels.ServerEvent
	match: Pick<SchemaModels.MatchHistory, 'id' | 'serverId' | 'outcome' | 'setByType'>
}

function evalComp(comp: F.CompNode, actual: F.Value | undefined): boolean {
	const value = actual ?? null
	let result: boolean
	switch (comp.type) {
		case 'eq':
			result = value === (compValueList(comp)[0] ?? null)
			break
		case 'in':
			result = compValueList(comp).includes(value)
			break
		case 'lt':
			result = typeof value === 'number' && typeof compValueList(comp)[0] === 'number' && value < (compValueList(comp)[0] as number)
			break
		case 'gt':
			result = typeof value === 'number' && typeof compValueList(comp)[0] === 'number' && value > (compValueList(comp)[0] as number)
			break
		case 'inrange': {
			const [lo, hi] = compValueList(comp)
			result = typeof value === 'number' && typeof lo === 'number' && typeof hi === 'number' && value >= lo && value <= hi
			break
		}
		default:
			assertNever(comp)
	}
	return comp.neg ? !result : result
}

export function evalEventNode(node: HQ.Node, art: ResolvedArtifacts, ectx: EvalEventCtx): boolean {
	if (HQ.isBlockNode(node)) {
		const { conjunction, negated } = F.BLOCK_TYPE_SEMANTICS[node.type]
		const combined = conjunction
			? node.children.every((child) => evalEventNode(child, art, ectx))
			: node.children.some((child) => evalEventNode(child, art, ectx))
		return negated ? !combined : combined
	}
	if (node.type === 'match-layer' || (node.type === 'subquery' && node.target === 'matches')) {
		const result = (art.matchSets.get(node) ?? []).includes(ectx.match.id)
		return node.neg ? !result : result
	}
	if (node.type === 'subquery') {
		const playerIds = new Set(art.playerSets.get(node) ?? [])
		let result = false
		for (const [playerId] of SE.iterAssocPlayerIds(ectx.event)) {
			if (playerIds.has(playerId)) {
				result = true
				break
			}
		}
		return node.neg ? !result : result
	}
	const comp = node as F.CompNode
	const column = F.compAnchorColumn(comp)!
	switch (column as HQ.ColumnKey) {
		case 'time':
			return evalComp(comp, ectx.row.time.getTime())
		case 'eventId':
			return evalComp(comp, ectx.row.id)
		case 'server':
			return evalComp(comp, ectx.match.serverId)
		case 'event.type':
			return evalComp(comp, ectx.row.type)
		case 'event.variant':
			return evalComp(comp, 'variant' in ectx.event ? (ectx.event.variant ?? null) : null)
		case 'event.damageSource':
			return evalComp(comp, 'weapon' in ectx.event ? ectx.event.weapon : null)
		case 'player': {
			const playerIds = new Set(art.playerValues.get(node) ?? [])
			let result = false
			for (const [playerId, assocType] of SE.iterAssocPlayerIds(ectx.event)) {
				if (assocType === GAME_PARTICIPANT) continue
				if (playerIds.has(playerId)) {
					result = true
					break
				}
			}
			return comp.neg ? !result : result
		}
		case 'chat.message': {
			const needle = compValueList(comp)[0]
			const message = ectx.event.type === 'CHAT_MESSAGE' ? ectx.event.message : null
			const result =
				typeof needle === 'string' && needle.length > 0 && message !== null
					? message.toLowerCase().includes(needle.toLowerCase())
					: false
			return comp.neg ? !result : result
		}
		case 'match.outcome':
			return evalComp(comp, ectx.match.outcome)
		case 'match.setBy':
			return evalComp(comp, ectx.match.setByType)
		default:
			assertNever(column as never)
	}
}
