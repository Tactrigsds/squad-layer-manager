import { sleep } from '@/lib/async.ts'
import { formatVersion } from '@/lib/versioning.ts'
import * as Otel from '@opentelemetry/api'
import * as Config from './config.ts'
import * as C from './context.ts'
import * as DB from './db'
import * as Env from './env.ts'
import { baseLogger, ensureLoggerSetup } from './logger.ts'
import * as TrpcRouter from './router'
import * as Cli from './systems/cli.ts'
import * as Discord from './systems/discord.ts'
import * as Fastify from './systems/fastify.ts'
import * as LayerQueue from './systems/layer-queue.ts'
import * as MatchHistory from './systems/match-history.ts'
import * as Rbac from './systems/rbac.system.ts'
import * as Sessions from './systems/sessions.ts'
import * as SquadServer from './systems/squad-server'

const tracer = Otel.trace.getTracer('squad-layer-manager')
const envBuilder = Env.getEnvBuilder({ ...Env.groups.general })
let ENV!: ReturnType<typeof envBuilder>
await C.spanOp('main', { tracer }, async () => {
	// Use provided env file path if available
	await Cli.ensureCliParsed()
	Env.ensureEnvSetup()
	ENV = envBuilder()
	ensureLoggerSetup()
	await Config.ensureConfigSetup()
	baseLogger.info('Starting SLM version %', formatVersion(ENV.PUBLIC_GIT_BRANCH, ENV.PUBLIC_GIT_SHA))
	await DB.setupDatabase()
	Rbac.setup()
	Sessions.setupSessions()
	await MatchHistory.setup()
	SquadServer.setupSquadServer()
	await Discord.setupDiscordSystem()
	TrpcRouter.setupTrpcRouter()
	void LayerQueue.setup()
	const { serverClosed } = await Fastify.setupFastify()
	const closedMsg = await serverClosed
	baseLogger.info('server closed: %s', closedMsg)
	return 0
})()
	.catch((err) => {
		if (baseLogger) baseLogger.fatal(err)
		else console.error(err)
		return 1
	})
	.then(async (status) => {
		baseLogger.warn('sleeping before exit: %s', status)
		// sleep so any latent logs and traces are flushed in time
		await sleep(1000)
		process.exit(status)
	})
