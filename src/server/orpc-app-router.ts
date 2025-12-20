import * as Config from '@/server/config'
import * as Discord from '@/systems/discord.server'
import * as FilterEntity from '@/systems/filter-entity.server'
import * as LayerQueries from '@/systems/layer-queries.server'
import * as LayerQueue from '@/systems/layer-queue.server'
import * as MatchHistory from '@/systems/match-history.server'
import * as Rbac from '@/systems/rbac.server'
import * as ServerSettings from '@/systems/server-settings.server'
import * as SharedLayerList from '@/systems/shared-layer-list.server'
import * as SquadServer from '@/systems/squad-server.server'
import * as Users from '@/systems/users.server'
import * as Vote from '@/systems/vote.server'

export type OrpcAppRouter = typeof orpcAppRouter

export const orpcAppRouter = {
	squadServer: SquadServer.orpcRouter,
	layerQueue: LayerQueue.router,
	vote: Vote.router,
	config: Config.router,
	layerQueries: LayerQueries.router,
	sharedLayerList: SharedLayerList.orpcRouter,
	discord: Discord.orpcRouter,
	matchHistory: MatchHistory.matchHistoryRouter,
	filters: FilterEntity.filtersRouter,
	rbac: Rbac.orpcRouter,
	users: Users.orpcRouter,
	serverSettings: ServerSettings.orpcRouter,
}
