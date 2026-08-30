import * as E from 'drizzle-orm'
import { sql } from 'drizzle-orm'
import { z } from 'zod'

import * as Schema from '$root/drizzle/schema'
import * as SchemaModels from '$root/drizzle/schema.models'
import * as CHAT from '@/models/chat.models'
import type * as CS from '@/models/context-shared'
import * as F from '@/models/filter.models'
import type * as L from '@/models/layer'
import { initModule } from '@/server/logger'
import { getOrpcBase } from '@/server/orpc-base'
import * as LayerQueriesServer from '@/systems/layer-queries.server'
import * as LayerQueries from '@/systems/layer-queries.shared'
import * as MatchEventsCache from '@/systems/match-events-cache.server'
import * as SquadServer from '@/systems/squad-server.server'

const module = initModule('event-search')
let _log!: CS.Logger
const orpcBase = getOrpcBase(module)

export function setup() {
	_log = module.getLogger()
}

export const router = {
	// Long-horizon search over recorded events, across every match on record rather than the recent window.
	//
	// The dimensions are answered by different tables and meet at the match id: the player dimension by
	// playerEventIndex, chat text by the chatSearch fts index (both of which outlive compaction), the layer
	// dimension by matchHistory's parsed layer parts. Event bodies are read last, for the page actually being
	// returned, from the hot table or the archive.
	//
	// Matches whose layer this build cannot resolve are excluded whenever a layer filter is given, and counted
	// in `unrecognisedLayerMatches` -- silently dropping them would make a filtered search quietly incomplete.
	searchEvents: orpcBase
		.input(
			z.object({
				serverId: z.string(),
				// eos id, or a steam64 to be resolved to one
				playerId: z.string().optional(),
				steam64: z.string().optional(),
				// layers the match must match for its events to be included
				layerFilter: F.FilterNodeSchema.optional(),
				types: z.array(z.enum(SchemaModels.SERVER_EVENT_TYPE.options)).optional(),
				// an fts5 MATCH expression against chat text. Selects chat messages alone, so it does not combine
				// with `types`.
				messageContains: z.string().min(1).optional(),
				from: z.number().optional(),
				to: z.number().optional(),
				// exclusive upper-bound time; page backwards from newest
				cursor: z.number().optional(),
				pageSize: z.number().positive().max(500).default(100),
				allServers: z.boolean().default(false),
			}),
		)
		.handler(async ({ input, context: _ctx }) => {
			const ctxRes = await SquadServer.tryCtx(_ctx, input.serverId)
			if (ctxRes.code !== 'ok') return ctxRes
			const ctx = ctxRes.ctx

			let playerId = input.playerId
			if (!playerId && input.steam64) {
				const [row] = await ctx
					.db()
					.select({ eosId: Schema.players.eosId })
					.from(Schema.players)
					.where(E.eq(Schema.players.steamId, BigInt(input.steam64)))
				// a steam account SLM has never seen on a server has no eos id, and so no events
				if (!row) return { code: 'ok' as const, events: CHAT.Wire.encode([]), nextCursor: undefined, unrecognisedLayerMatches: 0 }
				playerId = row.eosId
			}
			// a chat-text search stands on its own; every other search is anchored on a player
			if (!playerId && !input.messageContains) {
				return { code: 'err:no-subject' as const, message: 'one of playerId, steam64 or messageContains is required' }
			}

			let unrecognisedLayerMatches = 0
			let matchIds: number[] | undefined
			if (input.layerFilter) {
				const scoped = input.allServers ? undefined : E.eq(Schema.matchHistory.serverId, input.serverId)
				const played = await ctx
					.db()
					.selectDistinct({ layerId: Schema.matchHistory.layerId })
					.from(Schema.matchHistory)
					.where(E.and(E.isNotNull(Schema.matchHistory.layerMap), scoped))
				const [{ count: unrecognised } = { count: 0 }] = await ctx
					.db()
					.select({ count: E.count() })
					.from(Schema.matchHistory)
					.where(E.and(E.isNull(Schema.matchHistory.layerMap), scoped))
				unrecognisedLayerMatches = unrecognised

				// the filter is evaluated against the layers actually played, not against the layer universe:
				// the played set is bounded by the match count, while the universe is combinatorial
				const lqCtx = await LayerQueriesServer.resolveLayerQueryCtx(ctx)
				const pool = await LayerQueries.getLayersOutOfPool({
					ctx: lqCtx,
					input: {
						layerIds: played.map((p) => p.layerId as L.LayerId),
						constraints: [
							{
								type: 'filter-anon',
								filter: input.layerFilter,
								filterApplState: 'regular',
								showIndicator: 'disabled',
								id: 'search',
							},
						],
					},
				})
				if (pool.code !== 'ok') return pool
				const outOfPool = new Set(pool.outOfPool)
				const inPool = played.map((p) => p.layerId).filter((id) => !outOfPool.has(id as L.LayerId))
				if (inPool.length === 0) {
					return { code: 'ok' as const, events: CHAT.Wire.encode([]), nextCursor: undefined, unrecognisedLayerMatches }
				}
				const matches = await ctx
					.db()
					.select({ id: Schema.matchHistory.id })
					.from(Schema.matchHistory)
					.where(E.and(E.inArray(Schema.matchHistory.layerId, inPool), scoped))
				matchIds = matches.map((m) => m.id)
				if (matchIds.length === 0) {
					return { code: 'ok' as const, events: CHAT.Wire.encode([]), nextCursor: undefined, unrecognisedLayerMatches }
				}
			}

			let hits: { serverEventId: number; matchId: number; time: Date }[]
			if (input.messageContains) {
				// fts5 owns the text; the remaining predicates are UNINDEXED columns it stores alongside, so they
				// filter the matched rows rather than driving the scan
				const rows = ctx.db().all<{ serverEventId: number; matchId: number; time: number }>(sql`
					SELECT serverEventId, matchId, time FROM chatSearch
					WHERE chatSearch MATCH ${input.messageContains}
					${playerId ? sql`AND playerId = ${playerId}` : sql``}
					${input.allServers ? sql`` : sql`AND serverId = ${input.serverId}`}
					${input.from !== undefined ? sql`AND time >= ${input.from}` : sql``}
					${input.to !== undefined ? sql`AND time <= ${input.to}` : sql``}
					${input.cursor !== undefined ? sql`AND time < ${input.cursor}` : sql``}
					${matchIds ? sql`AND matchId IN ${matchIds}` : sql``}
					ORDER BY time DESC LIMIT ${input.pageSize}
				`)
				hits = rows.map((r) => ({ serverEventId: r.serverEventId, matchId: r.matchId, time: new Date(r.time) }))
			} else {
				// one contiguous range of the index: the pk leads with playerId and then time
				hits = await ctx
					.db()
					.select({
						serverEventId: Schema.playerEventIndex.serverEventId,
						matchId: Schema.playerEventIndex.matchId,
						time: Schema.playerEventIndex.time,
					})
					.from(Schema.playerEventIndex)
					.where(
						E.and(
							E.eq(Schema.playerEventIndex.playerId, playerId!),
							input.allServers ? undefined : E.eq(Schema.playerEventIndex.serverId, input.serverId),
							E.ne(Schema.playerEventIndex.assocType, SchemaModels.SERVER_EVENT_PLAYER_ASSOC_TYPE.enum['game-participant']),
							input.types ? E.inArray(Schema.playerEventIndex.type, input.types) : undefined,
							input.from !== undefined ? E.gte(Schema.playerEventIndex.time, new Date(input.from)) : undefined,
							input.to !== undefined ? E.lte(Schema.playerEventIndex.time, new Date(input.to)) : undefined,
							input.cursor !== undefined ? E.lt(Schema.playerEventIndex.time, new Date(input.cursor)) : undefined,
							matchIds ? E.inArray(Schema.playerEventIndex.matchId, matchIds) : undefined,
						),
					)
					.orderBy(E.desc(Schema.playerEventIndex.time))
					.limit(input.pageSize)
			}

			if (hits.length === 0)
				return { code: 'ok' as const, events: CHAT.Wire.encode([]), nextCursor: undefined, unrecognisedLayerMatches }

			// event bodies come last, and only for this page. Enriched rather than raw: a filtered slice carries no
			// roster to replay against, so the client cannot enrich it itself (same reason as getPlayerEvents).
			const wanted = new Set<number>(hits.map((h) => h.serverEventId))
			const pageMatchIds = [...new Set(hits.map((h) => h.matchId))]
			const enriched = await MatchEventsCache.getEnrichedEventsForMatches(ctx, ...pageMatchIds)
			// app events replay into the same buffer and carry string ids; the index covers server events only
			const events = enriched.filter((e) => typeof e.id === 'number' && wanted.has(e.id)).sort((a, b) => a.time - b.time)

			const nextCursor = hits.length === input.pageSize ? hits[hits.length - 1].time.getTime() : undefined
			return { code: 'ok' as const, events: CHAT.Wire.encode(events), nextCursor, unrecognisedLayerMatches }
		}),
}
