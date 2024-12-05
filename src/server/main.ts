import * as Config from './config.ts'
import * as DB from './db'
import { setupEnv } from './env.ts'
import { setupLogger } from './logger.ts'
import * as TrpcRouter from './router'
import * as Discord from './systems/discord.ts'
import * as Fastify from './systems/fastify.ts'
import * as LayerQueue from './systems/layer-queue.ts'
import * as Sessions from './systems/sessions.ts'
import * as SquadServer from './systems/squad-server'

// TODO nice graceful shutdowns
setupEnv()
await setupLogger()
await Config.setupConfig()
DB.setupDatabase()
Sessions.setupSessions()
await SquadServer.setupSquadServer()
await LayerQueue.setupLayerQueueAndServerState()
await Discord.setupDiscordSystem()
TrpcRouter.setupTrpcRouter()
await Fastify.setupFastify()
