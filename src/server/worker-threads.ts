import type { Worker } from 'node:worker_threads'

// The app's live worker threads by name, for reporting what each one holds. A worker drops out when it exits.

const live = new Map<Worker, string>()

export function track(name: string, worker: Worker) {
	live.set(worker, name)
	worker.once('exit', () => live.delete(worker))
}

export async function heapStatistics() {
	return await Promise.all(
		[...live].map(async ([worker, name]) => ({ name, threadId: worker.threadId, heap: await worker.getHeapStatistics() })),
	)
}
