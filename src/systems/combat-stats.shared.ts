import * as E from 'drizzle-orm'
import { sql } from 'drizzle-orm'

import * as Schema from '$root/drizzle/schema'

// What counts as a match still owing a scoreline. Shared because both halves ask it: the worker to build its
// worklist, and the main thread to decide whether there is any reason to start the worker at all.

export const mh = Schema.matchHistory

/**
 * Matches on a server with no scoreline yet.
 *
 * Deliberately not "every match that has ended": a match stays the current one through its post-game, when its
 * last events are still landing, and the dashboard counts the live feed for it anyway. Waiting until a later
 * match exists is what makes a stored tally final.
 */
export function pendingCombatStatsCond(serverId: string, skip: number[] = []) {
	const newest = sql`(SELECT max(${mh.ordinal}) FROM ${mh} WHERE ${mh.serverId} = ${serverId})`
	return E.and(
		E.eq(mh.serverId, serverId),
		E.isNull(mh.team1Kills),
		skip.length > 0 ? E.notInArray(mh.id, skip) : undefined,
		sql`${mh.ordinal} < ${newest}`,
	)
}
