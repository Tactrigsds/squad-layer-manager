import * as Schema from '$root/drizzle/schema'
import * as SchemaModels from '$root/drizzle/schema.models'
import * as Arr from '@/lib/array'
import { toAsyncGenerator, withAbortSignal } from '@/lib/async'
import type * as Cleanup from '@/lib/cleanup'
import { superjsonify, unsuperjsonify } from '@/lib/drizzle'
import { IsolatedSubject } from '@/lib/isolated-subject'
import { LRUMap } from '@/lib/lru-map'
import { addReleaseTask } from '@/lib/nodejs-reentrant-mutexes'
import type { Parts } from '@/lib/types'
import * as Messages from '@/messages'
import * as BAL from '@/models/balance-triggers.models'
import * as CHAT from '@/models/chat.models'
import * as CS from '@/models/context-shared'
import * as L from '@/models/layer'
import * as LOG from '@/models/logs'
import * as MH from '@/models/match-history.models'
import * as ATTRS from '@/models/otel-attrs'
import * as SE from '@/models/server-events.models'

import type * as USR from '@/models/users.models'
import * as C from '@/server/context'
import * as DB from '@/server/db'
import { initModule } from '@/server/logger'
import { getOrpcBase } from '@/server/orpc-base'
import * as Settings from '@/systems/settings.server'
import * as SquadServer from '@/systems/squad-server.server'
import * as UsersClient from '@/systems/users.server'
import { Mutex } from 'async-mutex'

import { sql } from 'drizzle-orm'
import * as E from 'drizzle-orm'
import { alias } from 'drizzle-orm/sqlite-core'
import * as Rx from 'rxjs'
import { z } from 'zod'

const module = initModule('match-history')
let log!: CS.Logger
const orpcBase = getOrpcBase(module)

export function setup() {
	log = module.getLogger()
}

export type MatchHistoryContext = {
	mtx: Mutex
	update$: Rx.Subject<void>
	dispatchUpdate: () => void
	recentMatches: MH.MatchDetails[]
	recentBalanceTriggerEvents: BAL.BalanceTriggerEvent[]

	// matchId -> events
	matchEventsCache: LRUMap<number, Promise<CHAT.EventEnriched[]>>
} & Parts<USR.UserPart>

export function initMatchHistoryContext(event$: SquadServer.SquadServer['event$'], cleanup: Cleanup.Tasks): MatchHistoryContext {
	const update$ = new IsolatedSubject<void>()
	const ctx: MatchHistoryContext = {
		mtx: new Mutex(),
		update$,
		// we have to define this separately because we're passing it to withAcquired, which dedupes release tasks by reference equality. that means we have to define this once here and not reference update$ in a closure instead. Convoluted I know but what else is new :shrug:
		dispatchUpdate: () => update$.next(),
		parts: { users: [] },
		recentMatches: [],
		recentBalanceTriggerEvents: [],
		matchEventsCache: new LRUMap(500),
	}

	event$.pipe(
		Rx.filter(([ctx, e]) => e.type === 'ROUND_ENDED'),
		C.durableSub('onRoundEnded', { module }, async ([_ctx, e], signal) => {
			const ctx = { ..._ctx, signal }
			if (e.type !== 'ROUND_ENDED' || e.matchId !== (await getCurrentMatch(ctx)).historyEntryId) return
			await finalizeCurrentMatch(ctx, e.outcome, new Date(e.time))
		}),
	).subscribe()

	cleanup.push(ctx.update$, ctx.mtx)

	return ctx
}

export function getPublicMatchHistoryState(ctx: C.MatchHistory): MH.PublicMatchHistoryState & Parts<USR.UserPart> {
	const state = ctx.matchHistory
	return {
		recentMatches: state.recentMatches,
		recentBalanceTriggerEvents: state.recentBalanceTriggerEvents,
		parts: state.parts,
	}
}

