import * as E from 'drizzle-orm'
import { sql } from 'drizzle-orm'

import * as Schema from '$root/drizzle/schema'
import * as Pop from '@/models/population.models'

// What counts as a match still owing a tally. Shared because both halves ask it: the worker to build its worklist,
// and the main thread to decide whether there is any reason to start the worker at all.

export const mh = Schema.matchHistory
export const mp = Schema.matchPopulation

const needsScoreline = E.isNull(mh.team1Kills)
const needsPopulation = sql`(${mp.matchId} IS NULL OR ${mp.version} != ${Pop.SAMPLER_VERSION})`

/**
 * Matches on a server with no scoreline yet, or no population samples from the current sampler.
 *
 * Deliberately not "every match that has ended": a match stays the current one through its post-game, when its
 * last events are still landing, and the dashboard counts the live feed for it anyway. Waiting until a later
 * match exists is what makes a stored tally final.
 *
 * Reads matchPopulation, so a query using it has to left join that table on matchId.
 */
export function pendingTalliesCond(serverId: string, skip: number[] = []) {
	const newest = sql`(SELECT max(${mh.ordinal}) FROM ${mh} WHERE ${mh.serverId} = ${serverId})`
	return E.and(
		E.eq(mh.serverId, serverId),
		E.or(needsScoreline, needsPopulation),
		skip.length > 0 ? E.notInArray(mh.id, skip) : undefined,
		sql`${mh.ordinal} < ${newest}`,
	)
}

export const pendingColumns = {
	id: mh.id,
	needsScoreline: sql<number>`${needsScoreline}`.mapWith(Boolean),
	needsPopulation: sql<number>`${needsPopulation}`.mapWith(Boolean),
}
