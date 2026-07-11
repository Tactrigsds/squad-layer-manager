import type * as AR from '@/app-routes.ts'
import type { AsyncResource, AsyncResourceInvocationOpts, ImmediateRefetchError } from '@/lib/async-resource.ts'
import { isAbortError, sleep } from '@/lib/async.ts'
import type * as Cleanup from '@/lib/cleanup.ts'
import { LRUMap } from '@/lib/lru-map.ts'
import { withAcquired } from '@/lib/nodejs-reentrant-mutexes.ts'
import type { OtelModule } from '@/lib/otel'
import type RconCore from '@/lib/rcon/core-rcon.ts'
import * as CS from '@/models/context-shared.ts'
import * as LOG from '@/models/logs.ts'
import * as ATTR from '@/models/otel-attrs.ts'
import type * as SM from '@/models/squad.models.ts'
import type * as USR from '@/models/users.models.ts'
import type * as RBAC from '@/rbac.models'
import type * as LayerQueueSys from '@/systems/layer-queue.server'
import type * as MatchHistorySys from '@/systems/match-history.server'
import type * as SettingsSys from '@/systems/settings.server'
import type * as SquadRconSys from '@/systems/squad-rcon.server'
import type * as SquadServerSys from '@/systems/squad-server.server'
import type * as TeamswitchSys from '@/systems/teamswitches.server'
import type * as UserPresenceSys from '@/systems/user-presence.server'
import type * as VoteSys from '@/systems/vote.server'
import * as Otel from '@opentelemetry/api'
import type { Mutex, MutexInterface } from 'async-mutex'
import type * as Fastify from 'fastify'
import type Pino from 'pino'
import * as Rx from 'rxjs'
import type * as ws from 'ws'
import type * as DB from './db.ts'
import { baseLogger } from './logger.ts'

// Map context properties to their corresponding OpenTelemetry attributes
const CONTEXT_ATTR_MAPPING = [
	{
		ctxPath: (ctx: Partial<ServerId>) => ctx?.serverId,
		attr: ATTR.SquadServer.ID,
	},
	{ ctxPath: (ctx: Partial<User>) => ctx?.user?.username, attr: ATTR.User.ID },
	{
		ctxPath: (ctx: Partial<WSSession>) => ctx?.wsClientId,
		attr: ATTR.WebSocket.CLIENT_ID,
	},
] as const

export type OtelCtx = CS.Ctx & {
	otel: {
		links: Otel.Link[]
	}
}

// overrwrites other stored links
export function storeLinkToActiveSpan<T extends CS.Ctx>(
	ctx: T,
	type: ATTR.SpanLink.SourceType,
): T & OtelCtx {
	const link = buildSourceLinkToActiveSpan(type)
	return {
		...ctx,
		otel: {
			links: link ? [link] : [],
		},
	}
}

export function buildSourceLinkToActiveSpan(
	type: ATTR.SpanLink.SourceType,
): Otel.Link | undefined {
	const activeSpan = Otel.trace.getActiveSpan()
	if (!activeSpan) return
	return {
		context: activeSpan.spanContext(),
		attributes: { [ATTR.SpanLink.SOURCE]: type },
	}
}

function flushOtelLinksInPlace(ctx: OtelCtx) {
	const links = ctx.otel.links
	ctx.otel.links = []
	return links
}

// LRU map in case of leaks
const spanStatusMap = new LRUMap<
	string,
	{ code: Otel.SpanStatusCode; message?: string }
>(500)

