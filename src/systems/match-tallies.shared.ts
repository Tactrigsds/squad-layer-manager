import * as E from 'drizzle-orm'
import { sql } from 'drizzle-orm'

import * as Schema from '$root/drizzle/schema'
import * as Pop from '@/models/population.models'
import { initModule } from '@/server/logger'
import * as Sql from '@/server/sql'

// What counts as a match still owing a tally. Shared because both halves ask it: the worker to build its worklist,
// and the main thread to decide whether there is any reason to start the worker at all.

const module = initModule('match-tallies-shared')
const SQL = Sql.forModule(module)

export const mh = Schema.matchHistory
export const mp = Schema.matchPopulation

const needsScoreline = E.isNull(mh.team1Kills)
const needsPopulation = sql`(${mp.matchId} IS NULL OR ${mp.version} != ${SQL.lit(Pop.SAMPLER_VERSION)})`

const skipJson = SQL.list(mh.id)

/**
 * Matches on a server with no scoreline yet, or no population samples from the current sampler.
 *
 * Deliberately not "every match that has ended": a match stays the current one through its post-game, when its
 * last events are still landing, and the dashboard counts the live feed for it anyway. Waiting until a later
 * match exists is what makes a stored tally final.
 *
 * Reads matchPopulation, so a query using it has to left join that table on matchId.
 */
function pendingTalliesCond(p: { serverId: Sql.Parameter<string>; skip: Sql.Parameter<number[]> }) {
	const newest = sql`(SELECT max(${mh.ordinal}) FROM ${mh} WHERE ${mh.serverId} = ${p.serverId})`
	return E.and(
		E.eq(mh.serverId, p.serverId),
		E.or(needsScoreline, needsPopulation),
		E.not(SQL.inJson(mh.id, p.skip)),
		sql`${mh.ordinal} < ${newest}`,
	)
}

export namespace Q {
	const pendingP = SQL.params({ serverId: mh.serverId, skip: skipJson, limit: SQL.count() })
	/** The next matches to tally, newest first, so the page the history panel is showing fills in before the rest. */
	export const pendingMatches = SQL.def(
		'pendingMatches',
		pendingP,
		SQL.select({
			id: mh.id,
			needsScoreline: sql<number>`${needsScoreline}`.mapWith(Boolean),
			needsPopulation: sql<number>`${needsPopulation}`.mapWith(Boolean),
		})
			.from(mh)
			.leftJoin(mp, E.eq(mp.matchId, mh.id))
			.where(pendingTalliesCond(pendingP))
			.orderBy(E.desc(mh.ordinal))
			.limit(pendingP.limit),
	)
	const anyPendingP = SQL.params({ serverId: mh.serverId, skip: skipJson })
	export const anyPendingMatch = SQL.def(
		'anyPendingMatch',
		anyPendingP,
		SQL.select({ id: mh.id }).from(mh).leftJoin(mp, E.eq(mp.matchId, mh.id)).where(pendingTalliesCond(anyPendingP)).limit(1),
	)
}
