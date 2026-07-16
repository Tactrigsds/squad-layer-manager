import * as Schema from '$root/drizzle/schema'
import * as AppEvents from '@/models/app-events.models'
import type * as USR from '@/models/users.models'
import type * as C from '@/server/context'
import * as DB from '@/server/db'
import { initModule } from '@/server/logger'
import { getOrpcBase } from '@/server/orpc-base'
import * as Otel from '@/systems/otel.server'
import * as Rbac from '@/systems/rbac.server'
import * as E from 'drizzle-orm'
import { z } from 'zod'

const module = initModule('app-events')
const orpcBase = getOrpcBase(module)

// persists an app event to the audit log. server-scoped events additionally flow through SquadServer.emitAppEvent
// (which pushes them into the live activity feed); global (serverId=null) events are audit-only and call this directly.
export async function persistAppEvent(ctx: C.Db, appEvent: AppEvents.AppEvent) {
	// stamp the emitting process so events can be grouped by run, and restart detection can correlate by instance
	appEvent.instanceId = Otel.instanceId
	await ctx.db().insert(Schema.appEvents).values(AppEvents.toRow(appEvent))
}

// set once at boot (before this instance's APP_STARTED is persisted): the user who restarted SLM, if this boot
// followed a restart-slm command, else null. A restart is detected when the most recent APP_RESTARTED is newer than
// the previous instance's APP_STARTED. Read by the "SLM started/restarted" admin warn, which resolves the display name.
export let restartInfo: { userId: USR.UserId } | null = null

export async function detectRestartAtBoot(ctx: C.Db) {
	// the instance that ran immediately before this one (our own APP_STARTED isn't persisted yet at this point)
	const [lastStart] = await ctx.db().select({ instanceId: Schema.appEvents.instanceId }).from(Schema.appEvents)
		.where(E.eq(Schema.appEvents.type, 'APP_STARTED')).orderBy(E.desc(Schema.appEvents.time)).limit(1)
	if (!lastStart?.instanceId) {
		restartInfo = null
		return
	}
	// did that exact instance restart itself (as opposed to crashing / being replaced)? correlating by instanceId is
	// clock-independent and can't be fooled by an older, unrelated restart.
	const [restart] = await ctx.db().select({ actorUserId: Schema.appEvents.actorUserId }).from(Schema.appEvents)
		.where(E.and(E.eq(Schema.appEvents.type, 'APP_RESTARTED'), E.eq(Schema.appEvents.instanceId, lastStart.instanceId))).limit(1)
	if (!restart?.actorUserId) {
		restartInfo = null
		return
	}
	restartInfo = { userId: restart.actorUserId }
}

export const router = {
	// the audit log: most-recent-first, cursor-paginated by time
	list: orpcBase
		.input(z.object({ limit: z.number().int().min(1).max(200).default(50), before: z.number().optional() }))
		.handler(async ({ context: _ctx, input }) => {
			const ctx = DB.addPooledDb(_ctx as any)
			const denyRes = await Rbac.tryDenyGlobalSettingsRead(ctx)
			if (denyRes) return denyRes
			const rows = await ctx
				.db()
				.select()
				.from(Schema.appEvents)
				.where(input.before !== undefined ? E.lt(Schema.appEvents.time, new Date(input.before)) : undefined)
				.orderBy(E.desc(Schema.appEvents.time))
				.limit(input.limit)
			const events = rows.map(AppEvents.fromRow).filter((e: AppEvents.AppEvent | null): e is AppEvents.AppEvent => e !== null)
			if (events.length < rows.length) {
				module.getLogger().warn('dropped %d unparseable app-event row(s) from audit list', rows.length - events.length)
			}
			return { code: 'ok' as const, events }
		}),
}
