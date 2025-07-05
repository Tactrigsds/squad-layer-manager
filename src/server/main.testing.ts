import * as Schema from '$root/drizzle/schema'
import { sleep } from '@/lib/async.ts'
import { formatVersion } from '@/lib/versioning.ts'
import * as CS from '@/models/context-shared'
import * as FB from '@/models/filter-builders'
import * as FilterEntity from '@/server/systems/filter-entity'
import * as LayerQueries from '@/systems.shared/layer-queries.shared.ts'
import * as Otel from '@opentelemetry/api'
import * as Log from '../server/logger'
import * as Config from './config.ts'
import * as C from './context.ts'
import * as DB from './db'
import * as Env from './env.ts'
import * as TrpcRouter from './router'
import * as Cli from './systems/cli.ts'
import * as Discord from './systems/discord.ts'
import * as Fastify from './systems/fastify.ts'
import * as LayerDb from './systems/layer-db.server.ts'
import * as LayerQueriesServer from './systems/layer-queries.server.ts'
import * as LayerQueue from './systems/layer-queue.ts'
import * as MatchHistory from './systems/match-history.ts'
import * as Rbac from './systems/rbac.system.ts'
import * as Sessions from './systems/sessions.ts'
import * as SquadServer from './systems/squad-server'

const tracer = Otel.trace.getTracer('squad-layer-manager')
const envBuilder = Env.getEnvBuilder({ ...Env.groups.general })
let ENV!: ReturnType<typeof envBuilder>
await C.spanOp('main', { tracer }, async () => {
	Env.ensureEnvSetup()
	Log.ensureLoggerSetup()
	await DB.setup()

	await FilterEntity.setup()
	await MatchHistory.setup()
	await LayerDb.setup({ skipHash: true })
	const ctx = LayerQueriesServer.resolveLayerQueryCtx({ log: Log.baseLogger })
	const filter = FB.and([FB.comp(FB.eq('Map', 'Lashkar')), FB.comp(FB.eq('Gamemode', 'TC'))])
	const res = await LayerQueries.queryLayers({
		input: {
			constraints: [{ type: 'filter-anon', filter, applyAs: 'where-condition', id: 'idk' }],
			previousLayerIds: [],
			pageSize: 50,
			pageIndex: 0,
		},
		ctx,
	})
	console.log(res)
})()
	.catch((err) => {
		if (Log.baseLogger) Log.baseLogger.fatal(err)
		console.error(err)
		return 1
	})
	.then(async (status) => {
		Log.baseLogger.warn('sleeping before exit: %s', status)
		// sleep so any latent logs and traces are flushed in time
		await sleep(1000)
		process.exit(status ?? 0)
	})
