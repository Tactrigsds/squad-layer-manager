import * as C from '@/server/context.ts'
import * as Otel from '@opentelemetry/api'
import { Mutex } from 'async-mutex'
import deepEqual from 'fast-deep-equal'
import * as Rx from 'rxjs'
import { getNextIntId } from './id'

export function sleep(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

export function distinctDeepEquals<T>() {
	return (o: Rx.Observable<T>) => o.pipe(Rx.distinctUntilChanged((a, b) => deepEqual(a, b)))
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

type Deferred<T> = Promise<T> & {
	resolve: (value: T | PromiseLike<T>) => void
	reject: (reason?: any) => void
}

function defer<T>(): Deferred<T> {
	const properties = {},
		promise = new Promise<T>((resolve, reject) => {
			Object.assign(properties, { resolve, reject })
		})
	return Object.assign(promise, properties) as Deferred<T>
}

const DeferredEmpty = Symbol('DeferredEmpty')
export async function* toAsyncGenerator<T>(observable: Rx.Observable<T>) {
	let nextData = defer<T>() as Deferred<T | symbol> | null
	const sub = observable.pipe(Rx.observeOn(Rx.asapScheduler)).subscribe({
		next(data) {
			const n = nextData
			nextData = defer()
			n?.resolve(data)
		},
		error(err) {
			if (err) nextData?.reject(err)
		},
		complete() {
			nextData?.resolve(DeferredEmpty)
			nextData = null
		},
	})
	try {
		while (true) {
			const value = await nextData
			if (!nextData) break
			if (value === DeferredEmpty) continue
			yield value as T
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

export function withActiveSpan<T>(name: string, opts: { root: boolean; tracer: Otel.Tracer }) {
	return (o: Rx.Observable<T>) => {
		return new Rx.Observable<T>(s => {
			const sub = o.subscribe(value => opts.tracer.startActiveSpan(name, { root: opts.root }, () => s.next(value)))
			return () => sub.unsubscribe()
		})
	}
}

type AsyncResourceOpts = {
	maxLockTime: number
	defaultTTL: number
	tracer: Otel.Tracer
}

export type AsyncResourceInvocationOpts = {
	ttl: number
}

// TODO add retries
/**
 *  Provides cached and lockable access to an async resource. Callers can provide a ttl to specify how fresh their copy of the value should be.
 */
export class AsyncResource<T, Ctx extends C.Log = C.Log> {
	static tracer = Otel.trace.getTracer('async-resource')
	mutex = new Mutex()
	opts: AsyncResourceOpts
	lastResolveTime: number | null = null
	fetchedValue: Promise<T> | null = null
	private valueSubject = new Rx.Subject<T>()
	constructor(
		private name: string,
		private cb: (ctx: Ctx & C.AsyncResourceInvocation) => Promise<T>,
		opts?: Partial<AsyncResourceOpts>,
	) {
		// @ts-expect-error init
		this.opts = opts ?? {}
		this.opts.maxLockTime ??= 2000
		this.opts.defaultTTL ??= 1000
		this.opts.tracer ??= AsyncResource.tracer
	}
	async fetchValue(ctx: Ctx & C.AsyncResourceInvocation) {
		const promise = this.cb(ctx)
		this.fetchedValue = null
		this.fetchedValue = promise
		const res = await promise
		this.lastResolveTime = Date.now()
		this.valueSubject.next(res)
		return res
	}
	async get(
		_ctx: Ctx,
		opts?: {
			// locks other calls to get this resource that also invoke the lock
			lock?: boolean
			ttl?: number
		},
	) {
		opts ??= {}
		opts.lock ??= false
		opts.ttl ??= this.opts.defaultTTL
		const ctx = { ..._ctx, resOpts: { ttl: opts.ttl } }
		let startUnlockCount: (() => void) | undefined

		try {
			startUnlockCount?.()
			if (this.lastResolveTime === null && this.fetchedValue) {
				return { value: await this.fetchedValue }
			}
			if (this.lastResolveTime === null && this.fetchedValue === null) {
				return { value: await this.fetchValue(ctx) }
			}
			if (this.lastResolveTime && Date.now() - this.lastResolveTime < opts.ttl) {
				return { value: await this.fetchedValue! }
			} else {
				return { value: await this.fetchValue(ctx) }
			}
		} catch (err) {
			this.fetchedValue = null
			throw err
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
		if (this.observingTTLs.length > 0) this.fetchValue({ ...ctx, resOpts: { ttl: 0 } })
	}

	observingTTLs: [number, number][] = []
	refetchSub: Rx.Subscription | null = null

	// listen to all updates to this resource, refreshing at a minumum when the ttl expires
	observe(ctx: Ctx, opts?: { ttl?: number }) {
		opts ??= {}
		opts.ttl ??= this.opts.defaultTTL
		if (this.disposed) return Rx.EMPTY

		const setupRefetches = () => {
			const refetch$ = new Rx.Observable<void>(() => {
				let refetching = true
				;(async () => {
					while (refetching) {
						const activettl = Math.min(...this.observingTTLs.map(([, ttl]) => ttl))
						await sleep(activettl)
						await this.get(ctx, { ttl: 0 })
					}
				})()
				return () => (refetching = false)
			})

			this.refetchSub?.unsubscribe()
			this.refetchSub = refetch$.subscribe()
		}

		const refId = getNextIntId(this.observingTTLs.map(([id]) => id))
		this.observingTTLs.push([refId, opts.ttl!])
		return Rx.concat(
			this.fetchedValue ?? Rx.EMPTY,
			this.valueSubject.pipe(
				withActiveSpan(`asyncResourceObserve::${this.name}`, { root: true, tracer: this.opts.tracer }),
				traceTag(`asyncResourceObserve__${this.name}`),
				Rx.observeOn(Rx.asapScheduler),
				Rx.tap({
					subscribe: () => {
						this.get(ctx, { ttl: opts.ttl })
						if (this.observingTTLs.length > 0 && this.refetchSub === null) {
							setupRefetches()
						}
					},
					finalize: () => {
						this.observingTTLs = this.observingTTLs.filter(([id]) => refId !== id)
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

export async function acquireInBlock(mutex: Mutex, opts?: { bypass?: boolean }) {
	let release: (() => void) | undefined
	if (!opts?.bypass) {
		release = await mutex.acquire()
	}
	return {
		[Symbol.dispose]() {
			release?.()
		},
		mutex,
	}
}
