import type * as CS from '@/models/context-shared'
import * as LOG from '@/models/logs'
import * as C from '@/server/context.ts'
import * as Otel from '@opentelemetry/api'
import * as Rx from 'rxjs'
import { sleep, traceTag } from './async'
import { withThrownAsync } from './error'
import { createId } from './id'
import { IsolatedSubject } from './isolated-subject'
import { getChildModule, type OtelModule } from './otel'

type AsyncResourceOpts<T> = {
	defaultTTL: number
	retries: number
	isErrorResponse: (value: T) => boolean
	retryDelay: number
	deferredTimeout: number
	log: CS.Logger

	// called when a fetch fails for real (non-abort, retries exhausted). without a handler the error escalates to an
	// unhandled rejection and crashes the process, so long-lived resources should provide one (e.g. to tear down their owner)
	onFatalError?: (err: unknown) => void
}

export type AsyncResourceInvocationOpts = {
	ttl: number
}

type AsyncValueState<T> = {
	value: Promise<T>
	resolveTime: number | null

	// the id of the span that .get was called from, or the caller of .observe if we're refetching
	invokerSpanId: string | null

	// aborts iff all subscribers are released while the fetch is in flight. this is the only signal cb ever sees
	abort: AbortController
}

type Subscriber =
	| { kind: 'observer'; ttl: number }
	| { kind: 'get' }

/**
 *  Provides cached access to an async resource. Callers can provide a ttl to specify how fresh their copy of the value should be. Promises are cached instead of raw values to dedupe fetches.
 */
export class AsyncResource<T, Ctx extends CS.Ctx & Partial<CS.AbortSignal> = CS.Ctx> {
	static includeInvocationCtx<Ctx extends CS.Ctx>(ctx: Ctx, opts: AsyncResourceInvocationOpts): Ctx & C.AsyncResourceInvocation {
		return {
			...ctx,
			resOpts: opts,
			refetch: (...args: ConstructorParameters<typeof ImmediateRefetchError>) => new ImmediateRefetchError(...args),
		}
	}

	opts: AsyncResourceOpts<T>
	state: AsyncValueState<T> | null = null
	private valueSubject = new IsolatedSubject<{ invokerSpanId: string | null; value: T }>()
	private setupRefetches: (ctx: Ctx) => void
	private log?: CS.Logger

	constructor(
		private name: string,
		private cb: (ctx: Ctx & C.AsyncResourceInvocation) => Promise<T>,
		parentModule: OtelModule,
		opts: Partial<AsyncResourceOpts<T>>,
	) {
		// @ts-expect-error init
		this.opts = { ...opts }
		this.opts.defaultTTL ??= 1000
		this.opts.isErrorResponse ??= (value: T) => false
		this.opts.retryDelay ??= 0
		this.opts.deferredTimeout ??= 2000
		this.log = opts.log ? LOG.getSubmoduleLogger(this.name, opts.log) : undefined
		const module = getChildModule(parentModule, this.name)

		this.setupRefetches = (_ctx: Ctx) => {
			const refetch$ = new Rx.Observable<void>(() => {
				let refetching = true
				const ctx = C.storeLinkToActiveSpan(_ctx, 'event.setup')
				void (async () => {
					while (refetching) {
						const shouldBreak = await C.spanOp('refetch', { module, root: true, levels: { event: 'trace' } }, async (ctx: Ctx) => {
							const activettl = Math.min(...this.observerTTLs)
							await sleep(activettl)
							if (!refetching) return true
							// observers are already counted as subscribers, so skip get()'s registration
							await this._get(ctx, { ttl: 0 })
						})(ctx).catch(() => {
							// abort means the last subscriber was released and teardown already unsubscribed us; any real
							// fetch error is escalated by fetchValue's rejection handler (onFatalError or unhandled rejection)
							return true
						})
						if (shouldBreak) break
					}
				})()

				return () => (refetching = false)
			})

			this.refetchSub?.unsubscribe()
			this.refetchSub = refetch$.subscribe()
		}
	}

