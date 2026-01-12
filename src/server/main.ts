import { sleep } from '@/lib/async.ts'
import * as CoreRcon from '@/lib/rcon/core-rcon'
import * as FetchAdminLists from '@/lib/rcon/fetch-admin-lists'
import { formatVersion } from '@/lib/versioning.ts'
import * as CleanupSys from '@/systems/cleanup.server'
import * as Cli from '@/systems/cli.server'
import * as Commands from '@/systems/commands.server'
import * as Discord from '@/systems/discord.server'
import * as Fastify from '@/systems/fastify.server'
import * as FilterEntity from '@/systems/filter-entity.server'
import * as LayerDb from '@/systems/layer-db.server'
import * as LayerQueries from '@/systems/layer-queries.server'
import * as LayerQueue from '@/systems/layer-queue.server'
import * as MatchHistory from '@/systems/match-history.server'
import * as Rbac from '@/systems/rbac.server'
import * as Sessions from '@/systems/sessions.server'
import * as SharedLayerList from '@/systems/shared-layer-list.server'
import * as SquadLogsReceiver from '@/systems/squad-logs-receiver.server'
import * as SquadRcon from '@/systems/squad-rcon.server'
import * as SquadServer from '@/systems/squad-server.server'
import * as Users from '@/systems/users.server'
import * as Vote from '@/systems/vote.server'
import * as WsSession from '@/systems/ws-session.server'
import * as Otel from '@opentelemetry/api'
import * as Config from './config.ts'
import * as C from './context.ts'
import * as DB from './db'
import * as Env from './env.ts'
import { baseLogger, ensureLoggerSetup } from './logger.ts'

const tracer = Otel.trace.getTracer('squad-layer-manager')
const envBuilder = Env.getEnvBuilder({ ...Env.groups.general })
let ENV!: ReturnType<typeof envBuilder>
await C.spanOp('main', { tracer }, async () => {
	// Use provided env file path if available
	await Cli.ensureCliParsed()
	Env.ensureEnvSetup()
	ENV = envBuilder()
	ensureLoggerSetup()
	// Initialize all module loggers
	CoreRcon.setup()
	FetchAdminLists.setup()
	Commands.setup()
	LayerQueries.setup()
	LayerQueue.setup()
	MatchHistory.setup()
	SquadRcon.setup()
	Users.setup()
	Vote.setup()
	WsSession.setup()
	CleanupSys.setup()
	baseLogger.info('-------- Starting SLM version %s --------', formatVersion(ENV.PUBLIC_GIT_BRANCH, ENV.PUBLIC_GIT_SHA))
	await Promise.all([Config.ensureSetup(), LayerDb.setup(), DB.setup(), FilterEntity.setup()])
	SquadLogsReceiver.setup()
	Rbac.setup()
	void Sessions.setup()
	await Promise.all([SquadServer.setup(), Discord.setup()])
	SharedLayerList.setup()
	const { serverClosed } = await Fastify.setup()
	if (ENV.NODE_ENV === 'development') {
		void import('./console.ts')
	}
	const closedMsg = await serverClosed
	baseLogger.info('server closed: %s', closedMsg)
	return 0
})()
	.catch((err) => {
		if (baseLogger) baseLogger.fatal(err)
		console.error(err)
		return 1
	})
	.then(async (status) => {
		baseLogger.warn('sleeping before exit: %s', status)
		// sleep so any latent logs and traces are flushed in time
		await sleep(1000)
		process.exit(status)
	})
