import * as E from 'drizzle-orm'
import { sql } from 'drizzle-orm'

import * as Schema from '$root/drizzle/schema'
import type * as SchemaModels from '$root/drizzle/schema.models'
import * as Arr from '@/lib/array-utils'
import * as CS from '@/models/context-shared'
import * as HQ from '@/models/history.models'
import * as SE from '@/models/server-events.models'
import type * as C from '@/server/context'
import * as DB from '@/server/db'
import { initModule } from '@/server/logger'
import * as EventArchive from '@/systems/event-archive.server'
import * as HistoryQuery from '@/systems/history-query.shared'
import * as HistoryResolve from '@/systems/history-resolve.server'

// The retention sieve: as pruning is about to drop a match's events, every saved query marked `retain` is
// evaluated against them and the matching events move to retainedEvents (with a claim per rule). Registered
// with event-archive rather than imported by it, because this module reaches the layer engine through
// history-resolve and event-archive sits below that chain.
//
// A rule that cannot be resolved throws, which fails the prune pass and keeps the archive intact: silently
// skipping a rule would delete exactly the events the rule promised to keep.

const module = initModule('history-retention')
let log!: CS.Logger

export function setup() {
	log = module.getLogger()
	EventArchive.registerRetentionSieve(sieveRetainedEvents)
}

// matches unpacked per sieve call; bounded by blob memory, not query cost
const SIEVE_CHUNK = 50
const INSERT_BATCH = 500

type ActiveRule = { id: string; node: HQ.Node; bounds: HistoryQuery.Bounds; art: HistoryQuery.ResolvedArtifacts }

async function loadActiveRules(ctx: C.Db & CS.AbortSignal): Promise<ActiveRule[]> {
	const rows = await ctx.db().select().from(Schema.savedQueries).where(E.eq(Schema.savedQueries.retain, true))
	if (rows.length === 0) return []
	const serverIds = (await ctx.db().select({ id: Schema.servers.id }).from(Schema.servers)).map((r) => r.id)
	const rules: ActiveRule[] = []
	for (const row of rows) {
		const parsed = HQ.QuerySchema.safeParse(row.query)
		if (!parsed.success || parsed.data.type !== 'events') {
			throw new Error(`retention rule ${row.id} (${row.name}) holds an unusable query; fix or unmark it to let pruning continue`)
		}
		const node = HQ.queryFilterNode(parsed.data)
		const bounds = HistoryQuery.boundsOf(parsed.data, serverIds)
		const rewritten = await HistoryResolve.rewriteLayerNodes(ctx, node, bounds)
		if (rewritten.code !== 'ok') throw new Error(`retention rule ${row.id} (${row.name}) failed to resolve: ${rewritten.code}`)
		const art = await HistoryQuery.resolveArtifacts(ctx, rewritten.node, bounds)
		if (art.code !== 'ok') throw new Error(`retention rule ${row.id} (${row.name}) failed to resolve: ${art.code}`)
		rules.push({ id: row.id, node: rewritten.node, bounds, art: art.artifacts })
	}
	return rules
}

// the engine only ever surfaces events with an indexed (non-game-participant) player association, so the
// sieve keeps to the same population
function isSearchable(event: SE.Event): boolean {
	for (const [, assocType] of SE.iterAssocPlayerIds(event)) {
		if (assocType !== 'game-participant') return true
	}
	return false
}

function eventInBounds(bounds: HistoryQuery.Bounds, row: SchemaModels.ServerEvent, serverId: string): boolean {
	if (bounds.serverIds && !bounds.serverIds.includes(serverId)) return false
	const t = row.time.getTime()
	if (bounds.from !== undefined && t < bounds.from) return false
	if (bounds.to !== undefined && t > bounds.to) return false
	if (bounds.idMin !== undefined && row.id < bounds.idMin) return false
	if (bounds.idMax !== undefined && row.id > bounds.idMax) return false
	return true
}

