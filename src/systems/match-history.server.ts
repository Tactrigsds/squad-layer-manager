import { Mutex } from 'async-mutex'
import * as E from 'drizzle-orm'
import { z } from 'zod'

import * as Schema from '$root/drizzle/schema'
import type * as SchemaModels from '$root/drizzle/schema.models'
import * as Arr from '@/lib/array-utils'
import type * as Cleanup from '@/lib/cleanup'
import { superjsonify, unsuperjsonify } from '@/lib/drizzle'
import { IsolatedSubject } from '@/lib/isolated-subject'
import { addReleaseTask } from '@/lib/nodejs-reentrant-mutexes'
import * as Rx from '@/lib/rxjs'
import type { Parts } from '@/lib/types'
import * as CHAT from '@/models/chat.models'
import type * as CS from '@/models/context-shared'
import * as L from '@/models/layer'
import type * as MEC from '@/models/match-events-cache.models'
import * as MH from '@/models/match-history.models'
import * as ATTRS from '@/models/otel-attrs'
import type * as SQS from '@/models/squad-server.models'
import type * as USR from '@/models/users.models'
import type * as C from '@/server/context'
import * as DB from '@/server/db'
import * as Instr from '@/server/instrumentation'
import { initModule } from '@/server/logger'
import { getOrpcBase } from '@/server/orpc-base'
import * as MatchEventsCache from '@/systems/match-events-cache.server'
import * as Settings from '@/systems/settings.server'
import * as SquadServer from '@/systems/squad-server.server'
import * as UsersClient from '@/systems/users.server'

const module = initModule('match-history')
let log!: CS.Logger
const orpcBase = getOrpcBase(module)

export function setup() {
	log = module.getLogger()
}

export function initMatchHistoryContext(event$: SQS.Ctx.Payload['event$'], cleanup: Cleanup.Tasks): MH.Ctx.Payload {
	const update$ = new IsolatedSubject<void>()
	const ctx: MH.Ctx.Payload = {
		mtx: new Mutex(),
		update$,
		// we have to define this separately because we're passing it to withAcquired, which dedupes release tasks by reference equality. that means we have to define this once here and not reference update$ in a closure instead. Convoluted I know but what else is new :shrug:
		dispatchUpdate: () => update$.next(),
		parts: { users: [] },
		recentMatches: [],
		finalized$: new IsolatedSubject<{ matchId: number }>(),
	}

	event$
		.pipe(
			Rx.filter(([ctx, e]) => e.type === 'ROUND_ENDED'),
			Instr.durableSub('onRoundEnded', { module }, async ([evtCtx, e], signal) => {
				const ctx = SquadServer.eventCtx(evtCtx, signal)
				if (e.type !== 'ROUND_ENDED' || e.matchId !== (await getCurrentMatch(ctx)).historyEntryId) return
				await finalizeCurrentMatch(ctx, e.outcome, new Date(e.time))
			}),
		)
		.subscribe()

	cleanup.push(ctx.update$, ctx.finalized$, ctx.mtx)

	return ctx
}

/** The recent window plus the user records its entries refer to. Read directly, no mutex. */
export function getPublicMatchHistoryState(ctx: MH.Ctx): MH.PublicMatchHistoryState & Parts<USR.UserPart> {
	const state = ctx.matchHistory
	return {
		recentMatches: state.recentMatches,
		parts: state.parts,
	}
}

