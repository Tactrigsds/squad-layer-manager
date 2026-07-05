import * as Schema from '$root/drizzle/schema'
import * as AppEvents from '@/models/app-events.models'
import * as RBAC from '@/rbac.models'
import type * as C from '@/server/context'
import * as DB from '@/server/db'
import { initModule } from '@/server/logger'
import { getOrpcBase } from '@/server/orpc-base'
import * as Rbac from '@/systems/rbac.server'
import * as E from 'drizzle-orm'
import { z } from 'zod'

const module = initModule('app-events')
const orpcBase = getOrpcBase(module)

// persists an app event to the audit log. server-scoped events additionally flow through SquadServer.emitAppEvent
// (which pushes them into the live activity feed); global (serverId=null) events are audit-only and call this directly.
export async function persistAppEvent(ctx: C.Db, appEvent: AppEvents.AppEvent) {
	await ctx.db().insert(Schema.appEvents).values(AppEvents.toRow(appEvent))
}

export const router = {
	// the audit log: most-recent-first, cursor-paginated by time
	list: orpcBase
		.input(z.object({ limit: z.number().int().min(1).max(200).default(50), before: z.number().optional() }))
		.handler(async ({ context: _ctx, input }) => {
			const ctx = DB.addPooledDb(_ctx as any)
			const denyRes = await Rbac.tryDenyPermissionsForUser(ctx, RBAC.perm('admin:manage-global-settings'))
			if (denyRes) return denyRes
			const rows = await ctx
				.db()
				.select()
				.from(Schema.appEvents)
				.where(input.before !== undefined ? E.lt(Schema.appEvents.time, new Date(input.before)) : undefined)
				.orderBy(E.desc(Schema.appEvents.time))
				.limit(input.limit)
			return { code: 'ok' as const, events: rows.map(AppEvents.fromRow) }
		}),
}
