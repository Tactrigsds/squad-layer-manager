import type { MutexInterface } from 'async-mutex'

export function sleep(ms: number, signal?: AbortSignal) {
	return new Promise<void>((resolve, reject) => {
		if (signal?.aborted) return reject(signal.reason)
		const onAbort = () => {
			clearTimeout(timeout)
			reject(signal!.reason)
		}
		const timeout = setTimeout(() => {
			signal?.removeEventListener('abort', onAbort)
			resolve()
		}, ms)
		signal?.addEventListener('abort', onAbort, { once: true })
	})
}

/** Matches DOMExceptions from aborted signals/fetches, and anything else conventionally named AbortError. */
export function isAbortError(error: unknown): boolean {
	return error instanceof Error && error.name === 'AbortError'
}

/**
 * Combines signals into one that aborts when any of them do. Skips undefined entries and avoids
 * allocating a composite when zero or one signal is present.
 */
export function anySignal(...signals: (AbortSignal | undefined)[]): AbortSignal | undefined {
	const present = signals.filter((s): s is AbortSignal => !!s)
	if (present.length <= 1) return present[0]
	return AbortSignal.any(present)
}

/**
 * Resolves/rejects with `promise`, or rejects with `signal.reason` if the signal aborts first.
 * Note: does not cancel the underlying work, only stops waiting on it. For observables, prefer
 * `Rx.Ext.firstValueFrom(observable, signal)` which tears down the subscription on abort.
 */
export function raceAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return promise
	if (signal.aborted) return Promise.reject(signal.reason)
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(signal.reason)
		signal.addEventListener('abort', onAbort, { once: true })
		promise.then(
			(v) => {
				signal.removeEventListener('abort', onAbort)
				resolve(v)
			},
			(e) => {
				signal.removeEventListener('abort', onAbort)
				reject(e)
			},
		)
	})
}

export async function acquireInBlock(mutex: MutexInterface, opts?: { lock?: boolean; priority?: number; signal?: AbortSignal }) {
	const lock = opts?.lock ?? true
	let release: (() => void) | undefined
	if (lock) {
		opts?.signal?.throwIfAborted()
		const acquire = mutex.acquire(opts?.priority)
		try {
			release = await raceAbort(acquire, opts?.signal)
		} catch (err) {
			// if we stopped waiting but the lock is still granted later, free it immediately
			void acquire.then(
				(release) => release(),
				() => {},
			)
			throw err
		}
	}
	return {
		[Symbol.dispose]() {
			release?.()
		},
		mutex,
	}
}