export const loadState = C.spanOp(
	'loadState',
	{ module },
	async (ctx: C.Db & C.MatchHistory & CS.AbortSignal, opts?: { startAtOrdinal?: number }) => {
		const state = ctx.matchHistory
		const startAtOrdinal = opts?.startAtOrdinal ?? 0
		const recentMatchesCte = ctx.db().$with('recent_matches').as(
			ctx.db().select().from(Schema.matchHistory).where(
				E.and(
					E.gte(Schema.matchHistory.ordinal, startAtOrdinal),
					E.eq(Schema.matchHistory.serverId, ctx.serverId),
				),
			).orderBy(E.desc(Schema.matchHistory.ordinal)).limit(MH.MAX_RECENT_MATCHES),
		)

		const [rows, balanceTriggerRows, eventRows] = await Promise.all([
			ctx.db().with(recentMatchesCte).select().from(recentMatchesCte)
				.leftJoin(Schema.users, E.eq(recentMatchesCte.setByUserId, Schema.users.discordId)),
			ctx.db().with(recentMatchesCte).select({
				balanceTriggerEvents: Schema.balanceTriggerEvents,
			}).from(Schema.balanceTriggerEvents)
				.innerJoin(recentMatchesCte, E.eq(Schema.balanceTriggerEvents.matchTriggeredId, recentMatchesCte.id)),
			ctx.db().with(recentMatchesCte).select({
				serverEvents: Schema.serverEvents,
				matchId: recentMatchesCte.id,
			}).from(Schema.serverEvents)
				.innerJoin(recentMatchesCte, E.eq(Schema.serverEvents.matchId, recentMatchesCte.id)),
		])

		log.info(
			'found %d match history rows, %d balance trigger events, %d server events',
			rows.length,
			balanceTriggerRows.length,
			eventRows.length,
		)

		rows.reverse()
		const currentMatchId = rows[rows.length - 1]?.recent_matches.id
		state.recentMatches = state.recentMatches.filter(match => match.ordinal < startAtOrdinal).map(m => ({
			...m,
			isCurrentMatch: m.historyEntryId === currentMatchId,
		}))
		for (const row of rows) {
			const isCurrentMatch = row.recent_matches.id === currentMatchId!
			// @ts-expect-error idgaf
			const details = MH.matchHistoryEntryToMatchDetails(unsuperjsonify(Schema.matchHistory, row.recent_matches), isCurrentMatch)
			state.recentMatches.push(details)

			if (row.users) {
				const user = await UsersClient.buildUser(row.users)
				Arr.upsertOn(state.parts.users, user, 'discordId')
			}
		}

		for (const row of balanceTriggerRows) {
			Arr.upsertOn(state.recentBalanceTriggerEvents, unsuperjsonify(Schema.balanceTriggerEvents, row.balanceTriggerEvents), 'id')
		}

		if (state.recentMatches.length > MH.MAX_RECENT_MATCHES) {
			state.recentMatches = state.recentMatches.slice(state.recentMatches.length - MH.MAX_RECENT_MATCHES, state.recentMatches.length)
		}

		// Prime matchEventsCache for all recent matches (skip current match - events are still being generated)
		const matchIdsToPrime = state.recentMatches
			.filter(match => !match.isCurrentMatch && !state.matchEventsCache.has(match.historyEntryId))
			.map(match => match.historyEntryId)
		if (matchIdsToPrime.length > 0) {
			// getEventsForMatches populates the cache internally with a single batched query
			void getEventsForMatches(ctx, ...matchIdsToPrime)
		}
	},
)

export const getRecentMatches = C.spanOp('getRecentMatches', {
	module,
	levels: { event: 'trace' },
	mutexes: (ctx) => ctx.matchHistory.mtx,
}, async (ctx: C.MatchHistory & CS.AbortSignal) => {
	return ctx.matchHistory.recentMatches
})

export const getCurrentMatch = C.spanOp('getCurrentMatch', {
	module,
	levels: { event: 'trace' },
	mutexes: (ctx) => ctx.matchHistory.mtx,
}, async (ctx: C.MatchHistory & CS.AbortSignal) => {
	return ctx.matchHistory.recentMatches[ctx.matchHistory.recentMatches.length - 1]
})

