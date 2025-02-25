import { initTRPC } from '@trpc/server'
import superjson from 'superjson'
import {} from '@/lib/object.ts'
import * as Otel from '@opentelemetry/api'

import * as C from './context.ts'
import { baseLogger } from './logger.ts'

const t = initTRPC.context<C.TrpcRequest>().create({
	transformer: superjson,
})

const tracer = Otel.trace.getTracer('trpc-server')
const loggerMiddleware = t.middleware(async (opts) => {
	return tracer.startActiveSpan(`trpc:${opts.type}:${opts.path}`, { root: true }, async (span) => {
		try {
			baseLogger.info(`processing ${opts.type} ${opts.path}`)
			const ctx = opts.ctx
			span.setAttributes({
				username: ctx.user.username,
				user_id: ctx.user.discordId.toString(),
				sessionid_prefix: ctx.sessionId.slice(0, 8),

				ws_client_id: ctx.wsClientId.toString(),
			})
			const result = await opts.next(opts)
			if (!result.ok) {
				C.setSpanStatus(Otel.SpanStatusCode.ERROR, `${result.error?.code}: ${result.error?.message}`)
				baseLogger.error(result.error, 'Error in trpc server: %s', result.error?.message)
			} else if (typeof result.data === 'object' && (result.data as any)?.code && (result.data as any)?.code !== 'ok') {
				const canonicalRes = result.data as { code: string; msg?: string }
				const msg = canonicalRes.msg ? `${canonicalRes.code}: ${canonicalRes.msg}` : canonicalRes.code
				C.setSpanStatus(Otel.SpanStatusCode.ERROR, msg)
			} else {
				C.setSpanStatus(Otel.SpanStatusCode.OK)
			}
			return result
		} catch (error) {
			// const span = Otel.trace.getActiveSpan()
			if (error instanceof Error) {
				span.recordException(error)
				baseLogger.error(error, 'Error in trpc server: %s', error.message)
				C.setSpanStatus(Otel.SpanStatusCode.ERROR, error.message)
			} else if (typeof error === 'string') {
				span.recordException(error)
				baseLogger.error('Error in trpc server: %s', error)
				C.setSpanStatus(Otel.SpanStatusCode.ERROR, error)
			}
			throw error
		} finally {
			span.end()
		}
	})
})

export const router = t.router
export const procedure = t.procedure.use(loggerMiddleware)
