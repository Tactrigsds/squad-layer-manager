import * as Config from '@/server/config'
import * as Discord from '@/server/systems/discord'
import * as ServerSettings from '@/server/systems/server-settings'
import * as SharedLayerList from '@/server/systems/shared-layer-list.server'
import * as FilterEntity from './systems/filter-entity'
import * as LayerQueries from './systems/layer-queries.server'
import * as LayerQueue from './systems/layer-queue'
import * as MatchHistory from './systems/match-history'
import * as Rbac from './systems/rbac.system'
import * as SquadServer from './systems/squad-server'
import * as Users from './systems/users'

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