export const getMatchById = C.spanOp('getMatchById', {
	module,
	levels: { event: 'trace' },
	mutexes: (ctx) => ctx.matchHistory.mtx,
}, async (ctx: C.MatchHistory & CS.AbortSignal, matchId: number) => {
	const match = ctx.matchHistory.recentMatches.find(m => m.historyEntryId === matchId)
	if (!match) return null
	return match
})

const loadCurrentMatch = C.spanOp(
	'loadCurrentMatch',
	{ module, levels: { event: 'info' }, mutexes: (ctx) => ctx.matchHistory.mtx },
	async (ctx: C.Db & C.MatchHistory & CS.AbortSignal, _opts?: { forUpdate?: boolean }) => {
		const query = ctx.db().select().from(Schema.matchHistory).where(E.eq(Schema.matchHistory.serverId, ctx.serverId)).orderBy(
			E.desc(Schema.matchHistory.ordinal),
		).limit(1)
		const [match] = await query
		if (!match) return null
		return MH.matchHistoryEntryToMatchDetails(match, true)
	},
)

export const matchHistoryRouter = {
	watchMatchHistoryState: orpcBase.meta({ logLevel: 'trace' }).input(z.object({ serverId: z.string() })).handler(async function*(
		{ signal, context: _ctx, input },
	) {
		const server$ = SquadServer.sliceCtx$(_ctx.wsClientId, input.serverId).pipe(withAbortSignal(signal!))
		const state$ = server$.pipe(
			Rx.switchMap(async function*(ctx) {
				if (!ctx) return
				const serverId = ctx.serverId
				yield getPublicMatchHistoryState(ctx)
				const historyUpdate$ = ctx.matchHistory.update$.pipe(withAbortSignal(signal!))
				for await (const _ of toAsyncGenerator(historyUpdate$)) {
					yield getPublicMatchHistoryState(SquadServer.resolveSliceCtx({}, serverId))
				}
			}),
			withAbortSignal(signal!),
		)

		yield* toAsyncGenerator(state$)
	}),

	getMatchEvents: orpcBase.input(z.object({ serverId: z.string(), ordinal: z.number() })).handler(async ({ input, context: _ctx }) => {
		const ordinal = input.ordinal
		const ctx = SquadServer.resolveSliceCtx(_ctx, input.serverId)

		// Check if trying to get events for current match - this should never happen
		const currentMatch = await getCurrentMatch(ctx)
		if (currentMatch && currentMatch.ordinal === ordinal) {
			throw new Error(`Cannot call getMatchEvents for current match (ordinal ${ordinal}). Use live event stream instead.`)
		}

		let match = ctx.matchHistory.recentMatches.find(m => ctx.serverId === m.serverId && m.ordinal === ordinal)
		let previousMatch = ctx.matchHistory.recentMatches.find(m => ctx.serverId === m.serverId && m.ordinal === ordinal - 1)

		if (!match || !previousMatch) {
			const ordinalsToFetch: number[] = []
			if (!match) ordinalsToFetch.push(ordinal)
			if (!previousMatch) ordinalsToFetch.push(ordinal - 1)

			const matchesRaw = await ctx.db().select().from(Schema.matchHistory).where(
				E.and(
					E.eq(Schema.matchHistory.serverId, ctx.serverId),
					E.inArray(Schema.matchHistory.ordinal, ordinalsToFetch),
				),
			)

			for (const matchRaw of matchesRaw) {
				if (matchRaw.ordinal === ordinal && !match) {
					match = MH.matchHistoryEntryToMatchDetails(matchRaw, false)
				} else if (matchRaw.ordinal === ordinal - 1 && !previousMatch) {
					previousMatch = MH.matchHistoryEntryToMatchDetails(matchRaw, false)
				}
			}
		}

		if (!match) {
			throw new Error(`Match with ordinal ${ordinal} not found`)
		}

		const events = await getEventsForMatches(ctx, match.historyEntryId)

		return {
			events,
			previousOrdinal: previousMatch?.ordinal,
		}
	}),

	getPlayerDetails: orpcBase.input(z.object({
		serverId: z.string(),
		playerId: z.string(),
	})).handler(async ({ input, context: _ctx }) => {
		const ctx = SquadServer.resolveSliceCtx(_ctx, input.serverId)
		const playerId = input.playerId

		// Most recent connection event, for the connection status indicator. PLAYER_RECONCILED counts as a
		// connection: the player is present (backfilled from the teams poll) even if we never saw their join log.
		const connectionRows = await ctx.db()
			.select({ type: Schema.serverEvents.type, time: Schema.serverEvents.time })
			.from(Schema.serverEvents)
			.innerJoin(
				Schema.playerEventAssociations,
				E.and(
					E.eq(Schema.serverEvents.id, Schema.playerEventAssociations.serverEventId),
					E.eq(Schema.playerEventAssociations.playerId, playerId),
				),
			)
			.where(E.inArray(Schema.serverEvents.type, ['PLAYER_CONNECTED', 'PLAYER_RECONCILED', 'PLAYER_DISCONNECTED']))
			.orderBy(E.desc(Schema.serverEvents.time))
			.limit(1)

		const lastConnectionEvent = connectionRows[0]
		const connectionStatus: { status: 'online'; connectedSince: number } | { status: 'offline'; lastSeen: number | null } =
			lastConnectionEvent?.type === 'PLAYER_CONNECTED' || lastConnectionEvent?.type === 'PLAYER_RECONCILED'
				? { status: 'online', connectedSince: lastConnectionEvent.time.getTime() }
				: lastConnectionEvent?.type === 'PLAYER_DISCONNECTED'
				? { status: 'offline', lastSeen: lastConnectionEvent.time.getTime() }
				: { status: 'offline', lastSeen: null }

		return { connectionStatus }
	}),

	// Player-specific events sourced entirely from matchEventsCache (already-enriched, cache-primed recent matches).
	// The current match is deliberately excluded: the client already has its events live via the chat feed. Pagination
	// counts player-specific events (NEW_GAME/RESET have no player association so they don't count toward pageSize), but
	// is aligned to match boundaries so pages never overlap. `cursor` is an exclusive upper-bound matchId.
	getPlayerEvents: orpcBase.input(z.object({
		serverId: z.string(),
		playerId: z.string(),
		cursor: z.number().optional(),
		pageSize: z.number().positive().default(100),
	})).handler(async ({ input, context: _ctx }) => {
		const ctx = SquadServer.resolveSliceCtx(_ctx, input.serverId)
		const currentMatch = await getCurrentMatch(ctx)
		const playerId = input.playerId

		const cachedMatchIds = ctx.matchHistory.recentMatches
			.filter(m => m.historyEntryId !== currentMatch?.historyEntryId)
			.map(m => m.historyEntryId)
		if (cachedMatchIds.length === 0) return { events: [] as CHAT.EventEnriched[], nextCursor: undefined }

		// per-match counts of player-specific events (game-participant assoc excluded so it counts only shown events)
		const matchCountRows = await ctx.db()
			.select({ matchId: Schema.serverEvents.matchId, count: E.count() })
			.from(Schema.serverEvents)
			.innerJoin(
				Schema.playerEventAssociations,
				E.and(
					E.eq(Schema.serverEvents.id, Schema.playerEventAssociations.serverEventId),
					E.eq(Schema.playerEventAssociations.playerId, playerId),
					E.ne(Schema.playerEventAssociations.assocType, SchemaModels.SERVER_EVENT_PLAYER_ASSOC_TYPE.enum['game-participant']),
				),
			)
			.where(E.inArray(Schema.serverEvents.matchId, cachedMatchIds))
			.groupBy(Schema.serverEvents.matchId)

		// most-recent match first (matchId is monotonic with recency)
		const matchesWithEvents = matchCountRows
			.map(r => ({ matchId: r.matchId, count: r.count }))
			.sort((a, b) => b.matchId - a.matchId)

		let index = input.cursor === undefined ? 0 : matchesWithEvents.findIndex(m => m.matchId < input.cursor!)
		if (index === -1) index = matchesWithEvents.length

		const includedMatchIds: number[] = []
		let count = 0
		for (; index < matchesWithEvents.length; index++) {
			const m = matchesWithEvents[index]
			includedMatchIds.push(m.matchId)
			count += m.count
			if (count >= input.pageSize) {
				index++
				break
			}
		}
		if (includedMatchIds.length === 0) return { events: [] as CHAT.EventEnriched[], nextCursor: undefined }

		const nextCursor = index < matchesWithEvents.length ? includedMatchIds[includedMatchIds.length - 1] : undefined

		const enriched = await getEventsForMatches(ctx, ...includedMatchIds)
		const events = enriched
			.filter(e => e.type === 'NEW_GAME' || CHAT.hasAssocPlayer(e, playerId))
			.sort((a, b) => a.time - b.time)

		return { events, nextCursor }
	}),

	getSquadDetails: orpcBase.input(z.object({
		serverId: z.string(),
		uniqueSquadId: z.number(),
	})).handler(async ({ input, context: _ctx }) => {
		const ctx = SquadServer.resolveSliceCtx(_ctx, input.serverId)

		const [squadRow] = await ctx.db().select().from(Schema.squads).where(E.eq(Schema.squads.id, input.uniqueSquadId))
		if (!squadRow) throw new Error(`Squad ${input.uniqueSquadId} not found`)

		const associatedPlayers = alias(Schema.playerEventAssociations, 'associatedPlayers')

		const rawEventRows = await ctx.db()
			.select({
				playerAssoc: associatedPlayers.playerId,
				matchId: Schema.serverEvents.matchId,
				eventId: Schema.serverEvents.id,
			})
			.from(Schema.serverEvents)
			.innerJoin(
				Schema.squadEventAssociations,
				E.and(
					E.eq(Schema.serverEvents.id, Schema.squadEventAssociations.serverEventId),
					E.eq(Schema.squadEventAssociations.squadId, input.uniqueSquadId),
				),
			)
			.leftJoin(associatedPlayers, E.eq(Schema.serverEvents.id, associatedPlayers.serverEventId))
			.orderBy(E.desc(Schema.serverEvents.time))

		const otherPlayers = new Set<string>()
		for (const row of rawEventRows) {
			if (row.playerAssoc) otherPlayers.add(row.playerAssoc)
		}
		if (squadRow.creatorId) otherPlayers.add(squadRow.creatorId)

		const matchId = rawEventRows[0]?.matchId
		if (matchId === undefined) {
			return { squad: squadRow, events: [] }
		}

		const eventRows = await ctx.db()
			.select({ event: Schema.serverEvents })
			.from(Schema.serverEvents)
			.where(
				E.and(
					E.eq(Schema.serverEvents.matchId, matchId),
					E.or(
						otherPlayers.size > 0
							? E.inArray(Schema.playerEventAssociations.playerId, [...otherPlayers.values()])
							: sql`1=0`,
						E.inArray(Schema.squadEventAssociations.squadId, [input.uniqueSquadId]),
						E.eq(Schema.serverEvents.type, 'NEW_GAME'),
					),
				),
			)
			.innerJoin(Schema.playerEventAssociations, E.eq(Schema.serverEvents.id, Schema.playerEventAssociations.serverEventId))
			.leftJoin(Schema.squadEventAssociations, E.eq(Schema.serverEvents.id, Schema.squadEventAssociations.serverEventId))
			.orderBy(E.desc(Schema.serverEvents.id))

		const events = eventRows.map((row) => SE.fromEventRow(row.event)).toReversed()
		const state = CHAT.getInitialChatState()
		const processedEvents = new Set<number>()
		for (const event of events) {
			if (processedEvents.has(event.id)) continue
			processedEvents.add(event.id)
			CHAT.handleEvent(state, event)
		}

		return {
			squad: squadRow,
			events: state.eventBuffer.filter((event) => CHAT.isSquadFeedEvent(event, input.uniqueSquadId, false)),
		}
	}),
}

