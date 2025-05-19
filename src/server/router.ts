import { getPublicConfig } from '@/server/config.ts'
import * as FilterEntity from './systems/filter-entity.ts'
import * as LayerQueries from './systems/layer-queries.ts'
import * as LayerQueue from './systems/layer-queue.ts'
import * as MatchHistory from './systems/match-history.ts'
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
		filters: FilterEntity.filtersRouter,
		config: procedure.query(async () => {
			return getPublicConfig()
		}),
		users: Users.usersRouter,
		rbac: Rbac.rbacRouter,
		matchHistory: MatchHistory.matchHistoryRouter,
	})
	appRouter = _appRouter
	return _appRouter
}
