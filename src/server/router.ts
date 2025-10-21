import * as Config from '@/server/config.ts'
import * as ServerSettings from '@/server/systems/server-settings.ts'
import * as SharedLayerList from '@/server/systems/shared-layer-list.server.ts'
import * as FilterEntity from './systems/filter-entity.ts'
import * as LayerQueries from './systems/layer-queries.server.ts'
import * as LayerQueue from './systems/layer-queue.ts'
import * as MatchHistory from './systems/match-history.ts'
import * as Rbac from './systems/rbac.system.ts'
import * as SquadServer from './systems/squad-server.ts'
import * as Users from './systems/users.ts'
import { procedure, router } from './trpc.server.ts'

export let appRouter: ReturnType<typeof setup>
export type AppRouter = typeof appRouter

export function setup() {
	const _appRouter = router({
		layerQueue: LayerQueue.layerQueueRouter,
		squadServer: SquadServer.router,
		filters: FilterEntity.filtersRouter,
		config: procedure.query(({ ctx }) => {
			return Config.getPublicConfig(ctx.wsClientId)
		}),
		users: Users.usersRouter,
		rbac: Rbac.rbacRouter,
		matchHistory: MatchHistory.matchHistoryRouter,
		layerQueries: LayerQueries.layerQueriesRouter,
		sharedLayerList: SharedLayerList.router,
		serverSettings: ServerSettings.router,
	})

	appRouter = _appRouter
	return _appRouter
}
