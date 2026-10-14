import * as E from 'drizzle-orm'

import * as Schema from '$root/drizzle/schema'
import * as PUN from '@/models/player-usernames.models'
import type * as C from '@/server/context'

export async function getPeriods(ctx: C.Db, playerId: string): Promise<PUN.UsernamePeriod[]> {
	const rows = await ctx
		.db()
		.select({ username: Schema.playerUsernames.username, time: Schema.playerUsernames.time })
		.from(Schema.playerUsernames)
		.where(E.eq(Schema.playerUsernames.playerId, playerId))
		.orderBy(E.desc(Schema.playerUsernames.time))
		.limit(PUN.MAX_PERIODS)
	return PUN.toPeriods(rows)
}