export const addNewCurrentMatch = C.spanOp(
	'addNewCurrentMatch',
	{ module, levels: { event: 'info' }, mutexes: (ctx) => [ctx.matchHistory.mtx, ctx.server.savingEventsMtx] },
	async (
		ctx: C.Db & C.MatchHistory & C.SquadServer & CS.AbortSignal,
		entry: Omit<SchemaModels.NewMatchHistory, 'ordinal' | 'serverId'>,
	) => {
		await DB.runTransaction(ctx, async (ctx) => {
			const currentMatch = await loadCurrentMatch(ctx, { forUpdate: true })
			const ordinal = currentMatch ? currentMatch.ordinal + 1 : 0
			await ctx.db().insert(Schema.matchHistory).values(
				superjsonify(Schema.matchHistory, { ...entry, ordinal, serverId: ctx.serverId }),
			)

			// write event buffer since we're about to flush it
			await SquadServer.saveEvents(ctx)
			ctx.server.lastSavedEventId = null
			// flush the events buffer

			ctx.server.emittedEvents = []

			await loadState(ctx, { startAtOrdinal: ordinal })
			addReleaseTask(ctx.matchHistory.dispatchUpdate)
		})

		return { code: 'ok' as const, match: await getCurrentMatch(ctx) }
	},
)

