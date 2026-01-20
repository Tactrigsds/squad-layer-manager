import * as Schema from '$root/drizzle/schema'
import type * as SchemaModels from '$root/drizzle/schema.models'
import * as Arr from '@/lib/array'
import { type CleanupTasks, toAsyncGenerator, withAbortSignal } from '@/lib/async'
import { superjsonify, unsuperjsonify } from '@/lib/drizzle'
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
import type * as SM from '@/models/squad.models'
import type * as USR from '@/models/users.models'
import { CONFIG } from '@/server/config'
import * as C from '@/server/context'
import * as DB from '@/server/db'
import { initModule } from '@/server/logger'

import orpcBase from '@/server/orpc-base'
import * as SquadServer from '@/systems/squad-server.server'
import * as UsersClient from '@/systems/users.server'

import { Mutex } from 'async-mutex'
import { sql } from 'drizzle-orm'
import * as E from 'drizzle-orm/expressions'
import { alias } from 'drizzle-orm/mysql-core'
import * as Rx from 'rxjs'
import { z } from 'zod'

const module = initModule('match-history')
let log!: CS.Logger

export function setup() {
	log = module.getLogger()
}

export type MatchHistoryContext = {
	mtx: Mutex
	update$: Rx.Subject<void>
	dispatchUpdate: () => void
	recentMatches: MH.MatchDetails[]
	recentBalanceTriggerEvents: BAL.BalanceTriggerEvent[]

	// matchId -> event
	interpolatedEventCache: LRUMap<number, Promise<CHAT.EventEnriched[]>>
} & Parts<USR.UserPart>

export function initMatchHistoryContext(cleanup: CleanupTasks): MatchHistoryContext {
	const update$ = new Rx.Subject<void>()
	const ctx: MatchHistoryContext = {
		mtx: new Mutex(),
		update$,
		// we have to define this separately because we're passing it to withAcquired, which dedupes release tasks by reference equality. that means we have to define this once here and not reference update$ in a closure instead. Convoluted I know but what else is new :shrug:
		dispatchUpdate: () => update$.next(),
		parts: { users: [] },
		recentMatches: [],
		recentBalanceTriggerEvents: [],
		interpolatedEventCache: new LRUMap(200),
	}

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
	'load-state',
	{ module },
	async (ctx: C.Db & C.MatchHistory, opts?: { startAtOrdinal?: number }) => {
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
	},
)

export const getRecentMatches = C.spanOp('match-history:get-recent-matches', {
	module,
	levels: { event: 'trace' },
	mutexes: (ctx) => ctx.matchHistory.mtx,
}, async (ctx: C.MatchHistory) => {
	return ctx.matchHistory.recentMatches
})

export const getCurrentMatch = C.spanOp('match-history:get-current-match', {
	module,
	levels: { event: 'trace' },
	mutexes: (ctx) => ctx.matchHistory.mtx,
}, async (ctx: C.MatchHistory) => {
	return ctx.matchHistory.recentMatches[ctx.matchHistory.recentMatches.length - 1]
})

const loadCurrentMatch = C.spanOp(
	'get-previous-match',
	{ module, levels: { event: 'info' }, mutexes: (ctx) => ctx.matchHistory.mtx },
	async (ctx: C.Db & C.MatchHistory, opts?: { forUpdate?: boolean }) => {
		const query = ctx.db().select().from(Schema.matchHistory).where(E.eq(Schema.matchHistory.serverId, ctx.serverId)).orderBy(
			E.desc(Schema.matchHistory.ordinal),
		).limit(1)
		let match: SchemaModels.MatchHistory
		if (opts?.forUpdate) [match] = await query.for('update')
		else [match] = await query.execute()
		if (!match) return null
		return MH.matchHistoryEntryToMatchDetails(match, true)
	},
)

