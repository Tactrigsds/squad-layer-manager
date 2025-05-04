import { AsyncResourceInvocationOpts, toCold } from '@/lib/async.ts'
import RconCore from '@/lib/rcon/core-rcon.ts'
import * as M from '@/models.ts'
import * as Otel from '@opentelemetry/api'
import { SpanStatusCode } from '@opentelemetry/api'
import { FastifyReply, FastifyRequest } from 'fastify'
import Pino from 'pino'
import * as Rx from 'rxjs'
import * as ws from 'ws'
import * as DB from './db.ts'
import { Logger } from './logger.ts'

// -------- Logging --------
export type Log = {
	log: Logger
}

export type OtelCtx = {
	otelCtx: Otel.Context
}

export type SpanContext = {
	span: Otel.Span
}

export function includeLogProperties<T extends Log>(ctx: T, fields: Record<string, any>): T {
	return { ...ctx, log: ctx.log.child(fields) }
}

export type Op = {
	tasks: Promise<any>[]
	result?: 'ok' | string
	error?: any
	endMsgBindings: Record<string, any>
	[Symbol.asyncDispose]: () => Promise<void>
	[Symbol.dispose]: () => void
}

let opIdx = 0
type OperationOptions = {
	level?: Pino.Level
	startMsgBindings?: Record<string, any>
}

export function failOperation(ctx: Op, err?: any, code?: string): void {
	ctx.result = code ?? 'err'
	ctx.error = err
}

export function spanOp<Cb extends (...args: any[]) => Promise<any> | void>(
	name: string,
	opts: { tracer: Otel.Tracer; onError?: (err: any) => void; parentSpan?: Otel.Span; links?: Otel.Link[] },
	cb: Cb,
): Cb {
	// @ts-expect-error idk
	return async (...args) => {
		const activeSpanContext = Otel.context.active()
		let context: Otel.Context
		// by convention if ctx is passed as the first argument then use its span context if it exists
		if (args[0]?.span?.spanContext) {
			context = Otel.trace.setSpan(activeSpanContext, args[0].span)
		} else if (opts.parentSpan) {
			context = Otel.trace.setSpan(activeSpanContext, opts.parentSpan)
		} else {
			context = activeSpanContext
		}

		return opts.tracer.startActiveSpan(name, { root: !Otel.trace.getActiveSpan(), links: opts.links }, context, async (span) => {
			try {
				const result = await cb(...args)
				if (typeof result === 'object' && 'code' in result) {
					if (result.code === 'ok') {
						span.setStatus({ code: Otel.SpanStatusCode.OK })
					} else {
						const msg = result.msg ? `${result.code}: ${result.msg}` : result.code
						span.setStatus({ code: Otel.SpanStatusCode.ERROR, message: msg })
					}
				}
				return result as Awaited<ReturnType<Cb>>
			} catch (error) {
				let message: string
				if (error instanceof Error) {
					span.recordException(error)
					message = error.message
				} else {
					message = typeof error === 'string' ? error : JSON.stringify(error)
					span.recordException(message)
				}
				span.setStatus({ code: SpanStatusCode.ERROR, message })
				throw error
			} finally {
				span.end()
			}
		})
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
	Otel.default.trace.getActiveSpan()?.setStatus({ code: status, message })
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
			setSpanStatus(Otel.SpanStatusCode.ERROR, error instanceof Error ? error.message : String(error))
		}
	}
}

export function pushOperation<T extends Log>(ctx: T, type: string, _opts?: OperationOptions): T & Op {
	const opts: OperationOptions = _opts ?? {}
	opts.level ??= 'debug'
	opts.startMsgBindings ??= {}
	const operationId = (opIdx++).toString()
	const bindings = ctx.log.bindings()
	const ops = bindings.ops ? [...bindings.ops] : []
	ops.push({ id: operationId, type })

	const handleResult = async () => {
		const result = newCtx.result ?? 'ok'
		if (result && result !== 'ok') {
			lifeCycleLog.error(newCtx.error, 'operation failed: %s', result)
			return
		}
		if (newCtx.tasks.length > 0) {
			await Promise.all(newCtx.tasks).catch((err) => {
				lifeCycleLog.error(err, 'operation failed', type, operationId)
				throw err
			})
		}
		lifeCycleLog[opts.level!]('operation completed', type, operationId)
	}

	const newCtx: T & Op = {
		...includeLogProperties(ctx, { ops }),
		endMsgBindings: {},
		tasks: [],
		[Symbol.asyncDispose]: handleResult,
		[Symbol.dispose]: handleResult,
	}
	const lifeCycleLog = newCtx.log.child({ opLifecycle: true })

	lifeCycleLog[opts.level](opts.startMsgBindings, 'operation started', type, operationId)
	return newCtx
}

// -------- Logging end --------

export type Db = {
	db(opts?: { redactParams?: boolean }): DB.Db
} & Log

// indicates the context is in a db transaction
export type Tx = { tx: { rollback: () => void } }

export type Rcon = {
	rcon: RconCore
}

export type HttpRequest = { req: FastifyRequest; res: FastifyReply } & Log & Db

export type User = {
	user: M.User
}

export type RbacUser = { user: M.UserWithRbac }

export type AuthSession = {
	sessionId: string
	expiresAt: Date
}

export type WSSession = {
	wsClientId: string
}

export type AuthedUser = User & AuthSession

export type TrpcRequest = User & AuthSession & { wsClientId: string; req: FastifyRequest; ws: ws.WebSocket } & Db & Log

export type AsyncResourceInvocation = {
	resOpts: AsyncResourceInvocationOpts
}

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
	opts: { ctx: Log; tracer: Otel.Tracer; retryTimeoutMs?: number; numRetries?: number },
	cb: (value: T) => Promise<O>,
): (o: Rx.Observable<T>) => Rx.Observable<O> {
	return (o) => {
		const subSpan = opts.tracer.startSpan('durable-sub::' + name)
		const link: Otel.Link = {
			context: subSpan.spanContext(),
			attributes: { 'link.reason': 'async-processing' },
		}
		let retriesLeft = opts.numRetries ?? 3
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
			Rx.concatMap((arg) => {
				const task = () => (spanOp(name, { tracer: opts.tracer, links: [link] }, cb)(arg))

				// ensure that we only start the task on subscription. combined with concatMap this means that the tasks will only be executed one at a time
				return toCold(task)
			}),
			Rx.tap({
				next: () => {
					retriesLeft = opts.numRetries ?? 3
				},
				error: (err) => {
					opts.ctx.log.error(err)
					opts.ctx.log.error('retries left for %s : %s', name, retriesLeft)
					retriesLeft--
				},
			}),
			Rx.retry({ resetOnSuccess: true, count: opts.numRetries ?? 3, delay: opts.retryTimeoutMs ?? 250 }),
			Rx.tap({ subscribe: () => subSpan.addEvent('subscribed'), complete: () => subSpan.end() }),
		)
	}
}