export const finalizeCurrentMatch = C.spanOp('finalizeCurrentMatch', {
	module,
	levels: { event: 'info' },
	mutexes: (ctx) => ctx.matchHistory.mtx,
	attrs: (_, currentLayerId) => ({
		[ATTRS.MatchHistory.CURRENT_LAYER_ID]: currentLayerId,
	}),
}, async (
	ctx: C.Db & C.MatchHistory & CS.AbortSignal,
	outcome: MH.MatchOutcome,
	time: Date,
) => {
	const res = await DB.runTransaction(ctx, async ctx => {
		const currentMatch = await loadCurrentMatch(ctx, { forUpdate: true })
		if (!currentMatch) return { code: 'err:no-match-found' as const, message: 'No match found' }
		if (currentMatch.status !== 'in-progress') {
			log.warn('unable to update current history entry: not in-progress')
			return { code: 'err:match-not-in-progress' as const, message: 'Match not in progress' }
		}

		const update = {
			endTime: time,
			outcome: outcome.type === 'unknown' ? null : outcome.type,
			team1Tickets: (outcome.type === 'team1' || outcome.type === 'team2') ? outcome.team1Tickets : undefined,
			team2Tickets: (outcome.type === 'team1' || outcome.type === 'team2') ? outcome.team2Tickets : undefined,
		}

		await ctx.db().update(Schema.matchHistory).set(superjsonify(Schema.matchHistory, update)).where(
			E.eq(Schema.matchHistory.id, currentMatch.historyEntryId),
		)
		await loadState(ctx, { startAtOrdinal: currentMatch.ordinal })

		// -------- look for tripped balance triggers --------
		for (const [trigId, level] of Object.entries(Settings.GLOBAL_SETTINGS.balanceTriggerLevels)) {
			let inputStored: any
			const trig = BAL.TRIGGERS[trigId as BAL.TriggerId]
			try {
				log.info('Evaluating trigger %s', trig.id)
				const input = trig.resolveInput({ history: ctx.matchHistory.recentMatches })
				inputStored = input
				const res = trig.evaluate({ ...CS.init(), ...ctx, log: LOG.getSubmoduleLogger(`balance-trigger-eval::${trig.id}`, log) }, input)
				if (!res) continue
				const event = {
					strongerTeam: res.strongerTeam,
					level: level,
					triggerId: trig.id,
					triggerVersion: trig.version,
					matchTriggeredId: currentMatch.historyEntryId,
					evaluationResult: res,
				}
				const [{ id }] = await ctx.db().insert(Schema.balanceTriggerEvents)
					.values(superjsonify(Schema.balanceTriggerEvents, event))
					.returning({ id: Schema.balanceTriggerEvents.id })
				log.info(
					'Trigger %s fired: message: "%s"',
					trig.id,
					Messages.GENERAL.balanceTrigger.showEvent({ ...event, id }, currentMatch, false),
				)
			} catch (err) {
				log.error(err, 'Error evaluating trigger %s input: %s', trig.id, JSON.stringify(inputStored ?? null))
			}
		}
		await loadState(ctx, { startAtOrdinal: currentMatch.ordinal })
		return { code: 'ok' as const }
	})
	if (res.code !== 'ok') return res
	addReleaseTask(ctx.matchHistory.dispatchUpdate)
	return { ...res }
})

