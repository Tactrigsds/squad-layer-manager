import * as E from 'drizzle-orm'

import * as Schema from '$root/drizzle/schema'
import type * as SchemaModels from '$root/drizzle/schema.models'
import { z } from '@/lib/zod'
import * as AppEvents from '@/models/app-events.models'
import * as SETTINGS from '@/models/settings.models'
import type * as USR from '@/models/users.models'
import type * as C from '@/server/context'
import * as DB from '@/server/db'
import { initModule } from '@/server/logger'
import { getOrpcBase } from '@/server/orpc-base'
import * as Sql from '@/server/sql'
import * as OtelSys from '@/systems/otel.server'

const module = initModule('app-events')
const orpcBase = getOrpcBase(module)
const SQL = Sql.forModule(module)

const appEventP = SQL.params(E.getTableColumns(Schema.appEvents))
const insertAppEvent = SQL.def('insertAppEvent', appEventP, SQL.insert(Schema.appEvents).values(appEventP))
const assocP = SQL.params(E.getTableColumns(Schema.appEventAssociations))
const insertAssociation = SQL.def('insertAssociation', assocP, SQL.insert(Schema.appEventAssociations).values(assocP).onConflictDoNothing())

function insertAssociations(ctx: C.Db, rows: SchemaModels.NewAppEventAssociation[]) {
	for (const row of rows) DB.run(ctx, insertAssociation(row))
}

// persists an app event to the audit log. server-scoped events additionally flow through SquadServerActions.emitAppEvent
// (which pushes them into the live activity feed); global (serverId=null) events are audit-only and call this directly.
export const persistAppEvent = DB.txOp('persistAppEvent', { module }, (ctx: C.Db & C.Tx, appEvent: AppEvents.AppEvent) => {
	// stamp the emitting process so events can be grouped by run, and restart detection can correlate by instance
	appEvent.instanceId = OtelSys.instanceId
	const row = AppEvents.toRow(appEvent, SETTINGS.redactSettingValue)
	DB.run(
		ctx,
		insertAppEvent({
			actorUserId: null,
			actorPlayerId: null,
			actorPluginId: null,
			serverId: null,
			matchId: null,
			causeId: null,
			instanceId: null,
			feedVisible: null,
			version: 1,
			...row,
		}),
	)
	insertAssociations(ctx, AppEvents.associationRows(appEvent))
})

// Rebuilds the app-event index for rows that predate it, by replaying the extractors over their payloads (which
// is why migration 0109 cannot do this itself: the values come out of typescript, not sql). Runs once -- the
// backfilled column is what says a row has been done -- and in batches, since an install can hold years of them.
const BACKFILL_BATCH = 500

const unindexedEvents = SQL.def(
	'unindexedEvents',
	SQL.params({}),
	SQL.select().from(Schema.appEvents).where(E.isNull(Schema.appEvents.feedVisible)).limit(BACKFILL_BATCH),
	{ scans: ['appEvents'] },
)
const setFeedVisibleP = SQL.params({ id: Schema.appEvents.id, feedVisible: Schema.appEvents.feedVisible })
const setFeedVisible = SQL.def(
	'setFeedVisible',
	setFeedVisibleP,
	SQL.update(Schema.appEvents).set({ feedVisible: setFeedVisibleP.feedVisible }).where(E.eq(Schema.appEvents.id, setFeedVisibleP.id)),
)

export function backfillAppEventIndex(ctx: C.Db) {
	let done = 0
	for (;;) {
		const rows = DB.all(ctx, unindexedEvents({}))
		if (rows.length === 0) break
		DB.transaction(ctx, {}, (ctx) => {
			for (const row of rows) {
				const event = AppEvents.fromRow(row)
				// an unparseable row still gets its flag set, or the backfill reads it forever. It stays invisible to
				// the feed, which is what a row nothing can decode should be.
				const visible = event !== null && AppEvents.isFeedVisible(event)
				DB.run(ctx, setFeedVisible({ id: row.id, feedVisible: visible }))
				if (event) insertAssociations(ctx, AppEvents.associationRows(event))
			}
		})
		done += rows.length
	}
	if (done > 0) module.getLogger().info('backfilled the app-event index for %d row(s)', done)
}

