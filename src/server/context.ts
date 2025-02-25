import { FastifyReply, FastifyRequest } from 'fastify'
import * as ws from 'ws'
import Pino from 'pino'
import * as M from '@/models.ts'
import RconCore from '@/lib/rcon/rcon-core.ts'
import * as DB from './db.ts'
import { Logger } from './logger.ts'
import * as Otel from '@opentelemetry/api'
import { SpanStatusCode } from '@opentelemetry/api'

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

export function spanOp<Cb extends (...args: any[]) => Promise<any>>(name: string, opts: { tracer: Otel.Tracer }, cb: Cb): Cb {
	//@ts-expect-error idk
	return async (...args) => {
		return opts.tracer.startActiveSpan(name, { root: !Otel.trace.getActiveSpan() }, async (span) => {
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
export type Tx = { tx: true }

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
}

export type WSSession = {
	wsClientId: string
}

export type AuthedUser = User & AuthSession

export type TrpcRequest = User & AuthSession & { wsClientId: string; req: FastifyRequest; ws: ws.WebSocket } & Db & Log
