import * as Schema from '$root/drizzle/schema'
import * as SchemaModels from '$root/drizzle/schema.models'
import { acquireInBlock, toAsyncGenerator } from '@/lib/async'
import * as SM from '@/lib/rcon/squad-models'
import { Parts } from '@/lib/types'
import * as M from '@/models'
import * as C from '@/server/context'
import * as DB from '@/server/db'
import { baseLogger } from '@/server/logger'
import { Mutex } from 'async-mutex'
import { sql } from 'drizzle-orm'
import * as E from 'drizzle-orm/expressions'
import * as Rx from 'rxjs'
import { procedure, router } from '../trpc.server'

export const MAX_RECENT_MATCHES = 100

export let state!: { recentMatches: SM.MatchDetails[]; tempCurrentMatch?: M.LayerId } & Parts<M.UserPart>
const recentMatchesModified$ = new Rx.Subject<void>()

function addMatch(match: SM.MatchDetails) {
	state.recentMatches.push(match)
	if (state.recentMatches.length > MAX_RECENT_MATCHES) state.recentMatches.shift()
}

export const modifyHistoryMtx = new Mutex()

export function getRecentMatchHistory() {
	if (state.recentMatches[state.recentMatches.length - 1]?.status === 'in-progress') {
		return state.recentMatches.slice(0, state.recentMatches.length - 1)
	}
	return state.recentMatches
}

export function getCurrentMatch() {
	return state.recentMatches[state.recentMatches.length - 1]
}

export async function setup() {
	const ctx = DB.addPooledDb({ log: baseLogger })

	await DB.runTransaction(ctx, async (ctx) => {
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
	recentMatchesModified$.pipe(Rx.startWith(0)).subscribe(() => {
		ctx.log.info('active match id: %s, status: %s', getCurrentMatch()?.historyEntryId, getCurrentMatch()?.status)
	})
}

export const matchHistoryRouter = router({
	watchRecentMatchHistory: procedure.subscription(async function*({ ctx }) {
		yield state
		for await (const _ of toAsyncGenerator(recentMatchesModified$)) {
			yield state
		}
	}),
})

export async function addNewCurrentMatch(ctx: C.Log & C.Db, entry: Omit<SchemaModels.MatchHistory, 'id' | 'ordinal'>) {
	using _lock = await acquireInBlock(modifyHistoryMtx)

	return await DB.runTransaction(ctx, async (ctx) => {
		let userPromise: Promise<M.User | undefined> | undefined
		if (entry.setByUserId) {
			userPromise = (async () => (await ctx.db().select().from(Schema.users).where(E.eq(Schema.users.discordId, entry.setByUserId!)))[0])()
		}
		const ordinal = (state.recentMatches[state.recentMatches.length - 1]?.ordinal ?? 0) + 1
		const [{ id }] = await ctx.db().insert(Schema.matchHistory).values({ ...entry, ordinal }).$returningId()
		addMatch(SM.matchHistoryEntryToMatchDetails({ ...entry, lqItemId: entry.lqItemId, ordinal, id }))
		if (userPromise) {
			const user = await userPromise
			if (user) {
				const existingIdx = state.parts.users.findIndex(u => u.discordId === user.discordId)
				if (existingIdx !== -1) {
					state.parts.users[existingIdx] = user
				} else {
					state.parts.users.push(user)
				}
			}
		}
		recentMatchesModified$.next()
		return { code: 'ok' as const, match: getCurrentMatch() }
	})
}

export async function finalizeCurrentMatch(
	ctx: C.Log & C.Db,
	entry: Partial<SchemaModels.NewMatchHistory>,
	opts?: { lock?: boolean },
) {
	using _lock = await acquireInBlock(modifyHistoryMtx, { bypass: !(opts?.lock ?? true) })
	const currentMatch = getCurrentMatch()
	if (!currentMatch) {
		ctx.log.warn('unable to update current match: empty')
		return
	}

	if (currentMatch.status !== 'in-progress') {
		ctx.log.warn('unable to update current history entry: not in-progress')
		return
	}

	// We're running a transaction here to keep in line with calling .next during the sql transaction. if we want to send the event after the transaction we should change this pattern in all places where we're sending the event and not just here
	return await DB.runTransaction(ctx, async ctx => {
		await ctx.db().update(Schema.matchHistory).set(entry).where(E.eq(Schema.matchHistory.id, currentMatch.historyEntryId))
		state.recentMatches[state.recentMatches.length - 1] = SM.matchHistoryEntryToMatchDetails({
			...SM.matchHistoryEntryFromMatchDetails(currentMatch),
			...entry,
		})
		recentMatchesModified$.next()
		return getCurrentMatch()
	})
}

/**
 * Runs on startup once rcon is connected to ensure that the match history is up-to-date. TODO: Reconnections to unexpected layers are not handled currently
 */
export async function resolvePotentialSquadServerCurrentLayerConflict(ctx: C.Db, currentLayerOnServer: M.LayerId) {
	using _lock = await acquireInBlock(modifyHistoryMtx)
	const currentMatch = getCurrentMatch()

	if (!currentMatch || currentMatch.status === 'in-progress' && !M.areLayerIdsCompatible(currentLayerOnServer, currentMatch.layerId)) {
		await DB.runTransaction(ctx, async (ctx) => {
			const ordinal = currentMatch ? currentMatch.ordinal + 1 : 0
			console.log(state.recentMatches)
			const [{ id }] = await ctx.db().insert(Schema.matchHistory).values({
				layerId: currentLayerOnServer,
				ordinal,
				setByType: 'unknown',
			}).$returningId()
			const [newCurrentMatchEntry] = await ctx.db().select().from(Schema.matchHistory).where(E.eq(Schema.matchHistory.id, id))
			addMatch(SM.matchHistoryEntryToMatchDetails(newCurrentMatchEntry))
			recentMatchesModified$.next()
		})
	}
}

export async function getMatchHistoryCount(ctx: C.Log & C.Db): Promise<number> {
	const [{ count }] = await ctx.db().select({ count: sql<string>`count(*)` }).from(Schema.matchHistory)
	return parseInt(count)
}
