import * as E from 'drizzle-orm'

import * as Schema from '$root/drizzle/schema'
import * as PUN from '@/models/player-usernames.models'
import type * as C from '@/server/context'
import * as DB from '@/server/db'
import { initModule } from '@/server/logger'
import * as Sql from '@/server/sql'

const module = initModule('player-usernames')
const SQL = Sql.forModule(module)

const periodsP = SQL.params({ playerId: Schema.playerUsernames.playerId })
const usernamesOf = SQL.def(
	'usernamesOf',
	periodsP,
	SQL.select({ username: Schema.playerUsernames.username, time: Schema.playerUsernames.time })
		.from(Schema.playerUsernames)
		.where(E.eq(Schema.playerUsernames.playerId, periodsP.playerId))
		.orderBy(E.desc(Schema.playerUsernames.time))
		.limit(PUN.MAX_PERIODS),
)

export function getPeriods(ctx: C.Db, playerId: string): PUN.UsernamePeriod[] {
	return PUN.toPeriods(DB.all(ctx, usernamesOf({ playerId })))
}
