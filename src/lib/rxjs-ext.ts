// Our own rxjs operators and bridges, reached as `Rx.Ext.*` through ./rxjs. Kept in its own module
// rather than as a namespace inside the barrel: `export namespace` compiles to an IIFE with no pure
// annotation, which would pin the whole rxjs re-export in the client bundle.
//
// Imports rxjs directly, since ./rxjs re-exports this and the other way round would be a cycle.
import * as Rx from 'rxjs'

import * as Obj from './object'
import { assertNever } from './type-guards'

/**
 * Like Rx.firstValueFrom, but if `signal` aborts first, unsubscribes from the source and rejects
 * with `signal.reason`. Prefer this over `Prom.raceAbort(Rx.firstValueFrom(...))`, which would leave
 * the subscription alive until the source emits.
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

export function withAbortSignal(signal: AbortSignal) {
	const abort$: Rx.Observable<unknown> = Rx.merge(
		// emit immediatly if aborted already
		Rx.of(1).pipe(Rx.filter(() => signal.aborted)),
		// or wait for abort event
		Rx.fromEvent(signal, 'abort'),
	).pipe(Rx.first())
	return <T>(o: Rx.Observable<T>) => o.pipe(Rx.takeUntil(abort$))
}
