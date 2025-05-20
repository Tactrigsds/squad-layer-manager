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

export const RECENT_HISTORY_BASE_LENGTH = 100

export let state!: { recentMatches: SM.MatchDetails[] } & Parts<M.UserPart>
const recentMatchesModified$ = new Rx.Subject<void>()

export const modifyHistoryMtx = new Mutex()

export async function setup() {
	const ctx = DB.addPooledDb({ log: baseLogger })
	const rows = await ctx.db().select().from(Schema.matchHistory)
		.leftJoin(Schema.users, E.eq(Schema.matchHistory.setByUserId, Schema.users.discordId))
		.orderBy(E.desc(Schema.matchHistory.startTime)).limit(
			RECENT_HISTORY_BASE_LENGTH,
		).execute()
	state = {
		recentMatches: rows.map(r => SM.historyEntryToMatchDetails(r.matchHistory)),
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

	ctx.log.info('active match id: %s, status: %s', state.recentMatches[0]?.historyEntryId, state.recentMatches[0]?.status)
	recentMatchesModified$.subscribe(() => {
		ctx.log.info('active match id: %s, status: %s', state.recentMatches[0]?.historyEntryId, state.recentMatches[0]?.status)
	})
}

export const matchHistoryRouter = router({
	watchRecentMatchHistory: procedure.subscription(async function*({ ctx }) {
		yield state
		for await (const _ of toAsyncGenerator(recentMatchesModified$)) {
			ctx.log.info('emitting recent match history')
			yield state
		}
	}),
})

export async function addHistoryEntry(ctx: C.Log & C.Db, entry: SchemaModels.NewMatchHistory, expectedCount?: number) {
	using _lock = await acquireInBlock(modifyHistoryMtx)
	return await DB.runTransaction(ctx, async (ctx) => {
		const count = await getMatchHistoryCount(ctx)
		if (expectedCount && count !== expectedCount) {
			ctx.tx.rollback()
			ctx.log.warn(
				' Unexpected history entry ID expected: %s actual: %s',
				expectedCount,
				count,
			)
			return {
				code: 'error:unexpected-history-entry-count' as const,
				data: { expectedId: expectedCount, actualId: count },
				msg: 'Unexpected history entry count',
			}
		}
		let userPromise: Promise<M.User | undefined> | undefined
		if (entry.setByUserId) {
			userPromise = (async () => (await ctx.db().select().from(Schema.users).where(E.eq(Schema.users.discordId, entry.setByUserId!)))[0])()
		}

		const [{ id }] = await ctx.db().insert(Schema.matchHistory).values(entry).$returningId()
		state.recentMatches.unshift(SM.historyEntryToMatchDetails({ ...entry, id }))
		if (state.recentMatches.length > RECENT_HISTORY_BASE_LENGTH) {
			state.recentMatches.pop()
		}
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
		return { code: 'ok' as const, match: state.recentMatches[0] }
	})
}

export async function finalizeCurrentHistoryEntry(
	ctx: C.Log & C.Db,
	entry: Partial<SchemaModels.NewMatchHistory>,
	opts?: { lock?: boolean },
) {
	using _lock = await acquireInBlock(modifyHistoryMtx, { bypass: !(opts?.lock ?? true) })
	if (state.recentMatches.length === 0) {
		ctx.log.warn('unable to update current history entry: empty')
		return
	}
	if (state.recentMatches[0].status !== 'in-progress') {
		ctx.log.warn('unable to update current history entry: not in-progress')
		return
	}

	// We're running a transaction here to keep in line with calling .next during the sql transaction. if we want to send the event after the transaction we should change this pattern in all places where we're sending the event and not just here
	return await DB.runTransaction(ctx, async ctx => {
		await ctx.db().update(Schema.matchHistory).set(entry).where(E.eq(Schema.matchHistory.id, state.recentMatches[0].historyEntryId))
		state.recentMatches[0] = SM.historyEntryToMatchDetails({ ...SM.matchHistoryEntryFromMatchDetails(state.recentMatches[0]), ...entry })
		recentMatchesModified$.next()
		return state.recentMatches[0]
	})
}

export async function getMatchHistoryCount(ctx: C.Log & C.Db): Promise<number> {
	const [{ count }] = await ctx.db().select({ count: sql<string>`count(*)` }).from(Schema.matchHistory)
	return parseInt(count)
}
