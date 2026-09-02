import * as E from 'drizzle-orm'
import { sql } from 'drizzle-orm'

import * as Schema from '$root/drizzle/schema'
import * as SchemaModels from '$root/drizzle/schema.models'
import { assertNever } from '@/lib/type-guards'
import type * as CS from '@/models/context-shared'
import * as F from '@/models/filter.models'
import * as HQ from '@/models/history.models'
import * as L from '@/models/layer'
import type * as C from '@/server/context'

// Compiles a history query's node tree to sql. The whole vocabulary is projected -- playerEventIndex,
// chatSearch and matchHistory hold every filterable dimension -- so no query ever unpacks an archived match
// to decide membership; bodies are read only to display a page (history.server.ts).
//
// Shared rather than server-owned because it has callers in two execution contexts: the query engine on its
// worker thread (history-query.worker.ts, which runs the queries these conditions feed) and the main thread,
// where history-resolve rewrites layer nodes.
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

export const pei = Schema.playerEventIndex
export const ae = Schema.appEvents
export const aea = Schema.appEventAssociations
export const mh = Schema.matchHistory
export const cs = Schema.Virtual.chatSearch
export const us = Schema.Virtual.usernameSearch

// abs(team1 - team2) over the match row, null while either side's tickets are unrecorded (an unfinished or
// pre-outcome match), which every comparison then reads as not-true rather than as zero
export const ticketDiffOf = (row: typeof mh) => sql`abs(${row.team1Tickets} - ${row.team2Tickets})`

// whole minutes from start to end, null until the app has seen both, which every comparison reads as
// not-true. A match in progress therefore never matches a length filter, which is the honest answer.
export const durationOf = (row: typeof mh) => sql`(${row.endTime} - ${row.startTime}) / 60000`
export const se = Schema.serverEvents
export const am = Schema.archivedMatches

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
	const wanted = query.servers
	const serverIds = wanted?.length ? visibleServerIds.filter((id) => wanted.includes(id)) : visibleServerIds
	return { serverIds, from: query.from, to: query.to, idMin: query.idMin, idMax: query.idMax }
}

export function inJsonSet(col: E.SQL | E.AnyColumn, ids: readonly (number | string)[]): E.SQL {
	return sql`${col} IN (SELECT value FROM json_each(${JSON.stringify(ids)}))`
}

// matches are dated like compaction dates them: end, else start, else first-seen
export const matchTime = sql<number>`coalesce(${mh.endTime}, ${mh.startTime}, ${mh.createdAt})`

// -------- resolution --------
// Everything the sql can't say on its own, resolved once per query and keyed by node identity: layer
// filters against the played-layer set, subqueries to id sets, steam64s to eos ids, damage-source names to
// interned ids.

export type ResolvedArtifacts = {
	matchSets: Map<HQ.Node, number[]>
	playerSets: Map<HQ.Node, string[]>
	playerValues: Map<HQ.Node, string[]>
	userValues: Map<HQ.Node, string[]>
	damageSourceIds: Map<HQ.Node, number[]>
	// the layer ids a layer-part predicate selects. Held as ids rather than as the matches that played them:
	// the id is what every table already carries, and there are a few hundred of them against any number of
	// matches, so `layerId IN (...)` reaches the same rows through matchHistory's own index.
	layerSets: Map<HQ.Node, string[]>
}

// A discord id is the user id itself; anything else reads as a name substring, matching how a player ref
// works. No trigram index here and none wanted: an install has hundreds of users where it has hundreds of
// thousands of players, so a LIKE over both name columns is already an insignificant scan.
const DISCORD_ID_RE = /^\d{17,20}$/

export async function resolveUserRefs(ctx: C.Db, refs: string[]): Promise<string[]> {
	const userIds: string[] = []
	for (const ref of refs) {
		if (DISCORD_ID_RE.test(ref)) userIds.push(ref)
		else userIds.push(...(await resolveNamedUserIds(ctx, ref)))
	}
	return userIds
}

