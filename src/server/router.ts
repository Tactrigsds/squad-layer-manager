import { eq, sql } from 'drizzle-orm'
import { z } from 'zod'

import * as M from '@/models.ts'

import * as Schema from './schema.ts'
import { filtersRouter } from './systems/filters-entity.ts'
import * as Server from './systems/layer-queue.ts'
import * as LayersQuery from './systems/layers-query.ts'
import * as SquadServer from './systems/squad-server.ts'
import { procedure, router } from './trpc.ts'

export let appRouter: ReturnType<typeof setupTrpcRouter>
export type AppRouter = typeof appRouter

export function setupTrpcRouter() {
	const _appRouter = router({
		getLoggedInUser: procedure.query(async ({ ctx }) => {
			return ctx.user
		}),
		// TODO could be merged with getLayers if this becomes too unweildy, mostly duplicate functionality
		getUniqueValues: procedure
			.input(
				z.object({
					columns: z.array(z.enum(M.COLUMN_TYPE_MAPPINGS.string)),
					limit: z.number().positive().max(500).default(500),
					filter: M.FilterNodeSchema.optional(),
				})
			)
			.query(async ({ input, ctx }) => {
				type Columns = (typeof input.columns)[number]
				const selectObj = input.columns.reduce(
					(acc, column) => {
						// @ts-expect-error no idea
						acc[column] = Schema.layers[column]
						return acc
					},
					{} as { [key in Columns]: (typeof Schema.layers)[key] }
				)

				const rows = await ctx
					.db()
					.select(selectObj)
					.from(Schema.layers)
					// this could be a having clause, but since we're mainly using this for filtering ids, the cardinality is fine before the group-by anyway
					.where(input.filter ? await LayersQuery.getWhereFilterConditions(input.filter, [], ctx) : sql`1=1`)
					.groupBy(...input.columns.map((column) => Schema.layers[column]))
					.limit(input.limit)
				return rows
			}),
		getLayers: procedure.input(LayersQuery.LayersQuerySchema).query(LayersQuery.runLayersQuery),
		getHistoryFilter: procedure
			.input(
				z.object({
					historyFilters: z.array(M.HistoryFilterSchema),
					layerQueue: z.array(M.LayerQueueItemSchema),
				})
			)
			.query(async ({ input, ctx }) => {
				const queuedLayerIds = new Set<M.LayerId>()
				for (const item of input.layerQueue) {
					if (item.layerId) {
						queuedLayerIds.add(item.layerId)
					}
					if (item.vote) {
						for (const choice of item.vote.choices) {
							queuedLayerIds.add(choice)
						}
					}
				}
				return await LayersQuery.getHistoryFilter(ctx, input.historyFilters, [...queuedLayerIds])
			}),
		server: Server.serverRouter,
		squadServer: SquadServer.squadServerRouter,
		filters: filtersRouter,
	})
	appRouter = _appRouter
	return _appRouter
}