export const loadState = Instr.spanOp(
	'loadState',
	{ module },
	async (ctx: C.Db & MH.Ctx & MEC.Ctx & CS.AbortSignal, opts?: { startAtOrdinal?: number }) => {
		const state = ctx.matchHistory
		const startAtOrdinal = opts?.startAtOrdinal ?? 0
		const recentMatchesCte = ctx
			.db()
			.$with('recent_matches')
			.as(
				ctx
					.db()
					.select()
					.from(Schema.matchHistory)
					.where(E.and(E.gte(Schema.matchHistory.ordinal, startAtOrdinal), E.eq(Schema.matchHistory.serverId, ctx.serverId)))
					.orderBy(E.desc(Schema.matchHistory.ordinal))
					.limit(MH.MAX_RECENT_MATCHES),
			)

		const rows = await ctx
			.db()
			.with(recentMatchesCte)
			.select()
			.from(recentMatchesCte)
			.leftJoin(Schema.users, E.eq(recentMatchesCte.setByUserId, Schema.users.discordId))
			.leftJoin(Schema.discordAccounts, E.eq(Schema.users.discordId, Schema.discordAccounts.discordId))

		log.info('found %d match history rows', rows.length)

		rows.reverse()
		const currentMatchId = rows[rows.length - 1]?.recent_matches.id
		state.recentMatches = state.recentMatches
			.filter((match) => match.ordinal < startAtOrdinal)
			.map((m) => ({
				...m,
				isCurrentMatch: m.historyEntryId === currentMatchId,
			}))
		const userRows = new Map<bigint, UsersClient.DbUser>()
		for (const row of rows) {
			const isCurrentMatch = row.recent_matches.id === currentMatchId!
			// @ts-expect-error idgaf
			const details = MH.matchHistoryEntryToMatchDetails(unsuperjsonify(Schema.matchHistory, row.recent_matches), isCurrentMatch)
			state.recentMatches.push(details)

			if (row.users && row.discordAccounts) {
				userRows.set(row.users.discordId, { ...row.users, username: row.discordAccounts.username })
			}
		}

		// buildUser reaches the Discord REST API, which yields to the event loop. Enriching here would hold the
		// process-wide transaction lock across a network round trip, so defer it: recentMatches reference users by
		// setByUserId, not by embedding, and parts.users is display-only, so it can fill in after commit.
		if (userRows.size > 0) {
			addReleaseTask(async () => {
				const users = await UsersClient.buildUsers([...userRows.values()])
				for (const user of users) Arr.upsertOn(state.parts.users, user, 'discordId')
				state.dispatchUpdate()
			})
		}

		if (state.recentMatches.length > MH.MAX_RECENT_MATCHES) {
			state.recentMatches = state.recentMatches.slice(state.recentMatches.length - MH.MAX_RECENT_MATCHES, state.recentMatches.length)
		}

		// Prime the newest matches the cache can hold (skip the current match - its events are still being generated)
		const matchIdsToPrime = state.recentMatches
			.filter((match) => !match.isCurrentMatch && !ctx.matchEventsCache.events.has(match.historyEntryId))
			.slice(-MatchEventsCache.MAX_CACHED_MATCHES)
			.map((match) => match.historyEntryId)
		if (matchIdsToPrime.length > 0) {
			// getFeedEventsForMatches populates the cache internally with a single batched query
			void MatchEventsCache.getFeedEventsForMatches(ctx, ...matchIdsToPrime)
		}
	},
)

// Otherwise nothing populates match history until rcon connects and syncs, and a server whose rcon never connects
// has none for its whole life -- while the managed server is live from initialization and every reader of
// getCurrentMatch assumes a current match exists.
export const initState = Instr.spanOp(
	'initState',
	{ module, levels: { event: 'info' }, mutexes: (ctx) => [ctx.matchHistory.mtx] },
	async (ctx: C.Db & MH.Ctx & MEC.Ctx & CS.AbortSignal) => {
		await loadState(ctx)
		addReleaseTask(ctx.matchHistory.dispatchUpdate)
	},
)

/**
 * The in-memory window of recent matches for this server, oldest first, capped at
 * MAX_RECENT_MATCHES. The last entry is the current match, which may still be in progress.
 */