export function spanOp<Cb extends (...args: any[]) => any>(
	name: string,
	opts: {
		module: OtelModule
		links?: Otel.Link[]
		levels?: {
			event?: Pino.Level | ((...args: Parameters<Cb>) => Pino.Level)
			error?: Pino.Level | ((...args: Parameters<Cb>) => Pino.Level)
			valueError?: Pino.Level | ((...args: Parameters<Cb>) => Pino.Level)
		}
		root?: boolean
		attrs?:
			| Record<string, any>
			| ((...args: Parameters<Cb>) => Record<string, any>)
		extraText?: (...args: Parameters<Cb>) => string
		mutexes?: (...args: Parameters<Cb>) => MutexInterface[] | MutexInterface
	},
	cb: Cb,
) {
	return async (..._args: Parameters<Cb>): Promise<Awaited<ReturnType<Cb>>> => {
		let args = _args as any[]

		// -------- dynamically extract context from args --------
		let ctx: undefined | (CS.Ctx & Partial<OtelCtx>)
		if (CS.isCtx(args[0])) {
			ctx = args[0]
		} else if (Array.isArray(args[0])) {
			// handle array-nested args(common with rxjs)
			const arrArgs = args[0]
			if (CS.isCtx(arrArgs[0])) {
				ctx = arrArgs[0]
			} else if (CS.isCtx(arrArgs[arrArgs.length - 1])) {
				ctx = arrArgs[arrArgs.length - 1]
			}
		}

		let links = opts.links ? [...opts.links] : []
		let spanContext = Otel.context.active()
		const fullName = `${opts.module.name}:${name}`

		const spanAttrs: Record<string, any> = {}

		if (ctx) {
			if (ctx.otel) {
				for (const link of flushOtelLinksInPlace(ctx as OtelCtx)) {
					const source = link.attributes?.[ATTR.SpanLink.SOURCE]
					// explicitly included links take precedence
					if (
						source
						&& links.some(
							(l) => link!.attributes?.[ATTR.SpanLink.SOURCE] == source,
						)
					) {
						continue
					}
					links.push(link)
				}
			}

			const baggageEntries: Record<string, Otel.BaggageEntry> = {}

			if (opts.root || !Otel.trace.getActiveSpan()) {
				baggageEntries[ATTR.Span.ROOT_NAME] = { value: fullName }
			}

			// Extract attributes from context using the mapping
			for (const { ctxPath, attr } of CONTEXT_ATTR_MAPPING) {
				const value = ctxPath(ctx)
				if (value !== undefined && value !== null) {
					spanAttrs[attr] = value
					// Also add to baggage if it's in MAPPED_ATTRS
					if (LOG.MAPPED_ATTRS.includes(attr)) {
						baggageEntries[attr] = { value: value }
					}
				}
			}

			// Add any custom attrs
			let customAttrs = opts.attrs
			if (typeof customAttrs === 'function') {
				customAttrs = customAttrs(...(args as Parameters<Cb>))
			}
			if (customAttrs) {
				for (const [key, value] of Object.entries(customAttrs)) {
					spanAttrs[key] = value
					// Add to baggage if it's in MAPPED_ATTRS
					if (LOG.MAPPED_ATTRS.includes(key)) {
						baggageEntries[key] = { value: String(value) }
					}
				}
			}

			if (Object.keys(baggageEntries).length > 0) {
				const currentBaggage = Otel.propagation.getBaggage(spanContext)
				const newBaggageObj: Record<string, Otel.BaggageEntry> = {
					...baggageEntries,
				}

				// Merge with existing baggage
				if (currentBaggage) {
					for (const [k, v] of currentBaggage.getAllEntries()) {
						if (!(k in newBaggageObj)) {
							newBaggageObj[k] = v
						}
					}
				}

				const newBaggage = Otel.propagation.createBaggage(newBaggageObj)
				spanContext = Otel.propagation.setBaggage(spanContext, newBaggage)
			}
		}

		const tracer = opts.module.tracer
		return await tracer.startActiveSpan(
			fullName,
			{ root: opts.root, links },
			spanContext,
			async (span) => {
				let ctx: any
				const links: Otel.Link[] = [
					{
						context: span.spanContext(),
						attributes: { ['slm.link-source']: 'upstream' },
					},
				]
				if (args[0]?.otelCtx) {
					ctx = args[0]
					args = [{ ...ctx, upstreamLinks: links }, ...args.slice(1)]
				} else if (args[0]?.[0]?.otelCtx) {
					ctx = args[0][0]
					args = [
						[{ ...ctx, upstreamLinks: links }, ...args[0].slice(1)],
						...args.slice(1),
					]
				}

				// Set all collected attributes on the span
				if (Object.keys(spanAttrs).length > 0) {
					setSpanOpAttrs(spanAttrs)
				}

				let log = opts.module?.getLogger() ?? baseLogger

				const resolveLevel = (
					level: Pino.Level | ((...a: Parameters<Cb>) => Pino.Level) | undefined,
					fallback: Pino.Level,
				): Pino.Level => typeof level === 'function' ? level(...(args as Parameters<Cb>)) : (level ?? fallback)

				const extraText = opts.extraText
					? `${opts.extraText(...(args as Parameters<Cb>))} `
					: ''
				try {
					const result = await withAcquired(
						opts.mutexes ?? (() => []),
						cb as Cb,
					)(...(args as Parameters<Cb>))
					let statusString: string
					if (
						result !== null
						&& typeof result === 'object'
						&& 'code' in result
						&& typeof result.code === 'string'
					) {
						statusString = result.code
						if (result.code === 'ok') {
							setSpanStatus(Otel.SpanStatusCode.OK)
						} else if (result.code.includes('err')) {
							const message = result.msg
								? `${result.code}: ${result.msg}`
								: result.code
							const extraTextPart = extraText ? ` : ${extraText.trim()}` : ''
							const logArgs = [
								`OP : ${fullName}${extraTextPart} : value-error : ${message}`,
							]
							if (result.error || result.err) {
								logArgs.unshift(result.error || result.err)
							}
							// @ts-expect-error idgaf
							log?.[resolveLevel(opts.levels?.valueError, 'warn')](...logArgs)
							setSpanStatus(Otel.SpanStatusCode.ERROR, message)
						}
					}
					let spanStatus = spanStatusMap.get(span.spanContext().spanId)
					if (!spanStatus) {
						spanStatus = { code: Otel.SpanStatusCode.OK }
						span.setStatus({ code: Otel.SpanStatusCode.OK })
					}
					const logLevel = spanStatus.code === Otel.SpanStatusCode.ERROR
						? resolveLevel(opts.levels?.error, 'warn')
						: resolveLevel(opts.levels?.event, 'debug')
					statusString ??= spanStatus.code === Otel.SpanStatusCode.ERROR
						? (spanStatus?.message ?? 'error')
						: 'ok'
					const extraTextPart = extraText ? ` : ${extraText.trim()}` : ''
					log?.[logLevel](`op : ${fullName}${extraTextPart} : ${statusString}`)
					return result as Awaited<ReturnType<Cb>>
				} catch (error) {
					const message = recordGenericError(error)
					const extraTextPart = extraText ? ` : ${extraText.trim()}` : ''
					if (isAbortError(error)) {
						// expected cancellation (request dropped, slice destroyed, shutdown) -- not a failure
						log?.debug(`${name}${extraTextPart} : aborted: ${message}`)
					} else if (error instanceof Error) {
						log?.error(error, `${name}${extraTextPart} : error: ${message}`)
					} else {
						log?.error(`${name}${extraTextPart} : error: ${message}`)
					}
					throw error
				} finally {
					spanStatusMap.delete(span.spanContext().spanId)
					span.end()
				}
			},
		)
	}
}

