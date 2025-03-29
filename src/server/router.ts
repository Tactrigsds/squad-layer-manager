import { z } from 'zod'

import * as M from '@/models.ts'

import { CONFIG } from '@/server/config.ts'
import { filtersRouter } from './systems/filters-entity.ts'
import * as LayerQueries from './systems/layer-queries.ts'
import * as LayerQueue from './systems/layer-queue.ts'
import * as Rbac from './systems/rbac.system.ts'
import * as SquadServer from './systems/squad-server.ts'
import * as Users from './systems/users.ts'
import { procedure, router } from './trpc.server.ts'

export let appRouter: ReturnType<typeof setupTrpcRouter>
export type AppRouter = typeof appRouter

export function setupTrpcRouter() {
	const _appRouter = router({
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
