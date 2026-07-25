import type { MutexInterface } from 'async-mutex'
import * as Rx from 'rxjs'

import * as Obj from '@/lib/object'

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
		o.pipe(
			Rx.concatMap((b) => {
				if (Obj.deepEqual(b, prev)) return Rx.EMPTY
				prev = b
				return Rx.of(b)
			}),
		)
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

export function withAbortSignal(signal: AbortSignal) {
	const abort$: Rx.Observable<unknown> = Rx.merge(
		// emit immediatly if aborted already
		Rx.of(1).pipe(Rx.filter(() => signal.aborted)),
		// or wait for abort event
		Rx.fromEvent(signal, 'abort'),
	).pipe(Rx.first())
	return <T>(o: Rx.Observable<T>) => o.pipe(Rx.takeUntil(abort$))
}
