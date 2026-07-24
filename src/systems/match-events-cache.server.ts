import * as Schema from '$root/drizzle/schema'
import { LRUMap } from '@/lib/lru-map'
import * as CHAT from '@/models/chat.models'
import type * as CS from '@/models/context-shared'
import * as SE from '@/models/server-events.models'
import * as C from '@/server/context'
import { initModule } from '@/server/logger'
import * as E from 'drizzle-orm'

const module = initModule('match-events-cache')
let log!: CS.Logger

export function setup() {
	log = module.getLogger()
}

// Enriched events embed a player object per event, so a busy match costs single-digit MB of heap. Keep only
// enough for the windows the UI actually pages through back-to-back; anything older is re-read from the db.
export const MAX_CACHED_MATCHES = 3

export type MatchEventsCacheContext = {
	// matchId -> enriched events
	events: LRUMap<number, Promise<CHAT.EventEnriched[]>>
}

export function initMatchEventsCacheContext(): MatchEventsCacheContext {
	return { events: new LRUMap(MAX_CACHED_MATCHES) }
}

export const getEventsForMatches = C.spanOp(
	'getEventsForMatches',
	{ module, levels: { event: 'trace' } },
	async (ctx: C.Db & C.MatchEventsCache & CS.AbortSignal, ..._matches: number[]) => {
		const matches = _matches.toSorted((a, b) => a - b)

		const ops = new Map<number, Promise<CHAT.EventEnriched[]>>()
		const uncached: number[] = []
		for (const matchId of matches) {
			const cachedEvents$ = ctx.matchEventsCache.events.get(matchId)
			if (cachedEvents$) {
				ops.set(matchId, cachedEvents$)
				continue
			}
			uncached.push(matchId)
		}

		if (uncached.length > 0) {
			const batch$ = (async () => {
				const rawEvents = await ctx.db().select()
					.from(Schema.serverEvents)
					.where(E.inArray(Schema.serverEvents.matchId, uncached))
					.orderBy(E.asc(Schema.serverEvents.id))

				const rowsByMatch = new Map<number, typeof rawEvents>()
				for (const rawEvent of rawEvents) {
					let rows = rowsByMatch.get(rawEvent.matchId)
					if (!rows) rowsByMatch.set(rawEvent.matchId, rows = [])
					rows.push(rawEvent)
				}

				const eventsByMatch = new Map<number, CHAT.EventEnriched[]>()
				for (const matchId of uncached) {
					const state = CHAT.getInitialChatState()
					for (const event of SE.fromEventRows({ ...ctx, log }, rowsByMatch.get(matchId) ?? [])) {
						CHAT.handleEvent(state, event)
					}
					eventsByMatch.set(matchId, state.eventBuffer)
				}
				return eventsByMatch
			})()
			batch$.catch(() => {
				for (const matchId of uncached) ctx.matchEventsCache.events.delete(matchId)
			})
			for (const matchId of uncached) {
				ops.set(matchId, batch$.then(eventsByMatch => eventsByMatch.get(matchId)!))
			}
			// a batch wider than the cache would evict its own earlier entries anyway, so only the newest are kept.
			// `ops` holds every promise regardless, so the wider read itself is unaffected.
			for (const matchId of uncached.slice(-MAX_CACHED_MATCHES)) {
				ctx.matchEventsCache.events.set(matchId, ops.get(matchId)!)
			}
		}

		const allEvents = (await Promise.all(matches.map(matchId => ops.get(matchId)!))).flat()
		return allEvents
	},
)
