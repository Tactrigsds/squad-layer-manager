import { eq, sql } from 'drizzle-orm'
import { z } from 'zod'

import * as M from '@/models.ts'

import { mockSquadRouter as mockSquadServerRouter, setupMockSquadRouter } from './mock-squad-router.ts'
import * as Schema from './schema.ts'
import { filtersRouter } from './systems/filters-entity.ts'
import * as LQ from './systems/layer-queue.ts'
import * as LayersQuery from './systems/layers-query.ts'
import { procedure, procedureWithInput, router } from './trpc.ts'

export let appRouter: ReturnType<typeof setupTrpcRouter>
export type AppRouter = typeof appRouter

export function setupTrpcRouter() {
	setupMockSquadRouter()
	const _appRouter = router({
		getLoggedInUser: procedure.query(async ({ ctx }) => {
			const [row] = await ctx.db
				.select()
				.from(Schema.sessions)
				.where(eq(Schema.sessions.id, ctx.sessionId))
				.leftJoin(Schema.users, eq(Schema.sessions.userId, Schema.users.discordId))
			return row.users
		}),
		// could be merged with getLayers if this becomes too unweildy, mostly duplicate functionality
		getUniqueValues: procedureWithInput(
			z.object({
				columns: z.array(z.enum(M.COLUMN_TYPE_MAPPINGS.string)),
				limit: z.number().positive().max(500).default(500),
				filter: M.FilterNodeSchema.optional(),
			})
		).query(async ({ input, ctx }) => {
			type Columns = (typeof input.columns)[number]
			const selectObj = input.columns.reduce(
				(acc, column) => {
					acc[column] = Schema.layers[column]
					return acc
				},
				{} as { [key in Columns]: (typeof Schema.layers)[key] }
			)

			const rows = await ctx.db
				.select(selectObj)
				.from(Schema.layers)
				// this could be a having clause, but since we're mainly using this for filtering ids, the cardinality is fine before the group-by anyway
				.where(input.filter ? await LayersQuery.getWhereFilterConditions(input.filter, [], ctx) : sql`1=1`)
				.groupBy(...input.columns.map((column) => Schema.layers[column]))
				.limit(input.limit)
			return rows
		}),
		getLayers: procedureWithInput(LayersQuery.LayersQuerySchema).query(LayersQuery.runLayersQuery),
		watchServerUpdates: procedure.subscription(LQ.watchServerStateUpdates),
		updateQueue: procedureWithInput(M.QueueUpdateSchema).mutation(async ({ input, ctx }) => {
			return LQ.processLayerQueueUpdate(input, ctx)
		}),
		pollServerInfo: procedure.subscription(({ ctx }) => LQ.pollServerState(ctx)),
		watchNowPlayingState: procedure.subscription(({ ctx }) => LQ.watchCurrentLayerState(ctx)),
		watchNextLayerState: procedure.subscription(({ ctx }) => LQ.watchNextLayerState(ctx)),
		mockSquadServer: mockSquadServerRouter,
		filters: filtersRouter,
	})
	appRouter = _appRouter
	return _appRouter
}
