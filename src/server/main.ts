import { sleep } from '@/lib/async.ts'
import * as CoreRcon from '@/lib/rcon/core-rcon'
import * as FetchAdminLists from '@/lib/rcon/fetch-admin-lists'
import { formatVersion } from '@/lib/versioning.ts'

import * as AppEvents from '@/models/app-events.models'
import * as AppEventsSys from '@/systems/app-events.server'
import * as Backups from '@/systems/backups.server'
import * as Battlemetrics from '@/systems/battlemetrics.server'
import * as CleanupSys from '@/systems/cleanup.server'
import * as Cli from '@/systems/cli.server'
import * as Commands from '@/systems/commands.server'
import * as Discord from '@/systems/discord.server'
import * as Fastify from '@/systems/fastify.server'
import * as FilterEntity from '@/systems/filter-entity.server'
import * as LayerData from '@/systems/layer-data.server'
import * as LayerDb from '@/systems/layer-db.server'
import * as LayerQueries from '@/systems/layer-queries.server'
import * as LayerQueue from '@/systems/layer-queue.server'
import * as MatchHistory from '@/systems/match-history.server'
import * as Metrics from '@/systems/metrics.server'
import * as PersistedCache from '@/systems/persistedCache.server'
import * as Rbac from '@/systems/rbac.server'
import * as Sessions from '@/systems/sessions.server'
import * as Settings from '@/systems/settings.server'
import * as SquadLogsReceiver from '@/systems/squad-logs-receiver.server'
import * as SquadRcon from '@/systems/squad-rcon.server'
import * as SquadServer from '@/systems/squad-server.server'
import * as Teamswaps from '@/systems/teamswaps.server'
import * as UserPresence from '@/systems/user-presence.server'
import * as Users from '@/systems/users.server'
import * as Vote from '@/systems/vote.server'
import * as WsSession from '@/systems/ws-session.server'

import * as CS from '@/models/context-shared'
import * as Config from './config.server.ts'
import * as C from './context.ts'
import * as DB from './db'
import * as Env from './env.ts'
import { ensureLoggerSetup, initModule } from './logger.ts'

const envBuilder = Env.getEnvBuilder({ ...Env.groups.general })
let ENV!: ReturnType<typeof envBuilder>
const module = initModule('main')

await Cli.ensureCliParsed()
Env.ensureEnvSetup()
ENV = envBuilder()
ensureLoggerSetup()
const log = module.getLogger()

await C.spanOp('main', { module }, async () => {
	// Use provided env file path if available
	log.info('-------- Starting SLM version %s --------', formatVersion(ENV.PUBLIC_GIT_BRANCH, ENV.PUBLIC_GIT_SHA))
	CleanupSys.setup()
	// layer components/factionunit configs are consumed synchronously all over the app (including
	// while parsing config), so they load before everything else
	await LayerData.setup()
	// Initialize all module loggers
	CoreRcon.setup()
	FetchAdminLists.setup()
	Commands.setup()
	LayerQueries.setup()
	LayerQueue.setup()
	UserPresence.setup()
	MatchHistory.setup()
	SquadRcon.setup()
	Teamswaps.setup()
	Users.setup()
	Vote.setup()
	WsSession.setup()
	// resolves its config synchronously but opens the db in the background, so it stays off the
	// critical path; we await `LayerDb.ready` below, right before the db can first be queried
	await LayerDb.setup()
	await DB.setup()
	// starts its own background loop; nothing else depends on it, but it needs the db open
	Backups.setup()
	await FilterEntity.setup()
	PersistedCache.setup()
	await Battlemetrics.setup()
	Rbac.setup()
	void Sessions.setup()
	await Settings.setup(DB.addPooledDb({ ...CS.init(), signal: CleanupSys.shutdownSignal }))
	// after Settings.setup so GLOBAL_SETTINGS.layerTable exists; also subscribes to settings changes to re-push
	Config.setup()
	await SquadLogsReceiver.setup()
	// detect (before this instance's APP_STARTED is persisted) whether we came up via a restart-slm command, so the
	// per-server "SLM started/restarted" admin warn (sent during SquadServer.setup) can name who restarted it
	await AppEventsSys.detectRestartAtBoot(DB.addPooledDb({ ...CS.init(), signal: CleanupSys.shutdownSignal }))
	await Promise.all([SquadServer.setup(), Discord.setup()])

	// after SquadServer.setup, since its gauges read SquadServer.globalState
	Metrics.setup()
	await AppEventsSys.persistAppEvent(
		DB.addPooledDb({ ...CS.init(), signal: CleanupSys.shutdownSignal }),
		AppEvents.create<AppEvents.AppStarted>({
			type: 'APP_STARTED',
			actor: { type: 'system' },
			serverId: null,
			matchId: null,
			causeId: null,
			version: formatVersion(ENV.PUBLIC_GIT_BRANCH, ENV.PUBLIC_GIT_SHA),
		}),
	)
	const { serverClosed } = await Fastify.setup()
	if (ENV.NODE_ENV === 'development') {
		void import('./console.ts')
	}
	const closedMsg = await serverClosed
	log.info('server closed: %s', closedMsg)
	return 0
})()
	.catch((err) => {
		if (log) log.fatal(err)
		console.error(err)
		return 1
	})
	.then(async (status) => {
		log.warn('sleeping before exit: %s', status)
		// sleep so any latent logs and traces are flushed in time
		await sleep(1000)
		process.exit(status)
	})
