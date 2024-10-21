import { Observable, OperatorFunction, asapScheduler, observeOn } from 'rxjs'

export function sleep(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Check roughly every iteration of the event loop for some condition to be met
 */
export async function sleepUntil<T>(cb: () => T | undefined, maxRetries = 25) {
	let i = 0
	while (i < maxRetries) {
		const v = cb()
		if (v !== undefined) return v as T
		i++
		await sleep(0)
	}
	console.trace('sleepUntil timed out')
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
			if (err) nextData?.reject(err)
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
export function traceTag<T>(tag: string): OperatorFunction<T, T> {
	// surely this prevents all potential RCEs right???
	if (!/^[a-zA-Z_$][0-9a-zA-Z_$]*$/.test(tag)) {
		throw new Error(`traceTag: tag "${tag}" is not a valid function name`)
		return (o: Observable<T>) => o
	}
	const fn = new Function(
		'observable',
		'observableConstructor',
		`return new observableConstructor((s) => observable.subscribe({
				next: function __${tag}__next(t) {s.next(t)},
				error: function __${tag}__error(e) {s.error(e)},
				complete: function __${tag}__complete() {s.complete()}
		}))`
	)

	return (o: Observable<T>) => fn(o, Observable)
}

export async function resolvePromises<T extends object>(obj: T): Promise<{ [K in keyof T]: Awaited<T[K]> }> {
	const entries = Object.entries(obj)
	const resolvedEntries = await Promise.all(entries.map(async ([key, value]) => [key, await value]))
	return Object.fromEntries(resolvedEntries) as { [K in keyof T]: Awaited<T[K]> }
}