export const getRecentMatches = Instr.spanOp(
	'getRecentMatches',
	{
		module,
		levels: { event: 'trace' },
		mutexes: (ctx) => ctx.matchHistory.mtx,
	},
	async (ctx: MH.Ctx & CS.AbortSignal) => {
		return ctx.matchHistory.recentMatches
	},
)

/** The match in progress, or the most recently finished one. Undefined on a server with no history. */
export const getCurrentMatch = Instr.spanOp(
	'getCurrentMatch',
	{
		module,
		levels: { event: 'trace' },
		mutexes: (ctx) => ctx.matchHistory.mtx,
	},
	async (ctx: MH.Ctx & CS.AbortSignal) => {
		return ctx.matchHistory.recentMatches[ctx.matchHistory.recentMatches.length - 1]
	},
)

/** Looks only in the recent window, not the database: null for anything older than it holds. */
export const getMatchById = Instr.spanOp(
	'getMatchById',
	{
		module,
		levels: { event: 'trace' },
		mutexes: (ctx) => ctx.matchHistory.mtx,
	},
	async (ctx: MH.Ctx & CS.AbortSignal, matchId: number) => {
		const match = ctx.matchHistory.recentMatches.find((m) => m.historyEntryId === matchId)
		if (!match) return null
		return match
	},
)

const loadCurrentMatch = Instr.spanOp(
	'loadCurrentMatch',
	{ module, levels: { event: 'info' }, mutexes: (ctx) => ctx.matchHistory.mtx },
	async (ctx: C.Db & MH.Ctx & CS.AbortSignal, _opts?: { forUpdate?: boolean }) => {
		const query = ctx
			.db()
			.select()
			.from(Schema.matchHistory)
			.where(E.eq(Schema.matchHistory.serverId, ctx.serverId))
			.orderBy(E.desc(Schema.matchHistory.ordinal))
			.limit(1)
		const [match] = await query
		if (!match) return null
		return MH.matchHistoryEntryToMatchDetails(match, true)
	},
)

