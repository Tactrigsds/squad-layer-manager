import { z } from 'zod'

import * as M from '@/models.ts'

import { filtersRouter } from './systems/filters-entity.ts'
import * as LayerQueue from './systems/layer-queue.ts'
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
		getLayersGroupedBy: procedure.input(LayersQuery.LayersQueryGroupedByInputSchema).query(async ({ input, ctx }) => {
			return await LayersQuery.runLayersQueryGroupedBy(ctx, input)
		}),
		getLayers: procedure.input(LayersQuery.LayersQueryInputSchema).query(LayersQuery.runLayersQuery),
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
		layerQueue: LayerQueue.layerQueueRouter,
		squadServer: SquadServer.squadServerRouter,
		filters: filtersRouter,
	})
	appRouter = _appRouter
	return _appRouter
}