export function setSpanOpAttrs(attrs: Record<string, any>) {
	Otel.default.trace.getActiveSpan()?.setAttributes(attrs)
}
export function setSpanStatus(_status: Otel.SpanStatusCode | 'ok' | 'error', message?: string) {
	const status = _status === 'ok' ? Otel.SpanStatusCode.OK : _status === 'error' ? Otel.SpanStatusCode.ERROR : _status
	const activeSpan = Otel.default.trace.getActiveSpan()
	if (!activeSpan) return

	spanStatusMap.set(activeSpan.spanContext().spanId, { code: status, message })
	activeSpan.setStatus({ code: status, message })
}

export function getSpan() {
	return Otel.trace.getActiveSpan()
}

export function recordGenericError(error: unknown, setStatus = true) {
	const span = Otel.trace.getActiveSpan()
	if (!span) return
	if (error instanceof Error || typeof error === 'string') {
		span.recordException(error)
		if (setStatus) {
			const message = error instanceof Error ? error.message : error
			setSpanStatus(Otel.SpanStatusCode.ERROR, message)
			return message
		}
	}
}

// -------- Logging end --------

export type Db = CS.Ctx & {
	db(opts?: { redactParams?: boolean }): DB.Db
} & Partial<Tx>

// indicates the context is in a db transaction
export type Tx = CS.Ctx & {
	tx: {
		rollback: () => void

		// tasks which will be executed after the transaction is committed
		unlockTasks: (() => void | Promise<void>)[]
	}
}

type ReleaseTask = () => void | Promise<void>
// TODO we may want some way of specifying in function signature what kinds of locks the context might acquire
export type Mutexes = CS.Ctx & {
	mutexes: {
		// represents the set of mutexes currently locked by the context
		locked: Set<Mutex>

		// tasks to be executed after mutex is released
		releaseTasks: ReleaseTask[]
	}
}
export function initMutexStore<Ctx extends object>(ctx?: Ctx): Ctx {
	return {
		...(ctx ?? ({} as Ctx)),
		mutexes: { locked: new Set<Mutex>(), releaseTasks: [] },
	}
}

export type ResolvedRoute = CS.Ctx & { route: AR.ResolvedRoute }

// could also be ws upgrade
export type FastifyRequest = CS.Ctx & {
	req: Fastify.FastifyRequest
	cookies: AR.Cookies
} & Partial<ResolvedRoute>
export type FastifyRequestFull = FastifyRequest & AttachedFastify

