import * as Config from '@/server/config.ts'
import * as Discord from '@/server/systems/discord.ts'
import * as ServerSettings from '@/server/systems/server-settings.ts'
import * as SharedLayerList from '@/server/systems/shared-layer-list.server.ts'
import * as FilterEntity from './systems/filter-entity.ts'
import * as LayerQueries from './systems/layer-queries.server.ts'
import * as LayerQueue from './systems/layer-queue.ts'
import * as MatchHistory from './systems/match-history.ts'
import * as Rbac from './systems/rbac.system.ts'
import * as SquadServer from './systems/squad-server.ts'
import * as Users from './systems/users.ts'

export type OrpcAppRouter = typeof orpcAppRouter

export const orpcAppRouter = {
	squadServer: SquadServer.orpcRouter,
	layerQueue: LayerQueue.orpcRouter,
	config: Config.router,
	layerQueries: LayerQueries.orpcRouter,
	sharedLayerList: SharedLayerList.orpcRouter,
	discord: Discord.orpcRouter,
	matchHistory: MatchHistory.matchHistoryRouter,
	filters: FilterEntity.filtersRouter,
	rbac: Rbac.orpcRouter,
	users: Users.orpcRouter,
	serverSettings: ServerSettings.orpcRouter,
}
