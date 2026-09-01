import * as E from 'drizzle-orm'

import * as Schema from '$root/drizzle/schema'
import { LRUMap } from '@/lib/lru-map'
import * as AppEvents from '@/models/app-events.models'
import * as CHAT from '@/models/chat.models'
import type * as CS from '@/models/context-shared'
import type * as MEC from '@/models/match-events-cache.models'
import * as SE from '@/models/server-events.models'
import type * as SM from '@/models/squad.models'
import type * as C from '@/server/context'
import * as Instr from '@/server/instrumentation'
import { initModule } from '@/server/logger'
import * as EventArchive from '@/systems/event-archive.server'

const module = initModule('match-events-cache')
let log!: CS.Logger

export function setup() {
	log = module.getLogger()
}

// Raw events are what the cache holds, so a match costs roughly its rows rather than the enriched form's embedded
// player per event. Keep only enough for the windows the UI pages through back-to-back; anything older is re-read.
export const MAX_CACHED_MATCHES = 3

export function initMatchEventsCacheContext(): MEC.Ctx.Payload {
	return { events: new LRUMap(MAX_CACHED_MATCHES) }
}

/**
 * A match's feed events in the same form the live chat stream sends: raw server events with the app events SLM
 * recorded against that match interleaved, ready to be replayed into enriched entries.
 *
 * Cached per match and shared between callers, so nothing may write through an entry. Replay does not: interpolation
 * copies the event it enriches, and the types it passes through untouched are never mutated afterwards.
 */
export const getFeedEventsForMatches = Instr.spanOp(
	'getFeedEventsForMatches',
	{ module, levels: { event: 'trace' } },
	async (ctx: C.Db & MEC.Ctx & CS.AbortSignal, ..._matches: number[]) => {
		const matches = _matches.toSorted((a, b) => a - b)

		const ops = new Map<number, Promise<CHAT.Event[]>>()
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
				// hot rows for matches still inside the archive window, unpacked blobs for the rest; the two are
				// indistinguishable from here
				const rowsByMatch = await EventArchive.loadMatchEvents(ctx, uncached)

				// SLM's own actions are entries in their own right, and the server events they caused collapse under them.
				// isFeedVisible is what keeps audit-only rows (a queue-driven MAP_SET) from duplicating their cause.
				// app events are not archived: the table is three orders of magnitude smaller than serverEvents and is
				// read by the global audit log on a time cursor, which a per-match blob cannot serve.
				const rawAppEvents = await ctx
					.db()
					.select()
					.from(Schema.appEvents)
					.where(E.inArray(Schema.appEvents.matchId, uncached))
					.orderBy(E.asc(Schema.appEvents.time))

				const appEventsByMatch = new Map<number, AppEvents.AppEvent[]>()
				let dropped = 0
				for (const row of rawAppEvents) {
					const appEvent = AppEvents.fromRow(row)
					if (!appEvent) {
						dropped++
						continue
					}
					if (!AppEvents.isFeedVisible(appEvent) || row.matchId === null) continue
					let events = appEventsByMatch.get(row.matchId)
					if (!events) appEventsByMatch.set(row.matchId, (events = []))
					events.push(appEvent)
				}
				if (dropped > 0) log.warn('dropped %d unparseable app-event row(s) from the match feed', dropped)

				const eventsByMatch = new Map<number, CHAT.Event[]>()
				for (const matchId of uncached) {
					const serverEvents = SE.fromEventRows({ ...ctx, log }, rowsByMatch.get(matchId) ?? [])
					eventsByMatch.set(matchId, CHAT.mergeAppEvents(serverEvents, appEventsByMatch.get(matchId) ?? []))
				}
				return eventsByMatch
			})()
			batch$.catch(() => {
				for (const matchId of uncached) ctx.matchEventsCache.events.delete(matchId)
			})
			for (const matchId of uncached) {
				ops.set(
					matchId,
					batch$.then((eventsByMatch) => eventsByMatch.get(matchId)!),
				)
			}
			// a batch wider than the cache would evict its own earlier entries anyway, so only the newest are kept.
			// `ops` holds every promise regardless, so the wider read itself is unaffected.
			for (const matchId of uncached.slice(-MAX_CACHED_MATCHES)) {
				ctx.matchEventsCache.events.set(matchId, ops.get(matchId)!)
			}
		}

		return new Map(await Promise.all(matches.map(async (matchId) => [matchId, await ops.get(matchId)!] as const)))
	},
)

