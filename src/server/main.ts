import * as Config from './config.ts'
import * as DB from './db'
import { ensureEnvSetup } from './env.ts'
import * as Otel from '@opentelemetry/api'
import { setupLogger, baseLogger } from './logger.ts'
import * as TrpcRouter from './router'
import * as Discord from './systems/discord.ts'
import * as Fastify from './systems/fastify.ts'
import * as LayerQueue from './systems/layer-queue.ts'
import * as Sessions from './systems/sessions.ts'
import * as SquadServer from './systems/squad-server'
import * as Rbac from './systems/rbac.system.ts'
import * as C from './context.ts'
import { sleep } from '@/lib/async.ts'

// TODO nice graceful shutdowns

const tracer = Otel.trace.getTracer('main')

try {
	await C.spanOp('main', { tracer }, async () => {
		ensureEnvSetup()
		await setupLogger()
		await Config.setupConfig()
		DB.setupDatabase()
		Rbac.setup()
		Sessions.setupSessions()
		SquadServer.setupSquadServer()
		await Discord.setupDiscordSystem()
		TrpcRouter.setupTrpcRouter()
		void LayerQueue.setupLayerQueueAndServerState()
		await Fastify.setupFastify()
	})()
} catch (error) {
	console.log('top level error', error)
	baseLogger.error(error)
	baseLogger.warn('sleeping before exit')
	// wait for any logs to be flushed
	await sleep(250)
	process.exit(1)
}
