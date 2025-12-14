import * as Obj from '@/lib/object'
import type * as CS from '@/models/context-shared'
import type * as C from '@/server/context.ts'
import * as Otel from '@opentelemetry/api'
import type { MutexInterface } from 'async-mutex'
import * as Rx from 'rxjs'
import { withThrownAsync } from './error'
import { createId } from './id'
import { assertNever } from './type-guards'

export function sleep(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

export function distinctDeepEquals<T>() {
	return (o: Rx.Observable<T>) => o.pipe(Rx.distinctUntilChanged((a, b) => Obj.deepEqual(a, b)))
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

type AsyncResourceOpts<T> = {
	defaultTTL: number
	tracer: Otel.Tracer
	retries: number
	isErrorResponse: (value: T) => boolean
	retryDelay: number
	deferredTimeout: number
}

export type AsyncResourceInvocationOpts = {
	ttl: number
}

/**
 *  Provides cached access to an async resource. Callers can provide a ttl to specify how fresh their copy of the value should be. Promises are cached instead of raw values to dedupe fetches.
 */
export class AsyncResource<T, Ctx extends CS.Log = CS.Log> {
	static tracer = Otel.trace.getTracer('async-resource')
	opts: AsyncResourceOpts<T>
	lastResolveTime: number | null = null
	fetchedValue: Promise<T> | null = null
	private valueSubject = new Rx.Subject<T>()

	constructor(
		private name: string,
		private cb: (ctx: Ctx & C.AsyncResourceInvocation) => Promise<T>,
		opts?: Partial<AsyncResourceOpts<T>>,
	) {
		// @ts-expect-error init
		this.opts = opts ?? {}
		this.opts.defaultTTL ??= 1000
		this.opts.tracer ??= AsyncResource.tracer
		this.opts.isErrorResponse ??= (value: T) => false
		this.opts.retryDelay ??= 0
		this.opts.deferredTimeout ??= 2000
	}

	async fetchValue(ctx: Ctx & C.AsyncResourceInvocation, opts?: { retries?: number }) {
		this.fetchedValue = (async (): Promise<T> => {
			let retriesLeft = opts?.retries ?? this.opts.retries
			while (true) {
				const [res, error] = await withThrownAsync(() => this.cb(ctx))
				if (error !== null || this.opts.isErrorResponse(res!)) {
					if (retriesLeft === 0) {
						if (error) throw error
						return res as T
					}
					if (error instanceof ImmediateRefetchError) {
						ctx.log.warn(error, 'immediate refetch requested: %s', error.message)
					} else {
						await sleep(this.opts.retryDelay)
					}
					retriesLeft--
					continue
				}
				return res as T
			}
		})()

		void this.fetchedValue
			.catch(err => {
				this.fetchedValue = null
				this.lastResolveTime = null
				throw err
			})
			.then((res) => {
				if (this.opts.isErrorResponse(res)) {
					this.fetchedValue = null
					this.lastResolveTime = null
					return
				}
				this.lastResolveTime = Date.now()
				this.valueSubject.next(res)
			})
		return this.fetchedValue
	}

	// note: any observers are guaranteed to be notified before get() resolves
	async get(_ctx: Ctx, opts?: { ttl?: number; retries?: number }) {
		opts ??= {}
		opts.ttl ??= this.opts.defaultTTL
		const ctx: Ctx & C.AsyncResourceInvocation = {
			..._ctx,
			resOpts: { ttl: opts.ttl },
			refetch: (...args) => new ImmediateRefetchError(...args),
		}

		if (this.lastResolveTime === null && this.fetchedValue) {
			return await this.fetchedValue
		}
		if (this.lastResolveTime === null && this.fetchedValue === null) {
			return await this.fetchValue(ctx, opts)
		}
		if (this.fetchedValue && this.lastResolveTime && Date.now() - this.lastResolveTime < opts.ttl) {
			return await this.fetchedValue!
		} else {
			return await this.fetchValue(ctx, opts)
		}
	}

	dispose() {
		this.valueSubject.complete()
	}

	get disposed() {
		return this.valueSubject.closed
	}

	invalidate(ctx: Ctx) {
		if (!this.lastResolveTime) return
		this.fetchedValue = null
		this.lastResolveTime = null
		if (this.observingTTLs.length > 0) {
			void this.fetchValue({
				...ctx,
				resOpts: { ttl: 0 },

				refetch: (...args) => new ImmediateRefetchError(...args),
			})
		}
	}

	observingTTLs: [string, number][] = []
	refetchSub: Rx.Subscription | null = null

	// listen to all updates to this resource, refreshing at a minumum when the ttl expires
	// note: any observers are guaranteed to be notified before getters (in order of subscription)
	// TODO should probably include context in emissions
	observe(ctx: Ctx, opts?: { ttl?: number }) {
		opts ??= {}
		opts.ttl ??= this.opts.defaultTTL
		if (this.disposed) return Rx.EMPTY

		const setupRefetches = () => {
			const refetch$ = new Rx.Observable<void>(() => {
				let refetching = true
				void (async () => {
					while (refetching) {
						const activettl = Math.min(...this.observingTTLs.map(([, ttl]) => ttl))
						await sleep(activettl)
						if (!refetching) break
						await this.get(ctx, { ttl: 0 })
					}
				})()
				return () => (refetching = false)
			})

			this.refetchSub?.unsubscribe()
			this.refetchSub = refetch$.subscribe()
		}

		const refId = createId(6)
		return Rx.concat(
			this.fetchedValue ?? Rx.EMPTY,
			this.valueSubject.pipe(
				traceTag(`asyncResourceObserve__${this.name}`),
				Rx.tap({
					subscribe: () => {
						this.observingTTLs.push([refId, opts.ttl!])
						void this.get(ctx, { ttl: opts.ttl })
						if (this.refetchSub === null) {
							setupRefetches()
						}
					},
					finalize: () => {
						const index = this.observingTTLs.findIndex(([id]) => refId === id)
						this.observingTTLs.splice(index, 1)
						if (this.observingTTLs.length === 0) {
							this.refetchSub?.unsubscribe()
							this.refetchSub = null
						}
					},
				}),
			),
		)
	}
}

// **
// * Throw within an async resource callback to immediately attempt a refetch. in most cases you shouldn't use this directly. instead throw ctx.refetch()
// **
export class ImmediateRefetchError extends Error {
	constructor(message: string, cause?: Error) {
		super(message, { cause })
		this.name = 'RefetchError'
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