/**
 * The enriched feed for each match: the replay every reader of a past match gets its entries from.
 *
 * Replayed here rather than on the client so that one implementation decides what a match's feed is, whether the
 * reader wants the whole of it or the slice a query matched. Enrichment embeds a player object per event, which is
 * most of what a busy match costs to send, so the whole-match readers send it wire-encoded (see CHAT.Wire).
 *
 * Each match replays from an empty roster, so its entries never resolve against another match's players.
 *
 * `opts` is the interpolation config the live feed replays with, and must be, or the two readings of one match
 * disagree: the suppression patterns drop entries, so omitting them here shows events the live feed never did.
 * Taken as a parameter rather than read from the settings module, which imports this one back.
 */
export const getEnrichedEventsForMatches = Instr.spanOp(
	'getEnrichedEventsForMatches',
	{ module, levels: { event: 'trace' } },
	async (ctx: C.Db & MEC.Ctx & CS.AbortSignal, opts: CHAT.InterpolationOptions, ..._matches: number[]) => {
		const byMatch = await getFeedEventsForMatches(ctx, ..._matches)
		const enriched: CHAT.EventEnriched[] = []
		for (const events of byMatch.values()) {
			const state = CHAT.getInitialChatState()
			for (const event of events) CHAT.handleEvent(state, event, opts)
			enriched.push(...state.eventBuffer)
		}
		return enriched
	},
)

/**
 * Put players back on the events a replay could not resolve them for.
 *
 * Interpolation NOOPs an event whose players are missing from the replayed roster, which is every event of a match
 * that only survives as retained rows. The raw event is revived with minimal players -- name from the players
 * table, no team or squad -- on the fields interpolation reads.
 *
 * A suppressed event is never revived, since that would undo the suppression, so `keepSuppressed` only decides
 * whether it stays as the NOOP it is. A results page keeps it: it is a hit, the index having no idea a pattern
 * matches it, and dropping it would leave the page short of its own result count, so the renderer stands a
 * placeholder in for it (see RenderCtx.placeholderUndrawn). A feed drops it, as the live feed does.
 */
export async function reviveNoops(
	ctx: C.Db,
	events: CHAT.EventEnriched[],
	opts: { keepSuppressed: boolean },
): Promise<CHAT.EventEnriched[]> {
	const playerFieldsOf = (type: string) =>
		(CHAT.Wire.FIELDS as Record<string, { players?: readonly string[]; playerLists?: readonly string[] }>)[type]
	const revivable = (e: CHAT.EventEnriched): e is CHAT.NoopEvent => e.type === 'NOOP' && e.cause === 'unresolved'
	// everything a revival pass does not touch, which after it is only the suppressed NOOPs
	const kept = (e: CHAT.EventEnriched) => opts.keepSuppressed || e.type !== 'NOOP'

	const missing = new Set<string>()
	for (const event of events) {
		if (!revivable(event)) continue
		const original = event.originalEvent as unknown as Record<string, unknown>
		const fields = playerFieldsOf(event.originalEvent.type)
		for (const key of fields?.players ?? []) {
			if (typeof original[key] === 'string') missing.add(original[key])
		}
		for (const key of fields?.playerLists ?? []) {
			for (const id of Array.isArray(original[key]) ? (original[key] as unknown[]) : []) {
				if (typeof id === 'string') missing.add(id)
			}
		}
	}
	if (missing.size === 0) return events.filter((e) => !revivable(e) && kept(e))

	const nameRows = await ctx
		.db()
		.select({ eosId: Schema.players.eosId, username: Schema.players.username, steamId: Schema.players.steamId })
		.from(Schema.players)
		.where(E.inArray(Schema.players.eosId, [...missing]))
	const names = new Map(nameRows.map((r) => [r.eosId, r]))
	const synth = (value: unknown) => {
		if (typeof value !== 'string') return value
		const row = names.get(value)
		return {
			ids: { eos: value, username: row?.username ?? value, steam: row?.steamId?.toString() },
			teamId: null,
			squadId: null,
			isLeader: false,
			isAdmin: false,
			role: '',
		} satisfies SM.Player
	}

	const out: CHAT.EventEnriched[] = []
	for (const event of events) {
		if (!revivable(event)) {
			if (kept(event)) out.push(event)
			continue
		}
		const fields = playerFieldsOf(event.originalEvent.type)
		if (!fields) continue
		const revived = { ...(event.originalEvent as unknown as Record<string, unknown>) }
		for (const key of fields.players ?? []) {
			if (revived[key] !== undefined && revived[key] !== null) revived[key] = synth(revived[key])
		}
		for (const key of fields.playerLists ?? []) {
			if (Array.isArray(revived[key])) revived[key] = (revived[key] as unknown[]).map(synth)
		}
		out.push(revived as unknown as CHAT.EventEnriched)
	}
	return out
}
