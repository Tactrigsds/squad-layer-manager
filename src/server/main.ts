import { sleep } from '@/lib/async.ts'
import { formatVersion } from '@/lib/versioning.ts'
import * as CleanupSys from '@/systems/cleanup.server'
import * as Cli from '@/systems/cli.server'
import * as Discord from '@/systems/discord.server'
import * as Fastify from '@/systems/fastify.server'
import * as FilterEntity from '@/systems/filter-entity.server'
import * as LayerDb from '@/systems/layer-db.server'
import * as Rbac from '@/systems/rbac.server'
import * as Sessions from '@/systems/sessions.server'
import * as SharedLayerList from '@/systems/shared-layer-list.server'
import * as SquadLogsReceiver from '@/systems/squad-logs-receiver.server'
import * as SquadServer from '@/systems/squad-server.server'
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
	CleanupSys.setup()
	baseLogger.info('-------- Starting SLM version %s --------', formatVersion(ENV.PUBLIC_GIT_BRANCH, ENV.PUBLIC_GIT_SHA))
	await Promise.all([Config.ensureSetup(), LayerDb.setup({ log: baseLogger }), DB.setup(), FilterEntity.setup()])
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