export const matchHistoryRouter = {
	watchMatchHistoryState: orpcBase
		.meta({ logLevel: 'trace' })
		.input(z.object({ serverId: z.string() }))
		.handler(async function* ({ signal, context: _ctx, input }) {
			const state$ = SquadServer.stream$(_ctx.wsClientId, input.serverId, (ctx) =>
				Rx.from(
					(async function* () {
						yield getPublicMatchHistoryState(ctx)
						const historyUpdate$ = ctx.matchHistory.update$.pipe(Rx.Ext.withAbortSignal(signal!))
						for await (const _ of Rx.Ext.toAsyncGenerator(historyUpdate$)) {
							yield getPublicMatchHistoryState(ctx)
						}
					})(),
				),
			).pipe(Rx.Ext.withAbortSignal(signal!))

			yield* Rx.Ext.toAsyncGenerator(state$)
		}),

	getMatchEvents: orpcBase.input(z.object({ serverId: z.string(), ordinal: z.number() })).handler(async ({ input, context: _ctx }) => {
		const ordinal = input.ordinal
		const ctxRes = await SquadServer.tryCtx(_ctx, input.serverId)
		if (ctxRes.code !== 'ok') return ctxRes
		const ctx = ctxRes.ctx

		// Check if trying to get events for current match - this should never happen
		const currentMatch = await getCurrentMatch(ctx)
		if (currentMatch && currentMatch.ordinal === ordinal) {
			throw new Error(`Cannot call getMatchEvents for current match (ordinal ${ordinal}). Use live event stream instead.`)
		}

		let match = ctx.matchHistory.recentMatches.find((m) => ctx.serverId === m.serverId && m.ordinal === ordinal)
		if (!match) {
			const [matchRaw] = await ctx
				.db()
				.select()
				.from(Schema.matchHistory)
				.where(E.and(E.eq(Schema.matchHistory.serverId, ctx.serverId), E.eq(Schema.matchHistory.ordinal, ordinal)))
			if (!matchRaw) throw new Error(`Match with ordinal ${ordinal} not found`)
			match = MH.matchHistoryEntryToMatchDetails(matchRaw, false)
		}

		// Replayed here, not on the client, so a past match reads exactly as the results feed reads it: the same
		// suppression patterns, the same folding, the same revival of events whose players are gone. Wire-encoded
		// because enrichment embeds a player object per event, which is most of what a busy match costs to send.
		const enriched = await MatchEventsCache.getEnrichedEventsForMatches(ctx, Settings.GLOBAL_SETTINGS.chat, match.historyEntryId)
		const events = await MatchEventsCache.reviveNoops(ctx, enriched, { keepSuppressed: false })

		return { events: CHAT.Wire.encode(events) }
	}),

	getPlayerDetails: orpcBase
		.input(
			z.object({
				serverId: z.string(),
				playerId: z.string(),
			}),
		)
		.handler(async ({ input, context: _ctx }) => {
			const ctxRes = await SquadServer.tryCtx(_ctx, input.serverId)
			if (ctxRes.code !== 'ok') return ctxRes
			const ctx = ctxRes.ctx
			const playerId = input.playerId

			// Most recent connection event, for the connection status indicator. PLAYER_RECONCILED counts as a
			// connection: the player is present (backfilled from the teams poll) even if we never saw their join log.
			const connectionRows = await ctx
				.db()
				.select({ type: Schema.playerEventIndex.type, time: Schema.playerEventIndex.time })
				.from(Schema.playerEventIndex)
				.where(
					E.and(
						E.eq(Schema.playerEventIndex.playerId, playerId),
						E.eq(Schema.playerEventIndex.serverId, input.serverId),
						E.inArray(Schema.playerEventIndex.type, ['PLAYER_CONNECTED', 'PLAYER_RECONCILED', 'PLAYER_DISCONNECTED']),
					),
				)
				.orderBy(E.desc(Schema.playerEventIndex.time))
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

	// Player-specific events are drawn from the enriched events of the recent matches, cached or re-read per page.
	// The current match is deliberately excluded: the client already has its events live via the chat feed. Pagination
	// counts player-specific events (NEW_GAME/RESET have no player association so they don't count toward pageSize), but
	// is aligned to match boundaries so pages never overlap. `cursor` is an exclusive upper-bound matchId.
	getSquadDetails: orpcBase
		.input(
			z.object({
				serverId: z.string(),
				uniqueSquadId: z.number(),
			}),
		)
		.handler(async ({ input, context: _ctx }) => {
			const ctxRes = await SquadServer.tryCtx(_ctx, input.serverId)
			if (ctxRes.code !== 'ok') return ctxRes
			const ctx = ctxRes.ctx

			const [squadRow] = await ctx.db().select().from(Schema.squads).where(E.eq(Schema.squads.id, input.uniqueSquadId))
			if (!squadRow) throw new Error(`Squad ${input.uniqueSquadId} not found`)
			if (squadRow.matchId === null) return { squad: squadRow, events: [] }

			// the whole match is replayed and then filtered, rather than the squad's events being selected out
			// first: a slice replays against a partial roster, and the match is already the unit everything else
			// reads and caches.
			const enriched = await MatchEventsCache.getEnrichedEventsForMatches(ctx, Settings.GLOBAL_SETTINGS.chat, squadRow.matchId)

			return {
				squad: squadRow,
				events: enriched.filter((event) => CHAT.isSquadFeedEvent(event, input.uniqueSquadId, false)),
			}
		}),
}

export const addNewCurrentMatch = Instr.spanOp(
	'addNewCurrentMatch',
	{ module, levels: { event: 'info' }, mutexes: (ctx) => [ctx.matchHistory.mtx] },
	async (ctx: C.Db & MH.Ctx & MEC.Ctx & SQS.Ctx & CS.AbortSignal, entry: Omit<SchemaModels.NewMatchHistory, 'ordinal' | 'serverId'>) => {
		await DB.runTransaction(ctx, async (ctx) => {
			const currentMatch = await loadCurrentMatch(ctx, { forUpdate: true })
			const ordinal = currentMatch ? currentMatch.ordinal + 1 : 0
			await ctx
				.db()
				.insert(Schema.matchHistory)
				.values(superjsonify(Schema.matchHistory, { ...entry, ...MH.layerParts(entry.layerId), ordinal, serverId: ctx.serverId }))

			// events are persisted as they're emitted, so the in-memory cache is just dropped; it only ever
			// holds the current match
			ctx.server.emittedEvents = []

			await loadState(ctx, { startAtOrdinal: ordinal })
			addReleaseTask(ctx.matchHistory.dispatchUpdate)
		})

		return { code: 'ok' as const, match: await getCurrentMatch(ctx) }
	},
)

export const finalizeCurrentMatch = Instr.spanOp(
	'finalizeCurrentMatch',
	{
		module,
		levels: { event: 'info' },
		mutexes: (ctx) => ctx.matchHistory.mtx,
		attrs: (_, currentLayerId) => ({
			[ATTRS.MatchHistory.CURRENT_LAYER_ID]: currentLayerId,
		}),
	},
	async (ctx: C.Db & MH.Ctx & MEC.Ctx & CS.AbortSignal, outcome: MH.MatchOutcome, time: Date) => {
		const res = await DB.runTransaction(ctx, async (ctx) => {
			const currentMatch = await loadCurrentMatch(ctx, { forUpdate: true })
			if (!currentMatch) return { code: 'err:no-match-found' as const, message: 'No match found' }
			if (currentMatch.status !== 'in-progress') {
				log.warn('unable to update current history entry: not in-progress')
				return { code: 'err:match-not-in-progress' as const, message: 'Match not in progress' }
			}

			const update = {
				endTime: time,
				outcome: outcome.type === 'unknown' ? null : outcome.type,
				team1Tickets: outcome.type === 'team1' || outcome.type === 'team2' ? outcome.team1Tickets : undefined,
				team2Tickets: outcome.type === 'team1' || outcome.type === 'team2' ? outcome.team2Tickets : undefined,
			}

			await ctx
				.db()
				.update(Schema.matchHistory)
				.set(superjsonify(Schema.matchHistory, update))
				.where(E.eq(Schema.matchHistory.id, currentMatch.historyEntryId))
			await loadState(ctx, { startAtOrdinal: currentMatch.ordinal })

			return { code: 'ok' as const, matchId: currentMatch.historyEntryId }
		})
		if (res.code !== 'ok') return res
		addReleaseTask(ctx.matchHistory.dispatchUpdate)
		addReleaseTask(() => ctx.matchHistory.finalized$.next({ matchId: res.matchId }))
		return { ...res }
	},
)

/**
 * Runs when rcon is connected to ensure that the match history is up-to-date. If the current layer is unexpected then we insert a new history entry for the current match.
 * Also always loads the match history state.
 */
export const syncWithCurrentLayer = Instr.spanOp(
	'syncWithCurrentLayer',
	{ module, levels: { event: 'info' }, mutexes: (ctx) => ctx.matchHistory.mtx },
	async (ctx: C.Db & MH.Ctx & MEC.Ctx & SQS.Ctx & CS.AbortSignal, _currentLayerOnServer: L.UnvalidatedLayer | L.LayerId) => {
		const currentLayerOnServer = L.toLayer(_currentLayerOnServer)
		return await DB.runTransaction(ctx, async (ctx) => {
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
			await ctx
				.db()
				.insert(Schema.matchHistory)
				.values(
					superjsonify(Schema.matchHistory, {
						serverId: ctx.serverId,
						layerId: currentLayerOnServer.id,
						ordinal,
						setByType: 'unknown',
					}),
				)
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
