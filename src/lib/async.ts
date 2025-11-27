import * as Obj from '@/lib/object'
import type * as CS from '@/models/context-shared'
import type * as C from '@/server/context.ts'
import * as Otel from '@opentelemetry/api'
import { Mutex } from 'async-mutex'
import * as Rx from 'rxjs'
import { createId } from './id'

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
// orpc subscriptions only work with asyncScheduler set here
export async function* toAsyncGenerator<T>(observable: Rx.Observable<T>, scheduler = Rx.asyncScheduler) {
	let nextData = defer<T>() as Deferred<T | symbol> | null
	const sub = observable.pipe(
		Rx.observeOn(scheduler),
	).subscribe({
		next(data) {
			const n = nextData
			nextData = defer()
			n?.resolve(data)
		},
		error(err) {
			const n = nextData
			nextData = defer()
			n?.reject(err)
		},
		complete() {
			nextData?.resolve(DeferredEmpty)
		},
	})
	try {
		while (true) {
			const value = await nextData
			if (value === DeferredEmpty) break
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

// crude version of bufferTime which retains a reference to a shared buffer
export function externBufferTime<T>(time: number, buffer: T[]) {
	return (o: Rx.Observable<T>) =>
		o.pipe(
			Rx.map((v) => {
				buffer.push(v)
				return buffer
			}),
			Rx.sample(Rx.interval(time)),
		)
}

export function filterTruthy() {
	return <T>(o: Rx.Observable<T>) => o.pipe(Rx.filter((v) => !!v))
}

export function registerCleanup(cb: () => void, sub: Rx.Subscription) {
	sub.add(Rx.NEVER.pipe(Rx.finalize(cb)).subscribe())
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
	// eslint-disable-next-line no-implied-eval
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
 *  Provides cached access to an async resource. Callers can provide a ttl to specify how fresh their copy of the value should be. Promises are cached instead of raw values to dedupe fetches.
 */
export class AsyncResource<T, Ctx extends CS.Log = CS.Log> {
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
		try {
			const promise = this.cb(ctx)
			this.fetchedValue = null
			this.fetchedValue = promise
			const res = await promise
			this.lastResolveTime = Date.now()
			this.valueSubject.next(res)
			return res
		} catch (err) {
			this.fetchedValue = null
			this.lastResolveTime = null
			ctx.log.error(err)
			throw err
		}
	}

	// note: any observers are guaranteed to be notified before get() resolves
	async get(_ctx: Ctx, opts?: { ttl?: number }) {
		opts ??= {}
		opts.ttl ??= this.opts.defaultTTL
		const ctx = { ..._ctx, resOpts: { ttl: opts.ttl } }

		if (this.lastResolveTime === null && this.fetchedValue) {
			return await this.fetchedValue
		}
		if (this.lastResolveTime === null && this.fetchedValue === null) {
			return await this.fetchValue(ctx)
		}
		if (this.fetchedValue && this.lastResolveTime && Date.now() - this.lastResolveTime < opts.ttl) {
			return await this.fetchedValue!
		} else {
			return await this.fetchValue(ctx)
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
		if (this.observingTTLs.length > 0) void this.fetchValue({ ...ctx, resOpts: { ttl: 0 } })
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

export async function acquireInBlock(mutex: Mutex, opts?: { lock?: boolean }) {
	const lock = opts?.lock ?? true
	let release: (() => void) | undefined
	if (lock) {
		release = await mutex.acquire()
	}
	return {
		[Symbol.dispose]() {
			release?.()
		},
		mutex,
	}
}

// WARNING: if you use this function you cannot pass the context out of the lifetime of the calling function or weird things might happen
export async function acquireReentrant<Ctx extends C.Mutexes>(_ctx: Ctx, ...mutexes: Mutex[]) {
	const ctx: Ctx = { ..._ctx, mutexes: { locked: new Set(_ctx.mutexes.locked), releaseTasks: [] } }

	const mutexesToAcquire = mutexes.filter(mutex => !ctx.mutexes.locked.has(mutex))

	for (const mutex of mutexesToAcquire) {
		ctx.mutexes.locked.add(mutex)
	}

	// Acquire all locks in parallel
	const acquired = await Promise.all(
		mutexesToAcquire.map(mutex => mutex.acquire()),
	)

	// wait for referenced mutexes to be released and then process releaseTasks. There is no execution ordering guarantee
	const allReleased = Promise.all(mutexes.map(mutex => mutex.waitForUnlock()))
	void allReleased.then(async () => {
		for (const task of ctx.mutexes.releaseTasks) {
			void task()
		}
		return undefined
	}).catch(() => {
		// silently ignore errors
	})

	return {
		...ctx,
		[Symbol.dispose]() {
			for (const release of acquired) {
				release()
			}
		},
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