export async function resolveNamedUserIds(ctx: C.Db, name: string): Promise<string[]> {
	const trimmed = name.trim()
	if (trimmed === '') return []
	const needle = `%${trimmed.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`
	// the nickname is the display name when set, so it is searched alongside the discord username the account
	// carries; either matching is a hit, since the searcher does not know which the user goes by here
	const rows = await ctx
		.db()
		.select({ discordId: Schema.users.discordId })
		.from(Schema.users)
		.innerJoin(Schema.discordAccounts, E.eq(Schema.discordAccounts.discordId, Schema.users.discordId))
		.where(
			E.or(sql`${Schema.users.nickname} LIKE ${needle} ESCAPE '\\'`, sql`${Schema.discordAccounts.username} LIKE ${needle} ESCAPE '\\'`),
		)
		.limit(MAX_NAME_MATCHES)
	return rows.map((r) => r.discordId.toString())
}

const STEAM64_RE = /^7656\d{13}$/
const EOS_ID_RE = /^[0-9a-f]{32}$/i

// a ref is an eos id, a steam64 to resolve to one, or anything else, which reads as a name substring
export async function resolvePlayerRefs(ctx: C.Db, refs: string[]): Promise<string[]> {
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
				sql`SELECT ${us.eosId} FROM ${us} WHERE ${us} MATCH ${`"${trimmed.replaceAll('"', '""')}"`} LIMIT ${MAX_NAME_MATCHES}`,
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

type PlayedLayer = { layerId: string; layer: L.UnvalidatedLayer }

/**
 * The distinct layers played in range, parsed. Bounded by what was actually played (a few hundred ids on the
 * largest install) rather than by the combinatorial layer universe, so this is a scan of matchHistory's
 * layerId index and a parse per distinct id.
 */
async function playedLayers(ctx: C.Db & CS.AbortSignal, bounds: Bounds): Promise<PlayedLayer[]> {
	const rows = await ctx.db().selectDistinct({ layerId: mh.layerId }).from(mh).where(matchBoundsCond(bounds))
	const out: PlayedLayer[] = []
	for (const { layerId } of rows) {
		// an id whose abbreviations this build no longer knows simply has no parts to match on, the same way a
		// layer retired from the artifact does. It still answers layer.layer, which toLayer recovers from a
		// RAW: id's own text.
		try {
			out.push({ layerId, layer: L.toLayer(layerId) })
		} catch {
			continue
		}
	}
	return out
}

// what a layer column reads off one parsed layer. Faction and unit are two-valued on purpose: the predicate
// asks whether a side played it, not which slot it occupied (see LAYER_COLUMN_KEYS).
function layerColumnValues(column: HQ.LayerColumnKey, layer: L.UnvalidatedLayer): (F.Value | undefined)[] {
	switch (column) {
		case 'layer.layer':
			return [layer.Layer]
		case 'layer.map':
			return [layer.Map]
		case 'layer.gamemode':
			return [layer.Gamemode]
		case 'layer.faction':
			return [layer.Faction_1, layer.Faction_2]
		case 'layer.unit':
			return [layer.Unit_1, layer.Unit_2]
		default:
			assertNever(column)
	}
}

/** The comparison against one value, before negation: what resolves a layer predicate over parsed ids. */
function evalCompValue(comp: F.CompNode, actual: F.Value | undefined): boolean {
	const value = actual ?? null
	const values = compValueList(comp)
	switch (comp.type) {
		case 'eq':
			return value === (values[0] ?? null)
		case 'in':
			return values.includes(value)
		case 'lt':
			return typeof value === 'number' && typeof values[0] === 'number' && value < values[0]
		case 'gt':
			return typeof value === 'number' && typeof values[0] === 'number' && value > values[0]
		case 'inrange': {
			const [lo, hi] = values
			return typeof value === 'number' && typeof lo === 'number' && typeof hi === 'number' && value >= lo && value <= hi
		}
		default:
			assertNever(comp)
	}
}

// the positive set: negation belongs to whichever engine consumes the artifact, so that a layer predicate
// negates with the same not-true semantics as every other leaf
function layerIdsMatching(comp: F.CompNode, column: HQ.LayerColumnKey, played: PlayedLayer[]): string[] {
	const ids: string[] = []
	for (const { layerId, layer } of played) {
		if (layerColumnValues(column, layer).some((value) => evalCompValue(comp, value))) ids.push(layerId)
	}
	return ids
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
		userValues: new Map(),
		damageSourceIds: new Map(),
		layerSets: new Map(),
	}
	// resolved on first use and shared by every layer node in the tree
	let played: PlayedLayer[] | undefined
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
		if (HQ.isPlayerColumn(column)) {
			const refs = compValueList(comp).filter((v): v is string => typeof v === 'string')
			artifacts.playerValues.set(node, await resolvePlayerRefs(ctx, refs))
		}
		if (column === 'user') {
			const refs = compValueList(comp).filter((v): v is string => typeof v === 'string')
			artifacts.userValues.set(node, await resolveUserRefs(ctx, refs))
		}
		if (HQ.isLayerColumn(column)) {
			played ??= await playedLayers(ctx, bounds)
			artifacts.layerSets.set(node, layerIdsMatching(comp, column, played))
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

// resolveArtifacts rejects a tree naming a column this vocabulary does not have, so reaching a compiler or
// the evaluator with one is a caller bug rather than bad input. Unlike the `as never` cast this replaces, it
// leaves the switches genuinely exhaustive: a new column stops them compiling.
function mustColumnKey(comp: F.CompNode): HQ.ColumnKey {
	const column = HQ.compColumnKey(comp)
	if (!column) throw new Error(`history query: unresolved column ${F.compAnchorColumn(comp) ?? '(none)'}`)
	return column
}

// -------- sql compilation --------

export const GAME_PARTICIPANT = SchemaModels.SERVER_EVENT_PLAYER_ASSOC_TYPE.enum['game-participant']

export function eventBoundsCond(bounds: Bounds): E.SQL | undefined {
	return E.and(
		bounds.serverIds ? inJsonSet(pei.serverId, bounds.serverIds) : undefined,
		bounds.from !== undefined ? E.gte(pei.time, new Date(bounds.from)) : undefined,
		bounds.to !== undefined ? E.lte(pei.time, new Date(bounds.to)) : undefined,
		bounds.idMin !== undefined ? E.gte(pei.serverEventId, bounds.idMin) : undefined,
		bounds.idMax !== undefined ? E.lte(pei.serverEventId, bounds.idMax) : undefined,
	)
}

// The same bounds against appEvents. No id bound: an app event's id is an opaque string, so an id-ranged
// query (which only ever means "the events around this one") cannot place it, and it is excluded rather than
// admitted unbounded.
export function appEventBoundsCond(bounds: Bounds): E.SQL | undefined {
	if (bounds.idMin !== undefined || bounds.idMax !== undefined) return sql`0 = 1`
	return E.and(
		// a global (audit-only) event belongs to no server and no match, so there is no feed row to draw for it
		sql`${ae.serverId} IS NOT NULL AND ${ae.matchId} IS NOT NULL`,
		E.eq(ae.feedVisible, true),
		bounds.serverIds ? inJsonSet(ae.serverId, bounds.serverIds) : undefined,
		bounds.from !== undefined ? E.gte(ae.time, new Date(bounds.from)) : undefined,
		bounds.to !== undefined ? E.lte(ae.time, new Date(bounds.to)) : undefined,
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
			${mh.id} IN (SELECT DISTINCT ${se.matchId} FROM ${se} WHERE ${se.id} BETWEEN ${lo} AND ${hi})
			OR ${mh.id} IN (
				SELECT ${am.matchId} FROM ${am}
				WHERE (${am.maxEventId} IS NULL OR ${am.maxEventId} >= ${lo}) AND (${am.minEventId} IS NULL OR ${am.minEventId} <= ${hi})
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
	if (!HQ.isCompNode(node)) {
		switch (node.type) {
			case 'match-layer':
			case 'match-ids': {
				const matchIds = art.matchSets.get(node) ?? []
				const cond = matchIds.length === 0 ? sql`0 = 1` : inJsonSet(pei.matchId, matchIds)
				return node.neg ? negate(cond) : cond
			}
			case 'subquery': {
				if (node.target === 'matches') {
					const matchIds = art.matchSets.get(node) ?? []
					const cond = matchIds.length === 0 ? sql`0 = 1` : inJsonSet(pei.matchId, matchIds)
					return node.neg ? negate(cond) : cond
				}
				const playerIds = art.playerSets.get(node) ?? []
				const cond =
					playerIds.length === 0
						? sql`0 = 1`
						: sql`${pei.serverEventId} IN (SELECT ${pei.serverEventId} FROM ${pei} WHERE ${inJsonSet(pei.playerId, playerIds)})`
				return node.neg ? negate(cond) : cond
			}
			default:
				assertNever(node)
		}
	}
	const comp = node as F.CompNode
	const column = mustColumnKey(comp)
	switch (column) {
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
		case 'player':
			return eventPlayerCond(comp, art.playerValues.get(node) ?? [])
		// the same predicate narrowed to one end of the kill. Row-scoped inside the subselect on purpose: an
		// assocType compared against the outer row would match the attacker's row of an event the victim named,
		// which is the opposite of what was asked
		case 'event.attacker':
			return eventPlayerCond(comp, art.playerValues.get(node) ?? [], 'attacker')
		case 'event.victim':
			return eventPlayerCond(comp, art.playerValues.get(node) ?? [], 'victim')
		case 'chat.message': {
			const needle = compValueList(comp)[0]
			if (typeof needle !== 'string' || needle.length === 0) return comp.neg ? undefined : sql`0 = 1`
			const cond = sql`${pei.serverEventId} IN (SELECT ${cs.serverEventId} FROM ${cs} WHERE ${cs} MATCH ${needle})`
			return comp.neg ? negate(cond) : cond
		}
		case 'chat.channel':
			return compileComp(comp, pei.channel, id)
		case 'match.id':
			return compileComp(comp, pei.matchId, id)
		case 'match.outcome':
			return compileComp(comp, sql`(SELECT ${mh.outcome} FROM ${mh} WHERE ${mh.id} = ${pei.matchId})`, id)
		case 'match.setBy':
			return compileComp(comp, sql`(SELECT ${mh.setByType} FROM ${mh} WHERE ${mh.id} = ${pei.matchId})`, id)
		case 'match.ticketDiff':
			return compileComp(comp, sql`(SELECT ${ticketDiffOf(mh)} FROM ${mh} WHERE ${mh.id} = ${pei.matchId})`, id)
		case 'match.duration':
			return compileComp(comp, sql`(SELECT ${durationOf(mh)} FROM ${mh} WHERE ${mh.id} = ${pei.matchId})`, id)
		case 'layer.layer':
		case 'layer.map':
		case 'layer.gamemode':
		case 'layer.faction':
		case 'layer.unit': {
			const layerIds = art.layerSets.get(node) ?? []
			const cond =
				layerIds.length === 0
					? sql`0 = 1`
					: sql`${pei.matchId} IN (SELECT ${mh.id} FROM ${mh} WHERE ${inJsonSet(mh.layerId, layerIds)})`
			return comp.neg ? negate(cond) : cond
		}
		// an app-event dimension a server event has no counterpart for: it records what the game did, which is
		// never attributable to an SLM user
		case 'user':
			return comp.neg ? negate(sql`0 = 1`) : sql`0 = 1`
		default:
			assertNever(column)
	}
}

// "an event this player is named in", optionally only where they are named as one end of a kill. Per-event,
// not per-row: an event's rows differ by player, so the condition has to hold for the event as a whole.
function eventPlayerCond(comp: F.CompNode, playerIds: string[], assocType?: HQ.PlayerRole): E.SQL {
	const assoc = assocType === undefined ? sql`` : sql`${pei.assocType} = ${assocType} AND `
	const cond =
		playerIds.length === 0
			? sql`0 = 1`
			: sql`${pei.serverEventId} IN (SELECT ${pei.serverEventId} FROM ${pei} WHERE ${assoc}${inJsonSet(pei.playerId, playerIds)})`
	return comp.neg ? negate(cond) : cond
}

/**
 * The same tree as a condition over appEvents rows.
 *
 * The two families answer a different subset of the vocabulary, so the columns an app event has no notion of
 * (a kill's damage source, chat text) compile to false rather than being rejected: a query naming one is asking
 * for server events, and app events simply are not among the answers. Under negation that inverts to true,
 * which reads correctly -- an app event is indeed not a teamkill.
 */
export function compileAppEventCond(node: HQ.Node, art: ResolvedArtifacts): E.SQL | undefined {
	if (HQ.isBlockNode(node)) {
		return combineBlock(
			node.type,
			node.children.map((child) => compileAppEventCond(child, art)),
		)
	}
	if (!HQ.isCompNode(node)) {
		switch (node.type) {
			case 'match-layer':
			case 'match-ids': {
				const matchIds = art.matchSets.get(node) ?? []
				const cond = matchIds.length === 0 ? sql`0 = 1` : inJsonSet(ae.matchId, matchIds)
				return node.neg ? negate(cond) : cond
			}
			case 'subquery': {
				if (node.target === 'matches') {
					const matchIds = art.matchSets.get(node) ?? []
					const cond = matchIds.length === 0 ? sql`0 = 1` : inJsonSet(ae.matchId, matchIds)
					return node.neg ? negate(cond) : cond
				}
				const playerIds = art.playerSets.get(node) ?? []
				const cond = playerIds.length === 0 ? sql`0 = 1` : appEventPlayerCond(playerIds)
				return node.neg ? negate(cond) : cond
			}
			default:
				assertNever(node)
		}
	}
	const comp = node as F.CompNode
	const column = mustColumnKey(comp)
	switch (column) {
		case 'time':
			return compileComp(comp, ae.time, id)
		case 'server':
			return compileComp(comp, ae.serverId, id)
		case 'event.type':
			return compileComp(comp, ae.type, id)
		case 'player': {
			const playerIds = art.playerValues.get(node) ?? []
			const cond = playerIds.length === 0 ? sql`0 = 1` : appEventPlayerCond(playerIds)
			return comp.neg ? negate(cond) : cond
		}
		case 'user': {
			const userIds = art.userValues.get(node) ?? []
			const cond = userIds.length === 0 ? sql`0 = 1` : appEventUserCond(userIds)
			return comp.neg ? negate(cond) : cond
		}
		case 'match.id':
			return compileComp(comp, ae.matchId, id)
		case 'match.outcome':
			return compileComp(comp, sql`(SELECT ${mh.outcome} FROM ${mh} WHERE ${mh.id} = ${ae.matchId})`, id)
		case 'match.setBy':
			return compileComp(comp, sql`(SELECT ${mh.setByType} FROM ${mh} WHERE ${mh.id} = ${ae.matchId})`, id)
		case 'match.ticketDiff':
			return compileComp(comp, sql`(SELECT ${ticketDiffOf(mh)} FROM ${mh} WHERE ${mh.id} = ${ae.matchId})`, id)
		case 'match.duration':
			return compileComp(comp, sql`(SELECT ${durationOf(mh)} FROM ${mh} WHERE ${mh.id} = ${ae.matchId})`, id)
		case 'layer.layer':
		case 'layer.map':
		case 'layer.gamemode':
		case 'layer.faction':
		case 'layer.unit': {
			const layerIds = art.layerSets.get(node) ?? []
			const cond =
				layerIds.length === 0 ? sql`0 = 1` : sql`${ae.matchId} IN (SELECT ${mh.id} FROM ${mh} WHERE ${inJsonSet(mh.layerId, layerIds)})`
			return comp.neg ? negate(cond) : cond
		}
		// server-event dimensions an app event has no counterpart for
		case 'eventId':
		case 'event.variant':
		case 'event.damageSource':
		case 'chat.message':
		case 'chat.channel':
		case 'event.attacker':
		case 'event.victim':
			return comp.neg ? negate(sql`0 = 1`) : sql`0 = 1`
		default:
			assertNever(column)
	}
}

function appEventPlayerCond(playerIds: string[]): E.SQL {
	return sql`${ae.id} IN (SELECT ${aea.appEventId} FROM ${aea} WHERE ${aea.dimension} = 'player' AND ${inJsonSet(aea.value, playerIds)})`
}

function appEventUserCond(userIds: string[]): E.SQL {
	return sql`${ae.id} IN (SELECT ${aea.appEventId} FROM ${aea} WHERE ${aea.dimension} = 'user' AND ${inJsonSet(aea.value, userIds)})`
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
	if (!HQ.isCompNode(node)) {
		switch (node.type) {
			case 'match-layer':
			case 'match-ids': {
				const matchIds = art.matchSets.get(node) ?? []
				const cond = matchIds.length === 0 ? sql`0 = 1` : inJsonSet(mh.id, matchIds)
				return node.neg ? negate(cond) : cond
			}
			case 'subquery': {
				if (node.target === 'matches') {
					const matchIds = art.matchSets.get(node) ?? []
					const cond = matchIds.length === 0 ? sql`0 = 1` : inJsonSet(mh.id, matchIds)
					return node.neg ? negate(cond) : cond
				}
				const playerIds = art.playerSets.get(node) ?? []
				const cond =
					playerIds.length === 0
						? sql`0 = 1`
						: sql`${mh.id} IN (SELECT DISTINCT ${pei.matchId} FROM ${pei} WHERE ${inJsonSet(pei.playerId, playerIds)})`
				return node.neg ? negate(cond) : cond
			}
			default:
				assertNever(node)
		}
	}
	const comp = node as F.CompNode
	const column = mustColumnKey(comp)
	switch (column) {
		case 'time':
			return compileComp(comp, matchTime, id)
		case 'match.id':
			return compileComp(comp, mh.id, id)
		case 'match.outcome':
			return compileComp(comp, mh.outcome, id)
		case 'match.setBy':
			return compileComp(comp, mh.setByType, id)
		case 'match.ticketDiff':
			return compileComp(comp, ticketDiffOf(mh), id)
		case 'match.duration':
			return compileComp(comp, durationOf(mh), id)
		case 'server':
			return compileComp(comp, mh.serverId, id)
		case 'chat.message': {
			const needle = compValueList(comp)[0]
			if (typeof needle !== 'string' || needle.length === 0) return comp.neg ? undefined : sql`0 = 1`
			const cond = sql`${mh.id} IN (SELECT ${cs.matchId} FROM ${cs} WHERE ${cs} MATCH ${needle})`
			return comp.neg ? negate(cond) : cond
		}
		case 'layer.layer':
		case 'layer.map':
		case 'layer.gamemode':
		case 'layer.faction':
		case 'layer.unit': {
			const layerIds = art.layerSets.get(node) ?? []
			const cond = layerIds.length === 0 ? sql`0 = 1` : inJsonSet(mh.layerId, layerIds)
			return comp.neg ? negate(cond) : cond
		}
		// event-valued leaves: the match contains a matching event, of either family
		case 'eventId':
		case 'player':
		case 'user':
		case 'event.type':
		case 'event.variant':
		case 'event.damageSource':
		case 'chat.channel':
		case 'event.attacker':
		case 'event.victim': {
			const inner = E.and(eventBoundsCond({ ...bounds, serverIds: undefined }), compileEventCond(node, art))
			const appInner = E.and(appEventBoundsCond({ ...bounds, serverIds: undefined }), compileAppEventCond(node, art))
			const cond = E.or(
				sql`${mh.id} IN (SELECT DISTINCT ${pei.matchId} FROM ${pei} ${inner ? sql`WHERE ${inner}` : sql``})`,
				sql`${mh.id} IN (SELECT DISTINCT ${ae.matchId} FROM ${ae} ${appInner ? sql`WHERE ${appInner}` : sql``})`,
			) as E.SQL
			return comp.neg ? negate(cond) : cond
		}
		default:
			assertNever(column)
	}
}