async function sieveRetainedEvents(ctx: C.Db & CS.AbortSignal, matchIds: number[]): Promise<Set<number>> {
	const retained = new Set<number>()
	const rules = await loadActiveRules(ctx)
	if (rules.length === 0) return retained

	const matchRows = await ctx
		.db()
		.select({
			id: Schema.matchHistory.id,
			serverId: Schema.matchHistory.serverId,
			outcome: Schema.matchHistory.outcome,
			setByType: Schema.matchHistory.setByType,
			layerId: Schema.matchHistory.layerId,
		})
		.from(Schema.matchHistory)
		.where(E.inArray(Schema.matchHistory.id, matchIds))
	const matchById = new Map(matchRows.map((m) => [m.id, m]))

	for (const chunk of Arr.paged(matchIds, SIEVE_CHUNK)) {
		ctx.signal.throwIfAborted()
		const byMatch = await EventArchive.loadMatchEvents(ctx, chunk)

		const newEvents: SchemaModels.NewRetainedEvent[] = []
		const claims: { savedQueryId: string; serverEventId: number }[] = []
		for (const [matchId, rows] of byMatch) {
			const match = matchById.get(matchId)
			if (!match) continue
			const rowById = new Map(rows.map((r) => [r.id, r]))
			for (const event of SE.fromEventRows({ ...CS.init(), log }, rows)) {
				if (!isSearchable(event)) continue
				const row = rowById.get(event.id)!
				const ectx: HistoryQuery.EvalEventCtx = { event, row, match }
				let claimed = false
				for (const rule of rules) {
					if (!eventInBounds(rule.bounds, row, match.serverId)) continue
					if (!HistoryQuery.evalEventNode(rule.node, rule.art, ectx)) continue
					claims.push({ savedQueryId: rule.id, serverEventId: row.id })
					claimed = true
				}
				if (!claimed) continue
				retained.add(row.id)
				newEvents.push({
					serverEventId: row.id,
					type: row.type,
					time: row.time,
					matchId: row.matchId,
					serverId: match.serverId,
					appEventId: row.appEventId,
					version: row.version,
					data: row.data,
				})
			}
		}

		if (newEvents.length > 0) {
			await DB.runTransaction(ctx, async (ctx) => {
				// or-ignore: a crashed prune pass may have sieved these matches already
				for (const batch of Arr.paged(newEvents, INSERT_BATCH)) {
					await ctx.db().insert(Schema.retainedEvents).values(batch).onConflictDoNothing()
				}
				for (const batch of Arr.paged(claims, INSERT_BATCH)) {
					await ctx.db().insert(Schema.retainedEventClaims).values(batch).onConflictDoNothing()
				}
			})
		}
	}

	if (retained.size > 0) log.info('retention rules kept %d event(s) out of %d pruned match(es)', retained.size, matchIds.length)
	return retained
}

/**
 * Drops retained events that no rule claims any more (a rule was deleted or unmarked), along with the index
 * and chat-text rows that were spared for them at prune time.
 */
export async function gcOrphanRetainedEvents(ctx: C.Db): Promise<number> {
	const orphans = await ctx
		.db()
		.select({ id: Schema.retainedEvents.serverEventId })
		.from(Schema.retainedEvents)
		.where(
			E.notExists(
				ctx
					.db()
					.select({ one: sql`1` })
					.from(Schema.retainedEventClaims)
					.where(E.eq(Schema.retainedEventClaims.serverEventId, Schema.retainedEvents.serverEventId)),
			),
		)
	if (orphans.length === 0) return 0
	const ids = orphans.map((o) => o.id)
	for (const batch of Arr.paged(ids, INSERT_BATCH)) {
		await DB.runTransaction(ctx, async (ctx) => {
			await ctx.db().delete(Schema.playerEventIndex).where(E.inArray(Schema.playerEventIndex.serverEventId, batch))
			// not awaited: run() on the better-sqlite3 driver is synchronous
			ctx.db().run(ctx.db().delete(Schema.Virtual.chatSearch).where(E.inArray(Schema.Virtual.chatSearch.serverEventId, batch)).getSQL())
			await ctx.db().delete(Schema.retainedEvents).where(E.inArray(Schema.retainedEvents.serverEventId, batch))
		})
	}
	log.info('dropped %d retained event(s) no rule claims', ids.length)
	return ids.length
}
