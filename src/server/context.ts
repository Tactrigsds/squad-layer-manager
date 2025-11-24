import type * as AR from '@/app-routes.ts'
import type { AsyncResourceInvocationOpts } from '@/lib/async.ts'
import { sleep, toCold } from '@/lib/async.ts'
import { LRUMap } from '@/lib/fixed-size-map.ts'
import { createId } from '@/lib/id.ts'
import type RconCore from '@/lib/rcon/core-rcon.ts'
import type * as CS from '@/models/context-shared.ts'
import type * as SM from '@/models/squad.models.ts'
import type * as USR from '@/models/users.models.ts'
import type * as RBAC from '@/rbac.models'
import type * as LayerQueueSys from '@/server/systems/layer-queue.ts'
import type * as MatchHistorySys from '@/server/systems/match-history.ts'
import type * as SharedLayerListSys from '@/server/systems/shared-layer-list.server.ts'
import type * as SquadRconSys from '@/server/systems/squad-rcon.ts'
import type * as SquadServerSys from '@/server/systems/squad-server.ts'
import * as Otel from '@opentelemetry/api'
import type { Mutex } from 'async-mutex'
import type * as Fastify from 'fastify'
import type Pino from 'pino'
import * as Rx from 'rxjs'
import type * as ws from 'ws'
import type * as DB from './db.ts'

import { baseLogger } from './logger.ts'

export type OtelCtx = {
	upstreamLinks: Otel.Link[]
}

export function includeActiveSpanAsUpstreamLink<T extends object>(ctx: T): T & OtelCtx {
	const activeSpan = Otel.trace.getActiveSpan()
	return {
		...ctx,
		upstreamLinks: activeSpan ? [{ context: activeSpan.spanContext(), attributes: { ['slm.link-source']: 'upstream' } }] : [],
	}
}

export function includeLogProperties<T extends CS.Log>(ctx: T, fields: Record<string, any>): T {
	return { ...ctx, log: ctx.log.child(fields) }
}
export function setLogLevel<T extends CS.Log>(ctx: T, level: Pino.Level): T {
	const child = ctx.log.child({})
	child.level = level
	return { ...ctx, log: child }
}

// LRU map in case of leaks
const spanStatusMap = new LRUMap<string, { code: Otel.SpanStatusCode; message?: string }>(500)

