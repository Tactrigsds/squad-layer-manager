import * as Cleanup from '@/lib/cleanup'
import * as CS from '@/models/context-shared'
import * as C from '@/server/context'
import * as Env from '@/server/env'
import { initModule } from '@/server/logger'

const module = initModule('layer-queue')
let log!: CS.Logger

const buildEnv = Env.getEnvBuilder({ ...Env.groups.general })
let ENV!: ReturnType<typeof buildEnv>
const taskRegistry: (Cleanup.Tasks | null)[] = []
/**
 * Registers a function to run on SIGTERM
 */
export function register(...tasks: Cleanup.Tasks) {
	const idx = tasks.length
	tasks.push(tasks)

	return idx
}

export function unregister(idx: number) {
	taskRegistry[idx] = null
}

export function setup() {
	ENV = buildEnv()
	log = module.getLogger()
	if (ENV.NODE_ENV === 'development') return
	const ctx = { ...CS.init(), log }
	process.on(
		'SIGTERM',
		async () => {
			for (const tasksList of taskRegistry.toReversed()) {
				if (!tasksList) continue
				await Cleanup.runCleanup(ctx, tasksList)
			}
			log.info('Cleanup complete')
			process.exit(0)
		},
	)
}
