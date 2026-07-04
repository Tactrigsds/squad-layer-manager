import * as Obj from '@/lib/object'

import type { MutexInterface } from 'async-mutex'
import * as Rx from 'rxjs'
import { assertNever } from './type-guards'

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
 * Like Rx.firstValueFrom, but if `signal` aborts first, unsubscribes from the source and rejects
 * with `signal.reason`. Prefer this over `raceAbort(Rx.firstValueFrom(...))`, which would leave the
 * subscription alive until the source emits.
 */
export function firstValueFrom<T>(observable: Rx.Observable<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return Rx.firstValueFrom(observable)
	if (signal.aborted) return Promise.reject(signal.reason)
	return new Promise<T>((resolve, reject) => {
		const sub = new Rx.Subscription()
		const onAbort = () => {
			sub.unsubscribe()
			reject(signal.reason)
		}
		signal.addEventListener('abort', onAbort, { once: true })
		sub.add(
			observable.pipe(Rx.first()).subscribe({
				next: (value) => {
					signal.removeEventListener('abort', onAbort)
					resolve(value)
				},
				error: (err) => {
					signal.removeEventListener('abort', onAbort)
					reject(err)
				},
			}),
		)
	})
}

/**
 * Resolves/rejects with `promise`, or rejects with `signal.reason` if the signal aborts first.
 * Note: does not cancel the underlying work, only stops waiting on it. For observables, prefer
 * `firstValueFrom(observable, signal)` which tears down the subscription on abort.
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

export function distinctDeepEquals<T>() {
	const EMPTY = Symbol('empty')
	let prev: typeof EMPTY | T = EMPTY
	return (o: Rx.Observable<T>) =>
		o.pipe(Rx.concatMap(b => {
			if (Obj.deepEqual(b, prev)) return Rx.EMPTY
			prev = b
			return Rx.of(b)
		}))
}

/**
 * Check roughly every iteration of the event loop for some condition to be met
 */
export async function sleepUntil<T>(cb: () => T | undefined, maxRetries = 25, signal?: AbortSignal) {
	let i = 0
	while (i < maxRetries) {
		signal?.throwIfAborted()
		const v = cb()
		if (v !== undefined) return v as T
		i++
		await sleep(0, signal)
	}
	console.trace('sleepUntil timed out')
}

export async function* toAsyncGenerator<T>(observable: Rx.Observable<T>) {
	type Elt = { code: 'next'; value: T } | { code: 'error'; error: any } | { code: 'complete' }

	// we need a queue here because we're translating push semantics into pull semantics so we would drop emissions otherwise
	const queue: Elt[] = []
	const signal = new Rx.Subject<void>()
	function signalled() {
		return Rx.firstValueFrom(signal)
	}
	function enqueue(elt: Elt) {
		queue.push(elt)
		if (queue.length === 1) signal.next()
	}

	const sub = observable.subscribe({
		next: (value) => {
			enqueue({ code: 'next', value })
		},
		error: (err) => {
			enqueue({ code: 'error', error: err })
		},
		complete: async () => {
			enqueue({ code: 'complete' })
		},
	})

	try {
		while (true) {
			if (queue.length === 0) await signalled()
			const elt = queue.shift()!
			if (elt.code === 'next') {
				yield elt.value
				continue
			}
			if (elt.code === 'error') {
				throw elt.error
			}
			if (elt.code === 'complete') {
				return
			}
			assertNever(elt)
		}
	} finally {
		sub.unsubscribe()
	}
}

export function toCold<T>(task: () => Rx.ObservableInput<T>) {
	return new Rx.Observable<T>((subscriber) => {
		Rx.from(task()).subscribe(subscriber)
	})
}

// crude version of bufferTime which retains a reference to a shared buffer
export function externBufferTime<T>(time: number, buffer: T[]) {
	return (o: Rx.Observable<T>) =>
		o.pipe(
			Rx.map((v) => {
				buffer.push(v)
				return buffer
			}),
			Rx.sample(Rx.interval(time)),
			Rx.map((b) => {
				const result = [...b]
				b.length = 0
				return result
			}),
		)
}