export function spanOp<Cb extends (...args: any[]) => Promise<any> | void>(
	name: string,
	opts: {
		tracer: Otel.Tracer
		links?: Otel.Link[]
		eventLogLevel?: Pino.Level
		root?: boolean
		attrs?: Record<string, any> | ((...args: Parameters<Cb>) => Record<string, any>)
	},
	cb: Cb,
): Cb {
	// @ts-expect-error idk
	return async (..._args) => {
		let args = _args
		let links = opts.links ?? []
		// by convention if ctx is passed as the first argument or the first element of the first argument if it's an array, then include any links attached to the context
		if (args[0]?.upstreamLinks) links = [...links, ...(args[0]?.upstreamLinks ?? [])]
		else if (args[0]?.[0]?.upstreamLinks) {
			links = [...links, ...(args[0]?.[0]?.upstreamLinks ?? [])]
		}

		return opts.tracer.startActiveSpan(
			name,
			{ root: opts.root, links },
			Otel.context.active(),
			async (span) => {
				let ctx: any
				const links: Otel.Link[] = [{ context: span.spanContext(), attributes: { ['slm.link-source']: 'upstream' } }]
				if (args[0]?.otelCtx) {
					ctx = args[0]
					args = [{ ...ctx, upstreamLinks: links }, ...args.slice(1)]
				} else if (args[0]?.[0]?.otelCtx) {
					ctx = args[0][0]
					args = [[{ ...ctx, upstreamLinks: links }, ...args[0].slice(1)], ...args.slice(1)]
				}

				// try to extract current serverId from context
				const serverId = ctx?.serverId
				if (serverId) {
					setSpanOpAttrs({ server_id: serverId })
				}

				const username = ctx?.user?.username
				if (username) {
					setSpanOpAttrs({ username: username })
				}

				if (typeof opts.attrs === 'function') {
					opts.attrs = opts.attrs(...args as Parameters<Cb>)
				}
				if (opts.attrs) {
					setSpanOpAttrs(opts.attrs)
				}

				let logger = baseLogger as typeof baseLogger | undefined
				if (args[0]?.log) {
					logger = args[0].log
				}
				const id = createId(6)
				setSpanOpAttrs({ op_id: id })
				try {
					const result = await cb(...args)
					let statusString: string
					if (result !== null && typeof result === 'object' && 'code' in result && typeof result.code === 'string') {
						statusString = result.code
						if (result.code === 'ok') {
							setSpanStatus(Otel.SpanStatusCode.OK)
						} else if (result.code.includes('err')) {
							const msg = result.msg ? `${result.code}: ${result.msg}` : result.code
							logger?.[opts.eventLogLevel ?? 'debug'](`Error running ${name}: ${msg}`)
							setSpanStatus(Otel.SpanStatusCode.ERROR, msg)
						}
					}
					let spanStatus = spanStatusMap.get(span.spanContext().spanId)
					if (!spanStatus) {
						spanStatus = { code: Otel.SpanStatusCode.OK }
						span.setStatus({ code: Otel.SpanStatusCode.OK })
					}
					const logLevel = spanStatus.code === Otel.SpanStatusCode.ERROR ? 'warn' : (opts.eventLogLevel ?? 'debug')
					statusString ??= spanStatus.code === Otel.SpanStatusCode.ERROR ? (spanStatus?.message ?? 'error') : 'ok'
					logger?.[logLevel](`${name}(${id}) : ${statusString}`)
					return result as Awaited<ReturnType<Cb>>
				} catch (error) {
					const message = recordGenericError(error)
					logger?.warn(`${name}(${id}) : error : ${message}`)
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
	const namespaced: Record<string, any> = {}
	for (const [key, value] of Object.entries(attrs)) {
		namespaced[`slm.op.${key}`] = value
	}
	Otel.default.trace.getActiveSpan()?.setAttributes(namespaced)
}
export function setSpanStatus(status: Otel.SpanStatusCode, message?: string) {
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
			const message = error instanceof Error ? error.message : String(error)
			setSpanStatus(Otel.SpanStatusCode.ERROR, message)
			return message
		}
	}
}

// -------- Logging end --------

export type Db =
	& {
		db(opts?: { redactParams?: boolean }): DB.Db
	}
	& CS.Log
	& Partial<Tx>

// indicates the context is in a db transaction
export type Tx = {
	tx: {
		rollback: () => void

		// tasks which will be executed after the transaction is committed
		unlockTasks: (() => void | Promise<void>)[]
	}
}

type ReleaseTask = () => void | Promise<void>
// TODO we may want some way of specifying in function signature what kinds of locks the context might acquire
export type Mutexes = {
	mutexes: {
		// represents the set of mutexes currently locked by the context
		locked: Set<Mutex>

		// tasks to be executed after mutex is released
		releaseTasks: ReleaseTask[]
	}
}
export function initLocks<Ctx extends object>(ctx?: Ctx): Ctx & Mutexes {
	return { ...(ctx ?? {} as Ctx), mutexes: { locked: new Set<Mutex>(), releaseTasks: [] } }
}

export type ResolvedRoute = { route: AR.ResolvedRoute }

// could also be ws upgrade
export type FastifyRequest = { req: Fastify.FastifyRequest; cookies: AR.Cookies } & Partial<ResolvedRoute>
export type FastifyRequestFull = FastifyRequest & AttachedFastify

export type FastifyReply = { res: Fastify.FastifyReply }
export type HttpRequest = FastifyRequest & FastifyReply
export type HttpRequestFull = HttpRequest & AttachedFastify

export type RoutedHttpRequest = HttpRequest
export function isRoutedHttpRequestContext<Ctx extends HttpRequest>(req: Ctx): req is Ctx & RoutedHttpRequest {
	return 'route' in req
}

// sparse subset of User
export type UserId = {
	user: { discordId: bigint }
}

export type User = {
	user: USR.User
}

export type Player = {
	player: SM.Player
}

export type UserOrPlayer = Partial<User> & Partial<Player>

export type RbacUser = { user: RBAC.UserWithRbac }

export type AuthSession = {
	sessionId: string
	expiresAt: Date
}

export type WSSession = {
	wsClientId: string
}

export type AuthedUser = User & AuthSession

export type AttachedFastify = CS.Log & Db & OtelCtx & Partial<ResolvedRoute>
export type Websocket = { ws: ws.WebSocket }
export type OrpcBase =
	& User
	& AuthSession
	& WSSession
	& Websocket
	& FastifyRequest
	& Db
	& CS.Log
	& Mutexes

export type AsyncResourceInvocation = {
	resOpts: AsyncResourceInvocationOpts
}

export type Rcon = {
	rcon: RconCore
}

export type ServerId = {
	serverId: string
}

export type SquadRcon = { server: SquadRconSys.SquadRconContext } & Rcon & ServerId

export type LayerQueue = {
	layerQueue: LayerQueueSys.LayerQueueContext
} & ServerId

export type Vote = {
	vote: LayerQueueSys.VoteContext
} & ServerId

export type MatchHistory = {
	matchHistory: MatchHistorySys.MatchHistoryContext
} & ServerId

export type SquadServer = Rcon & {
	server: SquadServerSys.SquadServer
} & ServerId

export type SharedLayerList = SharedLayerListSys.SharedLayerListContext & ServerId
export type ServerSliceSub = {
	serverSliceSub: Rx.Subscription
}
export type ServerSlice = SquadRcon & SquadServer & Vote & LayerQueue & MatchHistory & SharedLayerList & ServerSliceSub

/**
 * Creates an operator that wraps an observable with retry logic and additional trace context.
 *
 * @param name - Identifier for the subscription used in logs and traces
 * @param opts - Configuration options including:
 *               - ctx: Logging context
 *               - tracer: OpenTelemetry tracer instance
 *               - retryTimeoutMs: Delay between retries (default: 250ms)
 *               - numRetries: Maximum retry attempts (default: 3)
 * @param cb - Async callback function to process each emitted value
 * @returns An RxJS operator that transforms the source observable
 *
 * The returned operator:
 * - Creates spans for tracing execution
 * - Handles errors by logging them and recording in traces
 * - Automatically retries failed operations with configurable delay and retry count
 */
export function durableSub<T, O>(
	name: string,
	opts: {
		ctx: CS.Log
		tracer: Otel.Tracer
		eventLogLevel?: Pino.Level
		numTaskRetries?: number
		retryTaskOnValueError?: boolean
		numOfUpstreamErrorsBeforePropagation?: number
		retryTimeoutMs?: number
		taskScheduling?: 'switch' | 'parallel' | 'sequential' | 'exhaust'
		root?: boolean
		attrs?: Record<string, any> | ((arg: T) => Record<string, any>)
	},
	cb: (value: T) => Promise<O>,
): (o: Rx.Observable<T>) => Rx.Observable<O> {
	return (o) => {
		const numDownstreamFailureBeforeErrorPropagation = opts.numOfUpstreamErrorsBeforePropagation ?? 10
		const numRetries = Math.max(opts.numTaskRetries ?? 0, 0)
		const retryOnValueError = opts.retryTaskOnValueError ?? false
		const taskScheduling = opts.taskScheduling ?? 'sequential' as const

		const subSpan = opts.tracer.startSpan('durable-sub::' + name)
		const initializerLink: Otel.Link = {
			context: subSpan.spanContext(),
			attributes: { 'slm.link-source': 'sub-initializer' },
		}
		const taskOp = spanOp(name, { tracer: opts.tracer, links: [initializerLink], root: opts.root ?? true, attrs: opts.attrs }, cb)

		const getTask = (arg: T): Rx.Observable<O> => {
			const task = async () => {
				let attemptsLeft = numRetries + 1
				while (true) {
					try {
						const res = await taskOp(arg)
						if (retryOnValueError && (res as any).code !== 'ok') {
							attemptsLeft--
							if (attemptsLeft === 0) return res
							opts.ctx.log.warn(`retrying ${name}`)
							continue
						}
						return res
					} catch (error) {
						attemptsLeft--
						if (attemptsLeft === 0) throw error
						opts.ctx.log.warn(`retrying ${name} in ${opts.retryTimeoutMs ?? 0}ms`)
						await sleep(opts.retryTimeoutMs ?? 0)
					}
				}
			}

			// ensure that we only start the task on subscription.
			return toCold(task)
		}

		return o.pipe(
			Rx.tap({
				error: error => {
					const activeSpan = Otel.trace.getActiveSpan()
					activeSpan?.setStatus({ code: Otel.SpanStatusCode.ERROR })

					const span = activeSpan ?? subSpan
					span.recordException(error)
					opts.ctx.log.error(error)
				},
			}),
			({
				'parallel': Rx.mergeMap(getTask),
				'sequential': Rx.concatMap(getTask),
				'switch': Rx.switchMap(getTask),
				'exhaust': Rx.exhaustMap(getTask),
			})[taskScheduling],
			Rx.retry({ resetOnSuccess: true, count: numDownstreamFailureBeforeErrorPropagation, delay: opts.retryTimeoutMs ?? 250 }),
			Rx.tap({ subscribe: () => subSpan.addEvent('subscribed'), complete: () => subSpan.end() }),
		)
	}
}
