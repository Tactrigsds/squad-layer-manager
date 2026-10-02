// Runs one task at a time. An idle scheduler picks the pending task with the lowest priority number, ties going
// to the earliest. A barrier runs only once everything queued before it has run, and nothing queued after it runs
// before it, so a barrier splits the queue into segments that run in order.

export type Task = {
	id: string
	priority: number
	barrier: boolean
	run: (signal: AbortSignal) => Promise<void>
}

export class TaskScheduler {
	private pending: Task[] = []
	private running: { task: Task; controller: AbortController } | null = null

	constructor(private onError: (error: unknown, task: Task) => void) {}

	get runningId() {
		return this.running?.task.id ?? null
	}

	get pendingIds() {
		return this.pending.map((task) => task.id)
	}

	enqueue(task: Task) {
		this.pending.push(task)
		this.pump()
	}

	// drops a pending task, or aborts the signal of the running one. Returns whether the id was found
	cancel(id: string) {
		if (this.running?.task.id === id) {
			this.running.controller.abort()
			return true
		}
		const index = this.pending.findIndex((task) => task.id === id)
		if (index === -1) return false
		this.pending.splice(index, 1)
		return true
	}

	private pickNext() {
		let best = -1
		for (let i = 0; i < this.pending.length; i++) {
			const task = this.pending[i]
			if (task.barrier) return best === -1 ? i : best
			if (best === -1 || task.priority < this.pending[best].priority) best = i
		}
		return best
	}

	private pump() {
		if (this.running) return
		const index = this.pickNext()
		if (index === -1) return
		const [task] = this.pending.splice(index, 1)
		const controller = new AbortController()
		this.running = { task, controller }
		let done: Promise<void>
		try {
			done = task.run(controller.signal)
		} catch (error) {
			done = Promise.reject(error)
		}
		void done
			.catch((error) => this.onError(error, task))
			.finally(() => {
				this.running = null
				this.pump()
			})
	}
}