export const matchHistoryRouter = {
	watchMatchHistoryState: orpcBase.handler(async function*({ signal, context: _ctx }) {
		const server$ = SquadServer.selectedServerCtx$(_ctx).pipe(withAbortSignal(signal!))
		const state$ = server$.pipe(
			Rx.switchMap(async function*(ctx) {
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

	getMatchEvents: orpcBase.input(z.number()).handler(async ({ input: ordinal, context: _ctx }) => {
		const ctx = SquadServer.resolveWsClientSliceCtx(_ctx)
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

	getRecentPlayerEvents: orpcBase.input(z.object({
		playerId: z.string(),
		lastEventId: z.number().optional(),
	})).handler(async ({ input, context: _ctx }) => {
		const pageSize = 50
		const ctx = SquadServer.resolveWsClientSliceCtx(_ctx)
		const playerId = BigInt(input.playerId)

		// Get counts of player-associated events per match
		const eventCountsPerMatch = await ctx.db()
			.select({
				matchId: Schema.serverEvents.matchId,
				count: sql<number>`COUNT(${Schema.playerEventAssociations.serverEventId})`,
			})
			.from(Schema.playerEventAssociations)
			.innerJoin(Schema.serverEvents, E.eq(Schema.playerEventAssociations.serverEventId, Schema.serverEvents.id))
			.where(E.eq(Schema.playerEventAssociations.playerId, playerId))
			.groupBy(Schema.serverEvents.matchId)
			.orderBy(E.desc(Schema.serverEvents.matchId))
			.limit(pageSize)

		let matchesToLoad = []
		let eventCount = 0
		for (const { matchId, count } of eventCountsPerMatch) {
			matchesToLoad.push(matchId)
			if (eventCount >= pageSize) break
			eventCount += count
		}

		const allEvents = await getEventsForMatches(ctx, ...matchesToLoad)

		const events = allEvents.filter(event =>
			event.type === 'NEW_GAME' || event.type === 'RESET' || event.type === 'ROUND_ENDED'
			|| CHAT.isEventAssocWithPlayer(event, input.playerId)
		)

		return events
	}),
}

export const addNewCurrentMatch = C.spanOp(
	'add-new-current-match',
	{ module, levels: { event: 'info' }, mutexes: (ctx) => [ctx.matchHistory.mtx, ctx.server.savingEventsMtx] },
	async (
		ctx: C.Db & C.MatchHistory & C.SquadServer,
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
			ctx.server.state.lastSavedEventId = null
			// flush the events buffer
			const eventBuffer = ctx.server.state.eventBuffer
			ctx.server.state.eventBuffer = []

			await loadState(ctx, { startAtOrdinal: ordinal })
			addReleaseTask(ctx.matchHistory.dispatchUpdate)
		})

		return { code: 'ok' as const, match: await getCurrentMatch(ctx) }
	},
)

export const finalizeCurrentMatch = C.spanOp('match-history:finalize-current-match', {
	module,
	levels: { event: 'info' },
	mutexes: (ctx) => ctx.matchHistory.mtx,
	attrs: (_, currentLayerId) => ({
		currentLayerId,
	}),
}, async (
	ctx: C.Db & C.MatchHistory,
	currentLayerId: string,
	winner: SM.SquadOutcomeTeam | null,
	loser: SM.SquadOutcomeTeam | null,
	time: Date,
) => {
	const res = await DB.runTransaction(ctx, async ctx => {
		const currentMatch = await loadCurrentMatch(ctx, { forUpdate: true })
		if (!currentMatch) return { code: 'err:no-match-found' as const, message: 'No match found' }
		if (currentMatch.status !== 'in-progress') {
			log.warn('unable to update current history entry: not in-progress')
			return { code: 'err:match-not-in-progress' as const, message: 'Match not in progress' }
		}
		if (!L.areLayersCompatible(currentLayerId, currentMatch.layerId)) {
			log.warn('unable to update current history entry: layer id mismatch')
			return { code: 'err:layer-id-mismatch' as const, message: 'Layer id mismatch' }
		}

		const teams: [SM.SquadOutcomeTeam | null, SM.SquadOutcomeTeam | null] = [winner, loser]
		if (teams[0]) teams.sort((a, b) => a!.team - b!.team)
		const outcome = winner === null ? 'draw' as const : winner.team === 1 ? 'team1' as const : 'team2' as const

		const update = {
			endTime: time,
			outcome: outcome,
			team1Tickets: teams[0]?.tickets,
			team2Tickets: teams[1]?.tickets,
		}

		await ctx.db().update(Schema.matchHistory).set(superjsonify(Schema.matchHistory, update)).where(
			E.eq(Schema.matchHistory.id, currentMatch.historyEntryId),
		)
		await loadState(ctx, { startAtOrdinal: currentMatch.ordinal })

		// -------- look for tripped balance triggers --------
		for (const [trigId, level] of Object.entries(CONFIG.balanceTriggerLevels)) {
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
					.$returningId()
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
	'sync-with-current-layer',
	{ module, levels: { event: 'info' }, mutexes: (ctx) => ctx.matchHistory.mtx },
	async (ctx: C.Db & C.MatchHistory & C.SquadServer, currentLayerOnServer: L.UnvalidatedLayer) => {
		return await DB.runTransaction(ctx, async ctx => {
			const currentMatch = await loadCurrentMatch(ctx, { forUpdate: true })
			if (currentMatch && L.areLayersCompatible(currentMatch.layerId, currentLayerOnServer)) {
				log.info('Current layer %s, match %d is compatible with the match history', currentMatch.layerId, currentMatch.historyEntryId)
				await loadState(ctx)
				addReleaseTask(ctx.matchHistory.dispatchUpdate)
				return { pushedNewMatch: false, currentMatch }
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

const getEventsForMatches = C.spanOp('get-match-events', { module }, async (ctx: C.Db & C.MatchHistory, ..._matches: number[]) => {
	const matches = _matches.toSorted((a, b) => a - b)

	let ops: Promise<CHAT.EventEnriched[]>[] = []
	for (const matchId of matches) {
		const cachedEvents$ = ctx.matchHistory.interpolatedEventCache.get(matchId)
		if (cachedEvents$) {
			ops.push(cachedEvents$)
			continue
		}
		const events$ = (async () => {
			const it = ctx.db().select()
				.from(Schema.serverEvents)
				.where(E.inArray(Schema.serverEvents.id, matches))
				.orderBy(E.asc(Schema.serverEvents.id)).iterator()

			const state = CHAT.getInitialChatState()
			for await (const rawEvent of it) {
				const event = SquadServer.fromEventRow(rawEvent)
				CHAT.handleEvent(state, event)
			}
			return state.eventBuffer
		})()
		ctx.matchHistory.interpolatedEventCache.set(matchId, events$)
		ops.push(events$)
	}

	const allEvents = (await Promise.all(ops)).flat()
	return allEvents
})
