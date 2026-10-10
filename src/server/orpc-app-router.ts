import * as Config from '@/server/config.server'
import * as Announcements from '@/systems/announcements.server'
import * as AppEventsSys from '@/systems/app-events.server'
import * as Battlemetrics from '@/systems/battlemetrics.server'
import * as Changelog from '@/systems/changelog.server'
import * as Discord from '@/systems/discord.server'
import * as FilterEdit from '@/systems/filter-edit.server'
import * as FilterEntity from '@/systems/filter-entity.server'
import * as History from '@/systems/history.server'
import * as LayerQueries from '@/systems/layer-queries.server'
import * as LayerQueue from '@/systems/layer-queue.server'
import * as MatchHistory from '@/systems/match-history.server'
import * as PluginsSys from '@/systems/plugins.server'
import * as Rbac from '@/systems/rbac.server'
import * as Sandbox from '@/systems/sandbox.server'
import * as ServerConsole from '@/systems/server-console.server'
import * as Settings from '@/systems/settings.server'
import * as SquadServerRouter from '@/systems/squad-server-router.server'
import * as SwitchRequests from '@/systems/switch-requests.server'
import * as Teamswaps from '@/systems/teamswaps.server'
import * as Timeouts from '@/systems/timeouts.server'
import * as Tutorials from '@/systems/tutorials.server'
import * as UserPresence from '@/systems/user-presence.server'
import * as Users from '@/systems/users.server'
import * as Vote from '@/systems/vote.server'

export type OrpcAppRouter = typeof orpcAppRouter

export const orpcAppRouter = {
	battlemetrics: Battlemetrics.router,
	squadServer: SquadServerRouter.orpcRouter,
	layerQueue: LayerQueue.router,
	vote: Vote.router,
	config: Config.router,
	settings: Settings.router,
	layerQueries: LayerQueries.router,
	userPresence: UserPresence.orpcRouter,
	discord: Discord.orpcRouter,
	matchHistory: MatchHistory.matchHistoryRouter,
	history: History.router,
	filters: FilterEntity.filtersRouter,
	filterEdit: FilterEdit.orpcRouter,
	rbac: Rbac.orpcRouter,
	users: Users.orpcRouter,
	teamswaps: Teamswaps.orpcRouter,
	switchRequests: SwitchRequests.orpcRouter,
	appEvents: AppEventsSys.router,
	announcements: Announcements.router,
	plugins: PluginsSys.router,
	timeouts: Timeouts.router,
	sandbox: Sandbox.orpcRouter,
	serverConsole: ServerConsole.orpcRouter,
	tutorials: Tutorials.orpcRouter,
	changelog: Changelog.orpcRouter,
}
