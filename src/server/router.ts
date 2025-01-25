import { z } from 'zod'

import * as M from '@/models.ts'

import { filtersRouter } from './systems/filters-entity.ts'
import * as LayerQueue from './systems/layer-queue.ts'
import * as LayerQueries from './systems/layer-queries.ts'
import * as SquadServer from './systems/squad-server.ts'
import { CONFIG } from '@/server/config.ts'
import { procedure, router } from './trpc.server.ts'
import * as Rbac from './systems/rbac.system.ts'
import * as Users from './systems/users.ts'

export let appRouter: ReturnType<typeof setupTrpcRouter>
export type AppRouter = typeof appRouter

export function setupTrpcRouter() {
	const _appRouter = router({
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
				return await LayerQueries.getHistoryFilter(ctx, input.historyFilters, [...queuedLayerIds])
			}),
		layerQueue: LayerQueue.layerQueueRouter,
		layers: LayerQueries.layersRouter,
		squadServer: SquadServer.squadServerRouter,
		filters: filtersRouter,
		config: procedure.query(async () => {
			return CONFIG
		}),
		users: Users.usersRouter,
		rbac: Rbac.rbacRouter,
	})
	appRouter = _appRouter
	return _appRouter
}