/**
 * Runs when rcon is connected to ensure that the match history is up-to-date. If the current layer is unexpected then we insert a new history entry for the current match.
 * Also always loads the match history state.
 */
export const syncWithCurrentLayer = C.spanOp(
	'syncWithCurrentLayer',
	{ module, levels: { event: 'info' }, mutexes: (ctx) => ctx.matchHistory.mtx },
	async (ctx: C.Db & C.MatchHistory & C.SquadServer & CS.AbortSignal, _currentLayerOnServer: L.UnvalidatedLayer | L.LayerId) => {
		const currentLayerOnServer = L.toLayer(_currentLayerOnServer)
		return await DB.runTransaction(ctx, async ctx => {
			const currentMatch = await loadCurrentMatch(ctx, { forUpdate: true })
			if (currentMatch && L.areLayersCompatible(currentMatch.layerId, currentLayerOnServer)) {
				log.info(
					'Current layer %s, is compatible with previously recorded layer %s (%s)',
					currentLayerOnServer.id,
					currentMatch.layerId,
					currentMatch.historyEntryId,
				)
				await loadState(ctx)
				addReleaseTask(ctx.matchHistory.dispatchUpdate)
				return { pushedNewMatch: false, currentMatch }
			} else {
				log.info(
					'Current layer %s, is not compatible with previously recorded layer %s (%s)',
					currentLayerOnServer.id,
					currentMatch?.layerId,
					currentMatch?.historyEntryId ?? 'unknown',
				)
			}
			const ordinal = currentMatch ? currentMatch.ordinal + 1 : 0
			await ctx.db().insert(Schema.matchHistory).values(superjsonify(Schema.matchHistory, {
				serverId: ctx.serverId,
				layerId: currentLayerOnServer.id,
				ordinal,
				setByType: 'unknown',
			}))
			await loadState(ctx)
			addReleaseTask(ctx.matchHistory.dispatchUpdate)
			{
				const currentMatch = await getCurrentMatch(ctx)
				log.info('loaded new current match %s, %d', currentMatch.layerId, currentMatch.historyEntryId)
				return { pushedNewMatch: true, currentMatch }
			}
		})
	},
)

