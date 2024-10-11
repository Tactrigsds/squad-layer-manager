import { Logger } from 'pino'
import {
	Observable,
	OperatorFunction,
	asapScheduler,
	endWith,
	filter,
	firstValueFrom,
	interval,
	map,
	mapTo,
	observeOn,
	takeWhile,
} from 'rxjs'

/**
 * Check roughly every loop of the event loop for some condition to be met
 */
export function sleepUntil<T>(cb: () => T | undefined, maxRetries = 100) {
	return firstValueFrom(
		interval(0).pipe(
			takeWhile((i) => i < maxRetries),
			map(() => cb()),
			filter((v) => !!v),
			endWith(undefined)
		)
	)
}

type Deferred<T> = Promise<T> & { resolve: (value: T | PromiseLike<T>) => void; reject: (reason?: any) => void }

function defer<T>(): Deferred<T> {
	const properties = {},
		promise = new Promise<T>((resolve, reject) => {
			Object.assign(properties, { resolve, reject })
		})
	return Object.assign(promise, properties) as Deferred<T>
}

export async function* toAsyncGenerator<T>(observable: Observable<T>) {
	let nextData = defer<T>() as Deferred<T | null> | null
	const sub = observable.pipe(observeOn(asapScheduler)).subscribe({
		next(data) {
			const n = nextData
			nextData = defer()
			n?.resolve(data)
		},
		error(err) {
			nextData?.reject(err)
		},
		complete() {
			nextData?.resolve(null)
			nextData = null
		},
	})
	try {
		while (true) {
			const value = await nextData
			if (!nextData) break
			if (value) yield value
		}
	} finally {
		sub.unsubscribe()
	}
}

/**
 * Inserts a function with a custom name into the stack trace of an rxjs pipe to make it somewhat more useful. Confusingly doesn't actually log values passing through.
 * The existence of this function is why you should never use rxjs unless you're addicted like me, and should probably use the effect library instead {@link https://effect.website}
 */
export function traceTag<T>(tag: string, ctx: { log: Logger }): OperatorFunction<T, T> {
	// surely this prevents all potential RCEs right???
	if (!/^[a-zA-Z_$][0-9a-zA-Z_$]*$/.test(tag)) {
		const error = new Error(`traceTag: tag "${tag}" is not a valid function name`)
		ctx.log.error(error)
		return (o: Observable<T>) => o
	}

	return (o: Observable<T>) =>
		new Function(
			'observable',
			'observableConstructor',
			`return new observableConstructor((s) => observable.subscribe({
				next: function __${tag}__next(t) {s.next(t)},
				error: function __${tag}__error(e) {s.error(e)},
				complete: function __${tag}__complete() {s.complete()}
			}))`
		)(o, Observable)
}
