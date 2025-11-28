import { baseLogger } from '../logger'

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
	const ctx = { log: baseLogger }
	process.on('SIGTERM', async () => {
		try {
			await Promise.all(tasks.map(task => task?.()))
			ctx.log.info('Cleanup complete')
		} catch (error) {
			ctx.log.error(error, 'Error during cleanup: %s', (error as any)?.message ?? error)
		}
		process.exit(0)
	})
}
