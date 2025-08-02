import * as Schema from '$root/drizzle/schema'
import * as SchemaModels from '$root/drizzle/schema.models'
import * as Arr from '@/lib/array'
import { acquireInBlock, toAsyncGenerator, withAbortSignal } from '@/lib/async'
import { superjsonify, unsuperjsonify } from '@/lib/drizzle'
import { Parts } from '@/lib/types'
import { GENERAL } from '@/messages'
import * as BAL from '@/models/balance-triggers.models'
import * as CS from '@/models/context-shared'
import * as L from '@/models/layer'
import * as MH from '@/models/match-history.models'
import * as SME from '@/models/squad-models.events'
import * as SM from '@/models/squad.models'
import * as USR from '@/models/users.models'
import * as C from '@/server/context'
import * as DB from '@/server/db'
import { baseLogger } from '@/server/logger'
import * as Otel from '@opentelemetry/api'
import { Mutex } from 'async-mutex'
import { sql } from 'drizzle-orm'
import * as E from 'drizzle-orm/expressions'
import * as Rx from 'rxjs'
import { CONFIG } from '../config'
import { procedure, router } from '../trpc.server'

export const MAX_RECENT_MATCHES = 100
const tracer = Otel.trace.getTracer('match-history')

export let state!: {
	tempCurrentMatch?: L.LayerId
	recentMatches: MH.MatchDetails[]
	recentBalanceTriggerEvents: BAL.BalanceTriggerEvent[]
} & Parts<USR.UserPart>
export const stateUpdated$ = new Rx.Subject<CS.Log>()

export function getPublicMatchHistoryState(): MH.PublicMatchHistoryState & Parts<USR.UserPart> {
	return {
		recentMatches: state.recentMatches,
		recentBalanceTriggerEvents: state.recentBalanceTriggerEvents,
		parts: state.parts,
	}
}

export const historyMtx = new Mutex()

export async function getRecentMatchHistory() {
	using _lock = await acquireInBlock(historyMtx)
	if (state.recentMatches[state.recentMatches.length - 1]?.status === 'in-progress') {
		return state.recentMatches.slice(0, state.recentMatches.length - 1)
	}
	return state.recentMatches
}

export const loadState = C.spanOp(
	'match-history:load-state',
	{ tracer },
	async (ctx: CS.Log & C.Db, opts?: { startAtOrdinal?: number }) => {
		const recentMatchesCte = ctx.db().select().from(Schema.matchHistory).where(
			opts?.startAtOrdinal ? E.gte(Schema.matchHistory.ordinal, opts.startAtOrdinal) : E.gt(Schema.matchHistory.ordinal, 0),
		).orderBy(E.desc(Schema.matchHistory.ordinal)).limit(100).as(
			'recent_matches',
		)

		const rows = await ctx.db().select().from(recentMatchesCte)
			.leftJoin(Schema.users, E.eq(recentMatchesCte.setByUserId, Schema.users.discordId))
			// keep in mind that there may be multiple balance trigger events for this history entry id, and therefore multiple rows for a single match history entry
			.leftJoin(Schema.balanceTriggerEvents, E.eq(recentMatchesCte.id, Schema.balanceTriggerEvents.matchTriggeredId))

		for (const row of rows.reverse()) {
			const details = MH.matchHistoryEntryToMatchDetails(row.recent_matches)
			Arr.upsertOn(state.recentMatches, details, 'historyEntryId')
			if (row.balanceTriggerEvents) {
				Arr.upsertOn(state.recentBalanceTriggerEvents, unsuperjsonify(Schema.balanceTriggerEvents, row.balanceTriggerEvents), 'id')
			}
			if (row.users) {
				const user = row.users
				Arr.upsertOn(state.parts.users, user, 'discordId')
			}
		}
		if (state.recentMatches.length > MAX_RECENT_MATCHES) {
			state.recentMatches = state.recentMatches.slice(state.recentMatches.length - MAX_RECENT_MATCHES, state.recentMatches.length)
		}
	},
)

export function getCurrentMatch() {
	return state.recentMatches[state.recentMatches.length - 1]
}

export const loadCurrentMatch = C.spanOp(
	'match-history:get-previous-match',
	{ tracer, eventLogLevel: 'info' },
	async (ctx: CS.Log & C.Db, opts?: { lock?: boolean }) => {
		const query = ctx.db().select().from(Schema.matchHistory).orderBy(E.desc(Schema.matchHistory.ordinal)).limit(1)
		let match: SchemaModels.MatchHistory
		if (opts?.lock) [match] = await query.for('update')
		else [match] = await query.execute()
		if (!match) return null
		return MH.matchHistoryEntryToMatchDetails(match)
	},
)

export const setup = C.spanOp('match-history:setup', { tracer, eventLogLevel: 'info' }, async () => {
	using _lock = await acquireInBlock(historyMtx)

	const ctx = DB.addPooledDb({ log: baseLogger })
	state = {
		parts: { users: [] },
		recentMatches: [],
		recentBalanceTriggerEvents: [],
	}
	await loadState(ctx)

	stateUpdated$.pipe(Rx.startWith(0)).subscribe(() => {
		ctx.log.info('active match id: %s, status: %s', getCurrentMatch()?.historyEntryId, getCurrentMatch()?.status)
	})
})

