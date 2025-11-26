import * as Schema from '$root/drizzle/schema'
import type * as SchemaModels from '$root/drizzle/schema.models'
import * as Arr from '@/lib/array'
import { acquireReentrant, toAsyncGenerator, withAbortSignal } from '@/lib/async'
import { superjsonify, unsuperjsonify } from '@/lib/drizzle'
import type { Parts } from '@/lib/types'
import * as Messages from '@/messages'
import * as BAL from '@/models/balance-triggers.models'
import type * as CS from '@/models/context-shared'
import * as L from '@/models/layer'
import * as MH from '@/models/match-history.models'
import type * as SM from '@/models/squad.models'
import type * as USR from '@/models/users.models'
import * as C from '@/server/context'
import * as DB from '@/server/db'
import * as SquadServer from '@/server/systems/squad-server'
import * as Otel from '@opentelemetry/api'
import { Mutex } from 'async-mutex'
import * as E from 'drizzle-orm/expressions'
import * as Rx from 'rxjs'
import { CONFIG } from '../config'
import orpcBase from '../orpc-base'
import * as UsersClient from './users'

export const MAX_RECENT_MATCHES = 100
const tracer = Otel.trace.getTracer('match-history')

export type MatchHistoryContext = {
	mtx: Mutex
	update$: Rx.Subject<void>
	recentMatches: MH.MatchDetails[]
	recentBalanceTriggerEvents: BAL.BalanceTriggerEvent[]
} & Parts<USR.UserPart>

export function initMatchHistoryContext(): MatchHistoryContext {
	return {
		mtx: new Mutex(),
		update$: new Rx.Subject(),
		parts: { users: [] },
		recentMatches: [],
		recentBalanceTriggerEvents: [],
	}
}

export function getPublicMatchHistoryState(ctx: C.MatchHistory): MH.PublicMatchHistoryState & Parts<USR.UserPart> {
	const state = ctx.matchHistory
	return {
		recentMatches: state.recentMatches,
		recentBalanceTriggerEvents: state.recentBalanceTriggerEvents,
		parts: state.parts,
	}
}

export async function getRecentMatchHistory(ctx: C.MatchHistory & C.Mutexes) {
	using _lock = await acquireReentrant(ctx, ctx.matchHistory.mtx)
	const state = ctx.matchHistory
	if (state.recentMatches[state.recentMatches.length - 1]?.status === 'in-progress') {
		return state.recentMatches.slice(0, state.recentMatches.length - 1)
	}
	return state.recentMatches
}

export const loadState = C.spanOp(
	'match-history:load-state',
	{ tracer },
	async (ctx: CS.Log & C.Db & C.MatchHistory, opts?: { startAtOrdinal?: number }) => {
		const state = ctx.matchHistory
		const recentMatchesCte = ctx.db().select().from(Schema.matchHistory).where(
			E.and(
				opts?.startAtOrdinal ? E.gte(Schema.matchHistory.ordinal, opts.startAtOrdinal) : E.gt(Schema.matchHistory.ordinal, 0),
				E.eq(Schema.matchHistory.serverId, ctx.serverId),
			),
		).orderBy(E.desc(Schema.matchHistory.ordinal)).limit(100).as(
			'recent_matches',
		)

		const rows = await ctx.db().select().from(recentMatchesCte)
			.leftJoin(Schema.users, E.eq(recentMatchesCte.setByUserId, Schema.users.discordId))
			// keep in mind that there may be multiple balance trigger events for this history entry id, and therefore multiple rows for a single match history entry
			.leftJoin(Schema.balanceTriggerEvents, E.eq(recentMatchesCte.id, Schema.balanceTriggerEvents.matchTriggeredId))

		for (const row of rows.reverse()) {
			// @ts-expect-error idgaf
			const details = MH.matchHistoryEntryToMatchDetails(unsuperjsonify(Schema.matchHistory, row.recent_matches))
			Arr.upsertOn(state.recentMatches, details, 'historyEntryId')
			if (row.balanceTriggerEvents) {
				Arr.upsertOn(state.recentBalanceTriggerEvents, unsuperjsonify(Schema.balanceTriggerEvents, row.balanceTriggerEvents), 'id')
			}
			if (row.users) {
				const user = await UsersClient.buildUser(ctx, row.users)
				Arr.upsertOn(state.parts.users, user, 'discordId')
			}
		}
		if (state.recentMatches.length > MAX_RECENT_MATCHES) {
			state.recentMatches = state.recentMatches.slice(state.recentMatches.length - MAX_RECENT_MATCHES, state.recentMatches.length)
		}
	},
)