export function filterTruthy() {
	return <T>(o: Rx.Observable<T>) => o.pipe(Rx.filter((v) => !!v))
}

/**
 * Inserts a function with a custom name into the stack trace of an rxjs pipe to make it somewhat more useful. Confusingly doesn't actually log values passing through.
 * The existence of this function is why you should never use rxjs unless you're addicted like me, and should probably use the effect library instead {@link https://effect.website}
 */
export function traceTag<T>(tag: string): Rx.OperatorFunction<T, T> {
	// surely this prevents all potential RCEs right???
	if (!/^[a-zA-Z_$][0-9a-zA-Z_$]*$/.test(tag)) {
		throw new Error(`traceTag: tag "${tag}" is not a valid function name`)
		return (o: Rx.Observable<T>) => o
	}
	// oxlint-disable-next-line typescript-eslint/no-implied-eval
	const fn = new Function(
		'observable',
		'observableConstructor',
		`return new observableConstructor((s) => observable.subscribe({
				next: function __${tag}__next(t) {s.next(t)},
				error: function __${tag}__error(e) {s.error(e)},
				complete: function __${tag}__complete() {s.complete()}
		}))`,
	)

	return (o: Rx.Observable<T>) => fn(o, Rx.Observable)
}

export function cancellableTimeout(ms: number): Rx.Observable<void> {
	return new Rx.Observable((subscriber) => {
		const timeout = setTimeout(() => {
			subscriber.next()
		}, ms)
		return () => clearTimeout(timeout)
	})
}

export async function resolvePromises<T extends object>(obj: T): Promise<{ [K in keyof T]: Awaited<T[K]> }> {
	const entries = Object.entries(obj)
	const resolvedEntries = await Promise.all(entries.map(async ([key, value]) => [key, await value]))
	return Object.fromEntries(resolvedEntries) as {
		[K in keyof T]: Awaited<T[K]>
	}
}

export type AsyncTask<T extends any[]> = { params: T; task: (...params: T) => Promise<void> }
export class AsyncExclusiveTaskRunner {
	queue: AsyncTask<any>[] = []
	running = false
	async runExclusiveUntilEmpty() {
		if (this.running) return
		this.running = true
		try {
			while (this.queue.length > 0) {
				const task = this.queue.shift()!
				await task.task(...task.params)
			}
		} finally {
			this.running = false
			this.queue = []
		}
	}
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
			void acquire.then((release) => release(), () => {})
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

export function switchMapWithSignal<T, R>(
	project: (value: T, signal: AbortSignal) => Rx.ObservableInput<R>,
): Rx.OperatorFunction<T, R> {
	return (source: Rx.Observable<T>) =>
		new Rx.Observable<R>((subscriber) => {
			let innerSub: Rx.Subscription | null = null
			let controller: AbortController | null = null
			let outerComplete = false

			const outerSub = source.subscribe({
				next(value) {
					controller?.abort()
					innerSub?.unsubscribe()

					controller = new AbortController()
					innerSub = Rx.from(project(value, controller.signal)).subscribe({
						next(v) {
							subscriber.next(v)
						},
						error(e) {
							subscriber.error(e)
						},
						complete() {
							innerSub = null
							if (outerComplete) subscriber.complete()
						},
					})
				},
				error(e) {
					subscriber.error(e)
				},
				complete() {
					outerComplete = true
					if (!innerSub || innerSub.closed) subscriber.complete()
				},
			})

			return () => {
				controller?.abort()
				innerSub?.unsubscribe()
				outerSub.unsubscribe()
			}
		})
}

export function withAbortSignal(signal: AbortSignal) {
	const abort$: Rx.Observable<unknown> = Rx.merge(
		// emit immediatly if aborted already
		Rx.of(1).pipe(Rx.filter(() => signal.aborted)),
		// or wait for abort event
		Rx.fromEvent(signal, 'abort'),
	).pipe(Rx.first())
	return <T>(o: Rx.Observable<T>) => o.pipe(Rx.takeUntil(abort$))
}
