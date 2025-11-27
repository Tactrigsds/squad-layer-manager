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
	process.on('SIGTERM', async () => {
		try {
			await Promise.all(tasks.map(task => task?.()))
		} finally {
			process.exit(0)
		}
	})
}