export type FastifyReply = CS.Ctx & { res: Fastify.FastifyReply }
export type HttpRequest = FastifyRequest & FastifyReply
export type HttpRequestFull = HttpRequest & AttachedFastify

// sparse subset of User
export type UserId = CS.Ctx & {
	user: { discordId: bigint }
}

export type User = CS.Ctx & {
	user: USR.User
}

export type Player = CS.Ctx & {
	player: SM.Player
}

export type UserOrPlayer = Partial<User> & Partial<Player>

export type RbacUser = CS.Ctx & { user: RBAC.UserWithRbac }

export type AuthSession = CS.Ctx & {
	sessionId: string
	expiresAt: Date
}

export type WSSession = CS.Ctx & {
	wsClientId: string
}

export type AuthedUser = User & AuthSession

export type AttachedFastify = Db & Partial<ResolvedRoute> & CS.AbortSignal
export type Websocket = CS.Ctx & { ws: ws.WebSocket }
export type OrpcSessionBase =
	& CS.Ctx
	& User
	& AuthSession
	& WSSession
	& Websocket
	& FastifyRequest
	& Db

export type OrpcBase =
	& OrpcSessionBase
	& CS.AbortSignal

export type AsyncResourceInvocation = CS.Ctx & {
	resOpts: AsyncResourceInvocationOpts
	refetch: (
		...args: ConstructorParameters<typeof ImmediateRefetchError>
	) => ImmediateRefetchError
}

export type Rcon = CS.Ctx & {
	rcon: RconCore
}

export type ServerId = CS.Ctx & {
	serverId: string
}

export type AdminList = CS.Ctx & {
	adminList: AsyncResource<SM.AdminList, CS.Ctx & CS.AbortSignal>
} & ServerId

export type SquadRcon = CS.Ctx & { server: SquadRconSys.SquadRcon } & Rcon & ServerId

export type Vote = CS.Ctx & {
	vote: VoteSys.VoteContext
} & ServerId

export type LayerQueue = CS.Ctx & {
	layerQueue: LayerQueueSys.LayerQueueSlice
} & ServerId

export type MatchHistory = CS.Ctx & {
	matchHistory: MatchHistorySys.MatchHistoryContext
} & ServerId

export type SquadServer =
	& CS.Ctx
	& { server: SquadServerSys.SquadServer }
	& ServerId

export type Teamswitch = CS.Ctx & {
	teamswitches: TeamswitchSys.TeamswitchContext
} & ServerId

export type UserPresence =
	& CS.Ctx
	& UserPresenceSys.UserPresenceContext

export type ServerSettings = CS.Ctx & {
	serverSettings: SettingsSys.ServerSettingsSlice
} & ServerId

export type ServerSliceCleanup = CS.Ctx & {
	cleanup: Cleanup.Tasks
}
export type ServerSlice =
	& CS.Ctx
	& SquadRcon
	& SquadServer
	& Vote
	& LayerQueue
	& MatchHistory
	& Teamswitch
	& ServerSettings
	& ServerSliceCleanup
	& AdminList
	// aborts when the slice is destroyed or the process shuts down
	& CS.AbortSignal

/**
 * Creates an operator that wraps an observable with retry logic and additional trace context.
 *
 * The returned operator fully owns error handling: neither a torn-down/aborted task nor a failing
 * source will ever propagate to the subscriber, so callers subscribe with a bare `.subscribe()` and
 * the subscription keeps listening for events for its whole lifetime. Errors are logged, recorded in
 * traces, and retried (per-task via `numTaskRetries`, then the source indefinitely, paced by
 * `retryTimeoutMs`). The task signal aborts on teardown (unsubscribe, switch) or when a ctx signal
 * carried in the emitted value aborts; abort errors stop that one task quietly.
 *
 * @param name - Identifier for the subscription used in logs and traces
 * @param opts - Configuration options (module, levels, taskScheduling, retryTimeoutMs, etc.)
 * @param cb - Async callback function to process each emitted value
 * @returns An RxJS operator that transforms the source observable
 */
