import * as Obj from '@/lib/object'
import type * as CS from '@/models/context-shared'
import type { MutexInterface } from 'async-mutex'
import * as Rx from 'rxjs'
import { assertNever } from './type-guards'

export function sleep(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms))
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

export function isSubscription(value: any): value is Rx.Subscription {
	return typeof value === 'object' && 'subscribe' in value && 'unsubscribe' in value
}
export function isMutex(value: any): value is MutexInterface {
	const methods = ['acquire', 'runExclusive', 'waitForUnlock', 'isLocked', 'release', 'cancel']
	return typeof value === 'object' && methods.every((method) => method in value)
}

type CleanupTaskValue =
	| Rx.Subscription
	| Rx.ObservableInput<unknown>
	| Rx.Subject<unknown>
	| MutexInterface
	| null
	| undefined

export type CleanupTask = (() => CleanupTaskValue | void) | CleanupTaskValue

export type CleanupTasks = CleanupTask[]

// runs cleanuptasks in a FILO fashion
export function runCleanup(ctx: CS.Log, tasks: CleanupTasks) {
	return Rx.lastValueFrom(Rx.concat(tasks.toReversed().map(to$)).pipe(Rx.endWith(0)))

	function to$(_task: CleanupTask, index: number) {
		try {
			let task = typeof _task === 'function' ? _task() : _task
			if (task == null || task == undefined) {
				return Rx.EMPTY
			}
			if (task instanceof Rx.Subject) {
				task.complete()
				return Rx.EMPTY
			}
			if (isMutex(task)) {
				task.cancel()
				return Rx.EMPTY
			}
			if (isSubscription(task)) {
				task.unsubscribe()
				return Rx.EMPTY
			}

			return task
		} catch (err) {
			const unreversedIndex = tasks.length - index - 1
			ctx.log.error(err, 'caught error during cleanup for task at index %d', unreversedIndex)
			return Rx.EMPTY
		}
	}
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

export async function acquireInBlock(mutex: MutexInterface, opts?: { lock?: boolean; priority?: number }) {
	const lock = opts?.lock ?? true
	let release: (() => void) | undefined
	if (lock) {
		release = await mutex.acquire(opts?.priority)
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
