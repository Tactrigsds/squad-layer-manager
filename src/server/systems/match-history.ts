import * as Schema from '$root/drizzle/schema'
import * as SchemaModels from '$root/drizzle/schema.models'
import { acquireInBlock, toAsyncGenerator } from '@/lib/async'
import * as SM from '@/lib/rcon/squad-models'
import * as SME from '@/lib/rcon/squad-models.events.ts'
import { Parts } from '@/lib/types'
import * as M from '@/models'
import * as C from '@/server/context'
import * as DB from '@/server/db'
import { baseLogger } from '@/server/logger'
import * as Otel from '@opentelemetry/api'
import { Mutex } from 'async-mutex'
import { sql } from 'drizzle-orm'
import * as E from 'drizzle-orm/expressions'
import * as Rx from 'rxjs'
import { procedure, router } from '../trpc.server'

export const MAX_RECENT_MATCHES = 100
const tracer = Otel.trace.getTracer('match-history')

export let state!: { recentMatches: SM.MatchDetails[]; tempCurrentMatch?: M.LayerId } & Parts<M.UserPart>
const recentMatchesModified$ = new Rx.Subject<void>()

export const historyMtx = new Mutex()

export async function getRecentMatchHistory() {
	using _lock = await acquireInBlock(historyMtx)
	if (state.recentMatches[state.recentMatches.length - 1]?.status === 'in-progress') {
		return state.recentMatches.slice(0, state.recentMatches.length - 1)
	}
	return state.recentMatches
}

export const loadMatches = C.spanOp('match-history-load-matches', { tracer }, async (ctx: C.Log & C.Db) => {
	const rows = (await ctx.db().select().from(Schema.matchHistory)
		.leftJoin(Schema.users, E.eq(Schema.matchHistory.setByUserId, Schema.users.discordId))
		.orderBy(E.desc(Schema.matchHistory.ordinal))
		.limit(
			MAX_RECENT_MATCHES,
		).execute()).reverse()
	state = {
		recentMatches: rows.map(r => SM.matchHistoryEntryToMatchDetails(r.matchHistory)),
		parts: { users: [] },
	}
	for (const row of rows) {
		if (!row.users) continue
		const user = row.users
		const existingIdx = state.parts.users.findIndex(u => u.discordId === user.discordId)
		if (existingIdx !== -1) {
			state.parts.users[existingIdx] = user
		} else {
			state.parts.users.push(user)
		}
	}
})

export function getCurrentMatch() {
	return state.recentMatches[state.recentMatches.length - 1]
}

export const loadCurrentMatch = C.spanOp(
	'match-history:get-previous-match',
	{ tracer, eventLogLevel: 'info' },
	async (ctx: C.Log & C.Db, opts?: { lock?: boolean }) => {
		const query = ctx.db().select().from(Schema.matchHistory).orderBy(E.desc(Schema.matchHistory.ordinal)).limit(1)
		let match: SchemaModels.MatchHistory
		if (opts?.lock) [match] = await query.for('update')
		else [match] = await query.execute()
		if (!match) return null
		return SM.matchHistoryEntryToMatchDetails(match)
	},
)

export const setup = C.spanOp('match-history:setup', { tracer, eventLogLevel: 'info' }, async () => {
	using _lock = await acquireInBlock(historyMtx)

	const ctx = DB.addPooledDb({ log: baseLogger })
	await loadMatches(ctx)

	recentMatchesModified$.pipe(Rx.startWith(0)).subscribe(() => {
		ctx.log.info('active match id: %s, status: %s', getCurrentMatch()?.historyEntryId, getCurrentMatch()?.status)
	})
})

export const matchHistoryRouter = router({
	watchRecentMatchHistory: procedure.subscription(async function*() {
		yield state
		for await (const _ of toAsyncGenerator(recentMatchesModified$)) {
			yield state
		}
	}),
})

export const addNewCurrentMatch = C.spanOp(
	'match-history:add-new-current-match',
	{ tracer, eventLogLevel: 'info' },
	async (ctx: C.Log & C.Db, entry: Omit<SchemaModels.NewMatchHistory, 'ordinal'>) => {
		await DB.runTransaction(ctx, async (ctx) => {
			const currentMatch = await loadCurrentMatch(ctx, { lock: true })
			await ctx.db().insert(Schema.matchHistory).values({ ...entry, ordinal: currentMatch ? currentMatch.ordinal + 1 : 0 }).$returningId()
			await loadMatches(ctx)
		})

		return { code: 'ok' as const, match: getCurrentMatch() }
	},
)

export const finalizeCurrentMatch = C.spanOp('match-history:finalize-current-match', { tracer, eventLogLevel: 'info' }, async (
	ctx: C.Log & C.Db,
	currentLayerId: string,
	event: SME.RoundEnded,
) => {
	const res = await DB.runTransaction(ctx, async ctx => {
		const currentMatch = await loadCurrentMatch(ctx, { lock: true })
		if (!currentMatch) return { code: 'err:no-match-found' as const, message: 'No match found' }
		if (currentMatch.status !== 'in-progress') {
			ctx.log.warn('unable to update current history entry: not in-progress')
			return { code: 'err:match-not-in-progress', message: 'Match not in progress' }
		}
		if (!M.areLayerIdsCompatible(currentLayerId, currentMatch.layerId)) {
			ctx.log.warn('unable to update current history entry: layer id mismatch')
			return { code: 'err:layer-id-mismatch', message: 'Layer id mismatch' }
		}

		const teams: [SM.SquadOutcomeTeam | null, SM.SquadOutcomeTeam | null] = [event.winner, event.loser]
		if (teams[0]) teams.sort((a, b) => a!.team - b!.team)
		const outcome = event.winner === null ? 'draw' : event.winner.team === 1 ? 'team1' : 'team2'

		await ctx.db().update(Schema.matchHistory).set({
			endTime: event.time,
			outcome,
			team1Tickets: teams[0]?.tickets,
			team2Tickets: teams[1]?.tickets,
		}).where(E.eq(Schema.matchHistory.id, currentMatch.historyEntryId))
		await loadMatches(ctx)
		return {
			code: 'ok' as const,
		}
	})
	if (res.code === 'ok') recentMatchesModified$.next()
	return res
})

/**
 * Runs on startup once rcon is connected to ensure that the match history is up-to-date. If the current layer is unexpected then we insert a new history entry for the current match.
 */
export const resolvePotentialCurrentLayerConflict = C.spanOp(
	'match-history:resolve-potential-current-layer-conflict',
	{ tracer, eventLogLevel: 'info' },
	async (ctx: C.Db, currentLayerOnServer: M.LayerId) => {
		await DB.runTransaction(ctx, async ctx => {
			using _lock = await acquireInBlock(historyMtx)
			const currentMatch = await loadCurrentMatch(ctx, { lock: true })
			if (currentMatch && M.areLayerIdsCompatible(currentMatch.layerId, currentLayerOnServer)) return
			await ctx.db().insert(Schema.matchHistory).values({
				layerId: currentLayerOnServer,
				ordinal: currentMatch ? currentMatch.ordinal + 1 : 0,
				setByType: 'unknown',
			})
			await loadMatches(ctx)
		})
		recentMatchesModified$.next()
	},
)

export async function getMatchHistoryCount(ctx: C.Log & C.Db): Promise<number> {
	const [{ count }] = await ctx.db().select({ count: sql<string>`count(*)` }).from(Schema.matchHistory)
	return parseInt(count)
}