// set once at boot (before this instance's APP_STARTED is persisted): the user who restarted SLM, if this boot
// followed a restart-slm command, else null. A restart is detected when the most recent APP_RESTARTED is newer than
// the previous instance's APP_STARTED. Read by the "SLM started/restarted" admin warn, which resolves the display name.
export let restartInfo: { userId: USR.UserId } | null = null

const eventTypeP = SQL.params({ type: Schema.appEvents.type })
const lastStartedInstance = SQL.def(
	'lastStartedInstance',
	eventTypeP,
	SQL.select({ instanceId: Schema.appEvents.instanceId })
		.from(Schema.appEvents)
		.where(E.eq(Schema.appEvents.type, eventTypeP.type))
		.orderBy(E.desc(Schema.appEvents.time))
		.limit(1),
)
const restartOfP = SQL.params({ type: Schema.appEvents.type, instanceId: Schema.appEvents.instanceId })
const restartOf = SQL.def(
	'restartOf',
	restartOfP,
	SQL.select({ actorUserId: Schema.appEvents.actorUserId })
		.from(Schema.appEvents)
		.where(E.and(E.eq(Schema.appEvents.type, restartOfP.type), E.eq(Schema.appEvents.instanceId, restartOfP.instanceId)))
		.limit(1),
)

export function detectRestartAtBoot(ctx: C.Db) {
	// the instance that ran immediately before this one (our own APP_STARTED isn't persisted yet at this point)
	const lastStart = DB.get(ctx, lastStartedInstance({ type: 'APP_STARTED' }))
	if (!lastStart?.instanceId) {
		restartInfo = null
		return
	}
	// did that exact instance restart itself (as opposed to crashing / being replaced)? correlating by instanceId is
	// clock-independent and can't be fooled by an older, unrelated restart.
	const restart = DB.get(ctx, restartOf({ type: 'APP_RESTARTED', instanceId: lastStart.instanceId }))
	if (!restart?.actorUserId) {
		restartInfo = null
		return
	}
	restartInfo = { userId: restart.actorUserId }
}

const listP = SQL.params({ before: Schema.appEvents.time, limit: SQL.count() })
const listEvents = SQL.def(
	'listEvents',
	listP,
	(paged: boolean) =>
		SQL.select()
			.from(Schema.appEvents)
			.where(paged ? E.lt(Schema.appEvents.time, listP.before) : undefined)
			.orderBy(E.desc(Schema.appEvents.time))
			.limit(listP.limit),
	// the first page walks the time index from the newest event and stops at the limit
	{ domains: [[true, false]], scans: ['appEvents'] },
)
const playerNamesP = SQL.params({ ids: SQL.list(Schema.players.eosId) })
const playerNames = SQL.def(
	'playerNames',
	playerNamesP,
	SQL.select({ eosId: Schema.players.eosId, username: Schema.players.username })
		.from(Schema.players)
		.where(SQL.inJson(Schema.players.eosId, playerNamesP.ids)),
)

export const router = {
	// the audit log: most-recent-first, cursor-paginated by time
	list: orpcBase
		.input(z.object({ limit: z.number().int().min(1).max(200).default(50), before: z.number().optional() }))
		.handler(async ({ context: ctx, input }) => {
			const rows = DB.all(
				ctx,
				input.before === undefined
					? listEvents(false)({ before: undefined, limit: input.limit })
					: listEvents(true)({ before: new Date(input.before), limit: input.limit }),
			)
			const events = AppEvents.fromRows({ ...ctx, log: module.getLogger() }, rows, 'the audit list')
			// the audit log has no roster to resolve against, so the players an event names (its actor, its targets)
			// would otherwise read as eos ids
			const playerIds = [
				...new Set(
					events.flatMap((e) => [...(e.actor.type === 'ingame-user' ? [e.actor.playerId] : []), ...AppEvents.involvedPlayerIds(e)]),
				),
			]
			const playerRows = playerIds.length > 0 ? DB.all(ctx, playerNames({ ids: playerIds })) : []
			return { code: 'ok' as const, events, playerNames: Object.fromEntries(playerRows.map((p) => [p.eosId, p.username])) }
		}),
}