const getEventsForMatches = C.spanOp(
	'getEventsForMatches',
	{ module, levels: { event: 'trace' } },
	async (ctx: C.Db & C.MatchHistory & CS.AbortSignal, ..._matches: number[]) => {
		const matches = _matches.toSorted((a, b) => a - b)

		const ops = new Map<number, Promise<CHAT.EventEnriched[]>>()
		const uncached: number[] = []
		for (const matchId of matches) {
			const cachedEvents$ = ctx.matchHistory.matchEventsCache.get(matchId)
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
					for (const rawEvent of rowsByMatch.get(matchId) ?? []) {
						const event = SE.fromEventRow(rawEvent)
						CHAT.handleEvent(state, event)
					}
					eventsByMatch.set(matchId, state.eventBuffer)
				}
				return eventsByMatch
			})()
			batch$.catch(() => {
				for (const matchId of uncached) ctx.matchHistory.matchEventsCache.delete(matchId)
			})
			for (const matchId of uncached) {
				const events$ = batch$.then(eventsByMatch => eventsByMatch.get(matchId)!)
				ctx.matchHistory.matchEventsCache.set(matchId, events$)
				ops.set(matchId, events$)
			}
		}

		const allEvents = (await Promise.all(matches.map(matchId => ops.get(matchId)!))).flat()
		return allEvents
	},
)
