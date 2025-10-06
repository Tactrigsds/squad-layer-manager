import * as AR from '@/app-routes.ts'
import { AsyncResourceInvocationOpts, toCold } from '@/lib/async.ts'
import { LRUMap } from '@/lib/fixed-size-map.ts'
import { createId } from '@/lib/id.ts'
import RconCore from '@/lib/rcon/core-rcon.ts'
import * as CS from '@/models/context-shared.ts'
import * as SM from '@/models/squad.models.ts'
import * as USR from '@/models/users.models.ts'
import * as RBAC from '@/rbac.models'
import * as LayerQueueSys from '@/server/systems/layer-queue.ts'
import * as MatchHistorySys from '@/server/systems/match-history.ts'
import * as SquadRconSys from '@/server/systems/squad-rcon.ts'
import * as SquadServerSys from '@/server/systems/squad-server.ts'
import * as Otel from '@opentelemetry/api'
import { Mutex } from 'async-mutex'
import { FastifyReply, FastifyRequest } from 'fastify'
import Pino from 'pino'
import * as Rx from 'rxjs'
import * as ws from 'ws'
import * as DB from './db.ts'
import { baseLogger } from './logger.ts'

export type OtelCtx = {
	otelCtx: Otel.Context
}

export type SpanContext = {
	span: Otel.Span
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
		parentSpan?: Otel.Span
		links?: Otel.Link[]
		eventLogLevel?: Pino.Level
		root?: boolean
		attrs?: Record<string, any> | ((...args: Parameters<Cb>) => Record<string, any>)
	},
	cb: Cb,
): Cb {
	// @ts-expect-error idk
	return async (...args) => {
		const activeSpanContext = Otel.context.active()
		let context: Otel.Context
		// by convention if ctx is passed as the first argument or the first element of the first argument if it's an array, then use its span context if it has one
		if (args[0]?.span?.spanContext) {
			context = Otel.trace.setSpan(activeSpanContext, args[0].span)
		} else if (args[0]?.[0]?.span?.spanContext) {
			context = Otel.trace.setSpan(activeSpanContext, args[0]?.[0]?.span)
		} else if (opts.parentSpan) {
			context = Otel.trace.setSpan(activeSpanContext, opts.parentSpan)
		} else {
			context = activeSpanContext
		}

		return opts.tracer.startActiveSpan(
			name,
			{ root: opts.root ?? !Otel.trace.getActiveSpan(), links: opts.links },
			context,
			async (span) => {
				// try to extract current serverId from context
				const serverId = args[0]?.serverId ?? args[0]?.[0]?.serverId
				if (serverId) {
					setSpanOpAttrs({ server_id: serverId })
				}

				const username = args[0]?.user?.username ?? args[0]?.[0]?.user?.username
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
					statusString ??= spanStatus.code === Otel.SpanStatusCode.ERROR ? `${spanStatus?.message ?? 'error'}` : 'ok'
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
		namespaced[`op.${key}`] = value
	}
	Otel.default.trace.getActiveSpan()?.setAttributes(namespaced)
}
export function setSpanStatus(status: Otel.SpanStatusCode, message?: string) {
	const activeSpan = Otel.default.trace.getActiveSpan()
	if (!activeSpan) return

	spanStatusMap.set(activeSpan.spanContext().spanId, { code: status, message })
	activeSpan.setStatus({ code: status, message })
}

export function pushOtelCtx<Ctx extends object>(ctx: Ctx) {
	return {
		...ctx,
		otelCtx: Otel.default.context.active(),
	}
}

export function getSpan() {
	return Otel.default.trace.getActiveSpan()
}

export function recordGenericError(error: unknown, setStatus = true) {
	const span = Otel.default.trace.getActiveSpan()
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
export type Locks = {
	locks: {
		// represents the set of mutexes currently locked by the context
		locked: Set<Mutex>

		// tasks to be executed after mutex is released
		releaseTasks: ReleaseTask[]
	}
}
export function initLocks<Ctx extends object>(ctx?: Ctx): Ctx & Locks {
	return { ...(ctx ?? {} as Ctx), locks: { locked: new Set<Mutex>(), releaseTasks: [] } }
}

export type HttpRequest = { req: FastifyRequest; res: FastifyReply; cookies: AR.Cookies; route?: AR.ResolvedRoute }
export type RoutedHttpRequest = HttpRequest & { route: AR.Route<'server'> }
export function isRoutedHttpRequestContext<Ctx extends HttpRequest>(req: Ctx): req is Ctx & RoutedHttpRequest {
	return 'route' in req
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

export type TrpcRequest =
	& User
	& AuthSession
	& { wsClientId: string; req: FastifyRequest; ws: ws.WebSocket }
	& Db
	& CS.Log
	& Locks

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

export type UserPresence = {
	userPresence: LayerQueueSys.UserPresenceContext
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

export type ServerSlice = Rcon & SquadServer & UserPresence & Vote & LayerQueue & MatchHistory & { serverSliceSub: Rx.Subscription }

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
 * - Executes callbacks strictly in sequence (using concatMap)
 */
export function durableSub<T, O>(
	name: string,
	opts: {
		ctx: CS.Log
		tracer: Otel.Tracer
		eventLogLevel?: Pino.Level
		numTaskRetries?: number
		retryTaskOnValueError?: boolean
		numDownstreamFailureBeforeErrorPropagation?: number
		downstreamRetryTimeoutMs?: number
		taskScheduling?: 'switch' | 'parallel' | 'sequential'
		root?: boolean
		attrs?: Record<string, any> | ((arg: T) => Record<string, any>)
	},
	cb: (value: T) => Promise<O>,
): (o: Rx.Observable<T>) => Rx.Observable<O> {
	return (o) => {
		const numDownstreamFailureBeforeErrorPropagation = opts.numDownstreamFailureBeforeErrorPropagation ?? 10
		const numRetries = opts.numTaskRetries ?? 0
		const retryOnValueError = opts.retryTaskOnValueError ?? false
		const taskScheduling = opts.taskScheduling || 'sequential' as const

		const subSpan = opts.tracer.startSpan('durable-sub::' + name)
		const link: Otel.Link = {
			context: subSpan.spanContext(),
			attributes: { 'link.reason': 'async-processing' },
		}

		const getTask = (arg: T): Rx.Observable<O> => {
			const task = async () => {
				let attemptsLeft = numRetries + 1
				while (true) {
					try {
						const res = await spanOp(name, { tracer: opts.tracer, links: [link], root: opts.root, attrs: opts.attrs }, cb)(arg)
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
						opts.ctx.log.warn(`retrying ${name}`)
					}
				}
			}

			// ensure that we only start the task on subscription. combined with concatMap this means that the tasks will only be executed one at a time
			return toCold(task)
		}

		return o.pipe(
			Rx.tap({
				error: error => {
					const activeSpan = Otel.default.trace.getActiveSpan()
					activeSpan?.addLink(link)
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
			})[taskScheduling],
			Rx.retry({ resetOnSuccess: true, count: numDownstreamFailureBeforeErrorPropagation, delay: opts.downstreamRetryTimeoutMs ?? 250 }),
			Rx.tap({ subscribe: () => subSpan.addEvent('subscribed'), complete: () => subSpan.end() }),
		)
	}
}
