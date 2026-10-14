import { Mutex } from 'async-mutex'

// Runs the calls that share a key one at a time, in the order they were made. A key is forgotten once nothing is
// running or waiting on it, so keys can be made per caller without being cleaned up.
//
// The order is fixed when `run` is called, not when the callback first awaits, so a handler that calls `run` before its
// own first await handles its calls in the order they reached it. A server dispatch handler needs that: it awaits checks
// of varying length before applying an op, and two ops from one client would otherwise apply in whichever order those
// checks finished.
export function create() {
	const lanes = new Map<string, { mutex: Mutex; pending: number }>()
	return async function run<T>(key: string, cb: () => Promise<T>): Promise<T> {
		let lane = lanes.get(key)
		if (!lane) {
			lane = { mutex: new Mutex(), pending: 0 }
			lanes.set(key, lane)
		}
		lane.pending++
		try {
			return await lane.mutex.runExclusive(cb)
		} finally {
			if (--lane.pending === 0) lanes.delete(key)
		}
	}
}
