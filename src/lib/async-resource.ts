import type * as CS from '@/models/context-shared'
import * as LOG from '@/models/logs'
import * as C from '@/server/context.ts'
import * as Otel from '@opentelemetry/api'
import * as Rx from 'rxjs'
import { traceTag } from './async'
import { withThrownAsync } from './error'
import { createId } from './id'
import { getChildModule, type OtelModule } from './otel'

type AsyncResourceOpts<T> = {
	defaultTTL: number
	retries: number
	isErrorResponse: (value: T) => boolean
	retryDelay: number
	deferredTimeout: number
	log: CS.Logger
}

export type AsyncResourceInvocationOpts = {
	ttl: number
}

type AsyncValueState<T> = {
	value: Promise<T>
	resolveTime: number | null

	// the id of the span that .get was called from, or the caller of .observe if we're refetching
	invokerSpanId: string | null
}

/**
 *  Provides cached access to an async resource. Callers can provide a ttl to specify how fresh their copy of the value should be. Promises are cached instead of raw values to dedupe fetches.
 */
export class AsyncResource<T, Ctx extends CS.Ctx = CS.Ctx> {
	static includeInvocationCtx<Ctx extends CS.Ctx>(ctx: Ctx, opts: AsyncResourceInvocationOpts): Ctx & C.AsyncResourceInvocation {
		return {
			...ctx,
			resOpts: opts,
			refetch: (...args: ConstructorParameters<typeof ImmediateRefetchError>) => new ImmediateRefetchError(...args),
		}
	}

	opts: AsyncResourceOpts<T>
	state: AsyncValueState<T> | null = null
	private valueSubject = new Rx.Subject<{ invokerSpanId: string | null; value: T }>()
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
						const shouldBreak = await C.spanOp('refetch', { module, root: true }, async (ctx: Ctx) => {
							const activettl = Math.min(...this.observingTTLs.map(([, ttl]) => ttl))
							await sleep(activettl)
							if (!refetching) return true
							await this.get(ctx, { ttl: 0 })
						})(ctx)
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
		this.state = {
			value: (async (): Promise<T> => {
				let retriesLeft = opts?.retries ?? this.opts.retries
				while (true) {
					const [res, error] = await withThrownAsync(() => this.cb(ctx))
					if (error !== null || this.opts.isErrorResponse(res!)) {
						if (retriesLeft === 0) {
							if (error) throw error
							return res as T
						}
						if (error instanceof ImmediateRefetchError) {
							this.log?.warn(error, 'immediate refetch requested: %s', error.message)
						} else {
							await sleep(this.opts.retryDelay)
						}
						retriesLeft--
						continue
					}
					return res as T
				}
			})(),

			invokerSpanId: Otel.trace.getActiveSpan()?.spanContext().spanId ?? null,
			resolveTime: null,
		}

		void this.state.value
			.catch(err => {
				this.state = null
				throw err
			})
			.then((res) => {
				if (this.opts.isErrorResponse(res)) {
					this.state = null
					return
				}
				if (this.state) {
					this.state.resolveTime = Date.now()
				}
				this.valueSubject.next({ value: res, invokerSpanId: this.state?.invokerSpanId ?? null })
			})
		return this.state.value
	}

	// note: any observers are guaranteed to be notified before get() resolves
	async get(ctx: Ctx, opts?: { ttl?: number; retries?: number }) {
		opts ??= {}
		opts.ttl ??= this.opts.defaultTTL

		if (!this.state || (this.state.resolveTime !== null && (Date.now() - this.state.resolveTime > opts.ttl))) {
			return await this.fetchValue(AsyncResource.includeInvocationCtx(ctx, { ttl: opts.ttl }), opts)
		} else {
			return await this.state.value
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
		if (this.observingTTLs.length > 0) {
			void this.fetchValue(AsyncResource.includeInvocationCtx(ctx, { ttl: 0 }))
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

		const refId = createId(6)
		return Rx.concat(
			this.state?.value ?? Rx.EMPTY,
			this.valueSubject.pipe(
				traceTag(`asyncResourceObserve__${this.name}`),
				// TODO adjust calling code to ingest ctx
				Rx.map(({ value }) => value),
				Rx.tap({
					subscribe: () => {
						this.observingTTLs.push([refId, opts.ttl!])
						void this.get(ctx, { ttl: opts.ttl })
						if (this.refetchSub === null) {
							this.setupRefetches(ctx)
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
	static include<Ctx extends CS.Ctx>(ctx: Ctx) {
		return { ...ctx }
	}
	constructor(message: string, cause?: Error) {
		super(message, { cause })
		this.name = 'RefetchError'
	}
}

function sleep(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms))
}