export function getCurrentMatch(ctx: C.MatchHistory) {
	return ctx.matchHistory.recentMatches[ctx.matchHistory.recentMatches.length - 1]
}

export const loadCurrentMatch = C.spanOp(
	'match-history:get-previous-match',
	{ tracer, eventLogLevel: 'info' },
	async (ctx: CS.Log & C.Db & C.MatchHistory, opts?: { lock?: boolean }) => {
		const query = ctx.db().select().from(Schema.matchHistory).where(E.eq(Schema.matchHistory.serverId, ctx.serverId)).orderBy(
			E.desc(Schema.matchHistory.ordinal),
		).limit(1)
		let match: SchemaModels.MatchHistory
		if (opts?.lock) [match] = await query.for('update')
		else [match] = await query.execute()
		if (!match) return null
		return MH.matchHistoryEntryToMatchDetails(match)
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
}

export const addNewCurrentMatch = C.spanOp(
	'match-history:add-new-current-match',
	{ tracer, eventLogLevel: 'info' },
	async (ctx: CS.Log & C.Db & C.MatchHistory & C.Mutexes, entry: Omit<SchemaModels.NewMatchHistory, 'ordinal' | 'serverId'>) => {
		using _lock = await acquireReentrant(ctx, ctx.matchHistory.mtx)
		await DB.runTransaction(ctx, async (ctx) => {
			const currentMatch = await loadCurrentMatch(ctx, { lock: true })
			const ordinal = currentMatch ? currentMatch.ordinal + 1 : 0
			await ctx.db().insert(Schema.matchHistory).values(superjsonify(Schema.matchHistory, { ...entry, ordinal, serverId: ctx.serverId }))
				.$returningId()
			await loadState(ctx, { startAtOrdinal: ordinal })
		})

		ctx.mutexes.releaseTasks.push(() => ctx.matchHistory.update$.next())

		return { code: 'ok' as const, match: getCurrentMatch(ctx) }
	},
)

export const finalizeCurrentMatch = C.spanOp('match-history:finalize-current-match', {
	tracer,
	eventLogLevel: 'info',
	extraText: (ctx) => `id: ${getCurrentMatch(ctx)}`,
	attrs: (ctx, currentLayerId) => ({
		currentLayerId,
		currentMatchId: getCurrentMatch(ctx).historyEntryId,
	}),
}, async (
	ctx: CS.Log & C.Db & C.MatchHistory & C.Mutexes,
	currentLayerId: string,
	winner: SM.SquadOutcomeTeam | null,
	loser: SM.SquadOutcomeTeam | null,
	time: Date,
) => {
	using _lock = await acquireReentrant(ctx, ctx.matchHistory.mtx)
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
				ctx.log.info('Evaluating trigger %s', trig.id)
				const input = trig.resolveInput({ history: ctx.matchHistory.recentMatches })
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
					Messages.GENERAL.balanceTrigger.showEvent({ ...event, id }, currentMatch, false),
				)
			} catch (err) {
				ctx.log.error(err, 'Error evaluating trigger %s input: %s', trig.id, JSON.stringify(inputStored ?? null))
			}
		}
		await loadState(ctx, { startAtOrdinal: currentMatch.ordinal })
		return { code: 'ok' as const }
	})
	if (res.code !== 'ok') return res
	ctx.mutexes.releaseTasks.push(() => ctx.matchHistory.update$.next())
	return { ...res }
})

/**
 * Runs when rcon is connected to ensure that the match history is up-to-date. If the current layer is unexpected then we insert a new history entry for the current match.
 */
export const resolvePotentialCurrentLayerConflict = C.spanOp(
	'match-history:resolve-potential-current-layer-conflict',
	{ tracer, eventLogLevel: 'info' },
	async (ctx: C.Db & C.MatchHistory & C.SquadServer & C.Mutexes, currentLayerOnServer: L.UnvalidatedLayer) => {
		using _lock = await acquireReentrant(ctx, ctx.matchHistory.mtx)
		await DB.runTransaction(ctx, async ctx => {
			const currentMatch = await loadCurrentMatch(ctx, { lock: true })
			if (currentMatch && L.areLayersCompatible(currentMatch.layerId, currentLayerOnServer)) return
			const ordinal = currentMatch ? currentMatch.ordinal + 1 : 0
			await ctx.db().insert(Schema.matchHistory).values(superjsonify(Schema.matchHistory, {
				serverId: ctx.serverId,
				layerId: currentLayerOnServer.id,
				ordinal,
				setByType: 'unknown',
			}))
			await loadState(ctx, { startAtOrdinal: ordinal })
			ctx.mutexes.releaseTasks.push(() => ctx.matchHistory.update$.next())
		})
	},
)