	private async fetchValue(ctx: Ctx & C.AsyncResourceInvocation, opts?: { retries?: number }) {
		const abort = new AbortController()
		// the only signal cb ever sees -- caller signals only control subscriber membership
		const fetchCtx: Ctx & C.AsyncResourceInvocation = { ...ctx, signal: abort.signal }
		const state: AsyncValueState<T> = {
			value: (async (): Promise<T> => {
				let retriesLeft = opts?.retries ?? this.opts.retries
				while (true) {
					abort.signal.throwIfAborted()
					const [res, error] = await withThrownAsync(() => this.cb(fetchCtx))
					if (error !== null || this.opts.isErrorResponse(res!)) {
						if (retriesLeft === 0) {
							if (error) throw error
							return res as T
						}
						if (error instanceof ImmediateRefetchError) {
							this.log?.warn(error, 'immediate refetch requested: %s', error.message)
						} else {
							await sleep(this.opts.retryDelay, abort.signal)
						}
						retriesLeft--
						continue
					}
					return res as T
				}
			})(),

			invokerSpanId: Otel.trace.getActiveSpan()?.spanContext().spanId ?? null,
			resolveTime: null,
			abort,
		}
		this.state = state

		void state.value.then(
			(res) => {
				if (this.opts.isErrorResponse(res)) {
					if (this.state === state) this.state = null
					return
				}
				state.resolveTime = Date.now()
				this.valueSubject.next({ value: res, invokerSpanId: state.invokerSpanId })
			},
			(err) => {
				if (this.state === state) this.state = null
				// expected teardown: the last subscriber was released mid-fetch
				if (abort.signal.aborted) return
				if (this.opts.onFatalError) {
					this.opts.onFatalError(err)
					return
				}
				throw err
			},
		)
		return state.value
	}

	async get(ctx: Ctx, opts?: { ttl?: number; retries?: number }) {
		ctx.signal?.throwIfAborted()
		const release = this.addSubscriber({ kind: 'get' }, ctx.signal)
		try {
			return await this._get(ctx, opts)
		} finally {
			release()
		}
	}

	// note: any observers are guaranteed to be notified before get() resolves
	private async _get(ctx: Ctx, opts?: { ttl?: number; retries?: number }) {
		opts ??= {}
		opts.ttl ??= this.opts.defaultTTL

		if (!this.state || (this.state.resolveTime !== null && (Date.now() - this.state.resolveTime > opts.ttl))) {
			return await this.fetchValue(AsyncResource.includeInvocationCtx(ctx, { ttl: opts.ttl }), opts)
		} else {
			return await this.state!.value
		}
	}

	dispose() {
		this.valueSubject.complete()
	}

	get disposed() {
		return this.valueSubject.closed
	}

	invalidate(ctx: Ctx) {
		this.state = null
		if (this.observerTTLs.length > 0) {
			// rejections (abort or fatal) are handled by fetchValue's rejection handler
			this.fetchValue(AsyncResource.includeInvocationCtx(ctx, { ttl: 0 })).catch(() => {})
		}
	}

	private subscribers = new Map<string, Subscriber>()
	refetchSub: Rx.Subscription | null = null

	private get observerTTLs() {
		const ttls: number[] = []
		for (const sub of this.subscribers.values()) {
			if (sub.kind === 'observer') ttls.push(sub.ttl)
		}
		return ttls
	}

	// registers a subscriber and returns an idempotent release fn. releases early if the given signal aborts
	private addSubscriber(sub: Subscriber, signal?: AbortSignal): () => void {
		const id = createId(6)
		this.subscribers.set(id, sub)
		const release = () => {
			if (!this.subscribers.delete(id)) return
			signal?.removeEventListener('abort', release)
			this.onSubscribersChanged()
		}
		signal?.addEventListener('abort', release, { once: true })
		return release
	}

	private onSubscribersChanged() {
		const state = this.state
		if (this.subscribers.size === 0 && state && state.resolveTime === null) {
			state.abort.abort(new DOMException('no subscribers left', 'AbortError'))
			this.state = null
		}
		if (this.observerTTLs.length === 0) {
			this.refetchSub?.unsubscribe()
			this.refetchSub = null
		}
	}

	// listen to all updates to this resource, refreshing at a minumum when the ttl expires
	// note: any observers are guaranteed to be notified before getters (in order of subscription)
	// TODO should probably include context in emissions
	observe(ctx: Ctx, opts?: { ttl?: number }) {
		opts ??= {}
		opts.ttl ??= this.opts.defaultTTL
		if (this.disposed) return Rx.EMPTY
		const tag = `asyncResourceObserve__${this.name.replaceAll(/[/\-:]/g, '_')}`

		// stack of release fns, one per active subscription of this observable. entries are interchangeable, so pairing doesn't matter
		const releases: (() => void)[] = []
		return Rx.concat(
			this.state?.value ?? Rx.EMPTY,
			this.valueSubject.pipe(
				traceTag(tag),
				// TODO adjust calling code to ingest ctx
				Rx.map(({ value }) => value),
				Rx.tap({
					subscribe: () => {
						releases.push(this.addSubscriber({ kind: 'observer', ttl: opts.ttl! }))
						// rejections (abort or fatal) are handled by fetchValue's rejection handler
						this._get(ctx, { ttl: opts.ttl }).catch(() => {})
						if (this.refetchSub === null) {
							this.setupRefetches(ctx)
						}
					},
					finalize: () => {
						releases.pop()?.()
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
	static include<Ctx extends CS.Ctx>(ctx: Ctx) {
		return { ...ctx }
	}
	constructor(message: string, cause?: Error) {
		super(message, { cause })
		this.name = 'RefetchError'
	}
}