export function durableSub<T, O>(
	name: string,
	opts: {
		module: OtelModule
		levels?: {
			event?: Pino.Level | ((arg: T) => Pino.Level)
			error?: Pino.Level | ((arg: T) => Pino.Level)
			valueError?: Pino.Level | ((arg: T) => Pino.Level)
		}
		numTaskRetries?: number
		retryTaskOnValueError?: boolean
		retryTimeoutMs?: number
		taskScheduling?: 'switch' | 'parallel' | 'sequential' | 'exhaust'
		root?: boolean
		attrs?: Record<string, any> | ((arg: T) => Record<string, any>)
		mutexes?: (args: T) => MutexInterface[] | MutexInterface
	},
	// the signal aborts when the task is torn down (unsubscribe, switch) or when the signal of a ctx carried in `value` aborts
	cb: (value: T, signal: AbortSignal) => Promise<O>,
): (o: Rx.Observable<T>) => Rx.Observable<O> {
	return (o) => {
		const numRetries = Math.max(opts.numTaskRetries ?? 0, 0)
		const retryOnValueError = opts.retryTaskOnValueError ?? false
		const taskScheduling = opts.taskScheduling ?? ('sequential' as const)

		let subSpan: Otel.Span | undefined
		let subscriberCount = 0
		// mutated in place when subSpan is (re)created; spanOp reads it on every task invocation
		const initializerLinks: Otel.Link[] = []
		const taskOp = spanOp(
			name,
			{
				module: opts.module,
				links: initializerLinks,
				root: opts.root ?? true,
				attrs: opts.attrs,
				levels: opts.levels,
			},
			cb,
		)
		const log = LOG.getSubmoduleLogger(name, opts.module.getLogger())

		const getTask = (arg: T): Rx.Observable<O> =>
			// raw observable so the retry loop stops once the subscriber goes away. teardown aborts the task
			// signal, cancelling the in-flight taskOp invocation if the cb consumes the signal
			new Rx.Observable<O>((subscriber) => {
				const taskAbort = new AbortController()
				const signal = taskAbort.signal
				void (async () => {
					let attemptsLeft = numRetries + 1
					while (!signal.aborted) {
						try {
							const res = await taskOp(arg, signal)
							if (retryOnValueError && (res as any).code !== 'ok') {
								attemptsLeft--
								if (attemptsLeft === 0 || signal.aborted) {
									subscriber.next(res)
									subscriber.complete()
									return
								}
								log.warn(`retrying ${name}`)
								continue
							}
							subscriber.next(res)
							subscriber.complete()
							return
						} catch (error) {
							// cancellation is expected, not a failure: stop quietly instead of feeding the retry pipeline.
							// isAbortError also covers ctx signals the cb resolved itself (e.g. via resolveSliceCtx)
							if (signal.aborted || isAbortError(error)) {
								subscriber.complete()
								return
							}
							attemptsLeft--
							if (attemptsLeft === 0) {
								subscriber.error(error)
								return
							}
							log.warn(`retrying ${name} in ${opts.retryTimeoutMs ?? 0}ms`)
							try {
								await sleep(opts.retryTimeoutMs ?? 0, signal)
							} catch {
								subscriber.complete()
								return
							}
						}
					}
					subscriber.complete()
				})()
				return () => {
					taskAbort.abort(new DOMException(`durable-sub task torn down: ${name}`, 'AbortError'))
				}
			})

		return o.pipe(
			Rx.tap({
				error: (error) => {
					const activeSpan = Otel.trace.getActiveSpan()
					activeSpan?.setStatus({ code: Otel.SpanStatusCode.ERROR })

					const span = activeSpan ?? subSpan
					span?.recordException(error)
					log.error(error)
				},
			}),
			{
				parallel: Rx.mergeMap(getTask),
				sequential: Rx.concatMap(getTask),
				switch: Rx.switchMap(getTask),
				exhaust: Rx.exhaustMap(getTask),
			}[taskScheduling],
			// durableSub owns all error handling: a torn-down/aborted task or a failing source must never
			// escape to the (deliberately handler-less) subscriber, where RxJS would report it as an
			// uncaught error and crash the process. Retry the source indefinitely (paced by delay) so the
			// subscription keeps listening for events instead of tearing down.
			Rx.retry({
				resetOnSuccess: true,
				count: Infinity,
				delay: opts.retryTimeoutMs ?? 250,
			}),
			Rx.tap({
				subscribe: () => {
					if (subscriberCount === 0) {
						subSpan = opts.module.tracer.startSpan('durable-sub::' + name)
						initializerLinks.length = 0
						initializerLinks.push({
							context: subSpan.spanContext(),
							attributes: { 'slm.link-source': 'sub-initializer' },
						})
					}
					subscriberCount++
					subSpan?.addEvent('subscribed')
				},
				// fires on complete, error, and unsubscribe
				finalize: () => {
					subscriberCount--
					if (subscriberCount === 0) {
						subSpan?.end()
						subSpan = undefined
					}
				},
			}),
		)
	}
}