export const matchHistoryRouter = router({
	watchMatchHistoryState: procedure.subscription(async function*({ signal }) {
		yield getPublicMatchHistoryState()
		for await (const _ of toAsyncGenerator(stateUpdated$.pipe(withAbortSignal(signal!)))) {
			yield getPublicMatchHistoryState()
		}
	}),
})

export const addNewCurrentMatch = C.spanOp(
	'match-history:add-new-current-match',
	{ tracer, eventLogLevel: 'info' },
	async (ctx: CS.Log & C.Db, entry: Omit<SchemaModels.NewMatchHistory, 'ordinal'>) => {
		await DB.runTransaction(ctx, async (ctx) => {
			const currentMatch = await loadCurrentMatch(ctx, { lock: true })
			const ordinal = currentMatch ? currentMatch.ordinal + 1 : 0
			await ctx.db().insert(Schema.matchHistory).values({ ...entry, ordinal }).$returningId()
			await loadState(ctx, { startAtOrdinal: ordinal })
		})

		stateUpdated$.next(ctx)

		return { code: 'ok' as const, match: getCurrentMatch() }
	},
)

export const finalizeCurrentMatch = C.spanOp('match-history:finalize-current-match', { tracer, eventLogLevel: 'info' }, async (
	ctx: CS.Log & C.Db,
	currentLayerId: string,
	event: SME.RoundEnded,
) => {
	const res = await DB.runTransaction(ctx, async ctx => {
		const currentMatch = await loadCurrentMatch(ctx, { lock: true })
		if (!currentMatch) return { code: 'err:no-match-found' as const, message: 'No match found' }
		if (currentMatch.status !== 'in-progress') {
			ctx.log.warn('unable to update current history entry: not in-progress')
			return { code: 'err:match-not-in-progress' as const, message: 'Match not in progress' }
		}
		if (!L.areLayersCompatible(currentLayerId, currentMatch.layerId)) {
			ctx.log.warn('unable to update current history entry: layer id mismatch')
			return { code: 'err:layer-id-mismatch' as const, message: 'Layer id mismatch' }
		}

		const teams: [SM.SquadOutcomeTeam | null, SM.SquadOutcomeTeam | null] = [event.winner, event.loser]
		if (teams[0]) teams.sort((a, b) => a!.team - b!.team)
		const outcome = event.winner === null ? 'draw' as const : event.winner.team === 1 ? 'team1' as const : 'team2' as const

		const update = {
			endTime: event.time,
			outcome: outcome,
			team1Tickets: teams[0]?.tickets,
			team2Tickets: teams[1]?.tickets,
		}

		await ctx.db().update(Schema.matchHistory).set(update).where(E.eq(Schema.matchHistory.id, currentMatch.historyEntryId))
		await loadState(ctx, { startAtOrdinal: currentMatch.ordinal })

		// -------- look for tripped balance triggers --------
		for (const [trigId, level] of Object.entries(CONFIG.balanceTriggerLevels)) {
			let inputStored: any
			const trig = BAL.TRIGGERS[trigId as BAL.TriggerId]
			try {
				ctx.log.info('Evaluating trigger %s', trig.id)
				const input = trig.resolveInput({ history: state.recentMatches })
				inputStored = input
				const res = trig.evaluate(ctx, input)
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
				ctx.log.info(
					'Trigger %s fired: message: "%s"',
					trig.id,
					GENERAL.balanceTrigger.showEvent({ ...event, id }, currentMatch, false),
				)
			} catch (err) {
				ctx.log.error(err, 'Error evaluating trigger %s input: %s', trig.id, JSON.stringify(inputStored ?? null))
			}
		}
		await loadState(ctx, { startAtOrdinal: currentMatch.ordinal })
		return { code: 'ok' as const }
	})
	if (res.code !== 'ok') return res
	stateUpdated$.next(ctx)
	return { ...res }
})

/**
 * Runs on startup once rcon is connected to ensure that the match history is up-to-date. If the current layer is unexpected then we insert a new history entry for the current match.
 */
export const resolvePotentialCurrentLayerConflict = C.spanOp(
	'match-history:resolve-potential-current-layer-conflict',
	{ tracer, eventLogLevel: 'info' },
	async (ctx: C.Db, currentLayerOnServer: L.UnvalidatedLayer) => {
		await DB.runTransaction(ctx, async ctx => {
			using _lock = await acquireInBlock(historyMtx)
			const currentMatch = await loadCurrentMatch(ctx, { lock: true })
			if (currentMatch && L.areLayersCompatible(currentMatch.layerId, currentLayerOnServer)) return
			const ordinal = currentMatch ? currentMatch.ordinal + 1 : 0
			await ctx.db().insert(Schema.matchHistory).values({
				layerId: currentLayerOnServer.id,
				ordinal,
				setByType: 'unknown',
			})
			await loadState(ctx, { startAtOrdinal: ordinal })
		})
		stateUpdated$.next(ctx)
	},
)

export async function getMatchHistoryCount(ctx: CS.Log & C.Db): Promise<number> {
	const [{ count }] = await ctx.db().select({ count: sql<string>`count(*)` }).from(Schema.matchHistory)
	return parseInt(count)
}
