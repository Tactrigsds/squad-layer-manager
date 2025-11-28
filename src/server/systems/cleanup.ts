import * as Env from '@/server/env'
import { baseLogger } from '../logger'

const buildEnv = Env.getEnvBuilder({ ...Env.groups.general })
let ENV!: ReturnType<typeof buildEnv>
const tasks: (CleanupTaskCb | null)[] = []
export type CleanupTaskCb = () => void | Promise<void>

/**
 * Registers a function to run on SIGTERM
 */
export function register(cb: CleanupTaskCb) {
	const idx = tasks.length
	tasks.push(cb)

	return idx
}

export function unregister(idx: number) {
	tasks[idx] = null
}

export function setup() {
	ENV = buildEnv()
	const ctx = { log: baseLogger }
	process.on('SIGTERM', async () => {
		const res = await Promise.allSettled(tasks.map(task => task?.() ?? Promise.resolve()))
		res.forEach((result) => {
			if (result.status === 'rejected') {
				ctx.log.error('Cleanup task failed', result.reason)
			}
		})
		ctx.log.info('Cleanup complete')
		if (ENV.NODE_ENV === 'development') {
			// we have to be more forceful here if a debugger is attached
			ctx.log.info('Exiting forcefully in dev')
			// Give logs a moment to flush, then force exit
			setTimeout(() => process.exit(1), 100).unref()
		} else {
			process.exit(0)
		}
	})
}
