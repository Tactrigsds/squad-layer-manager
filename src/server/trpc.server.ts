import { initTRPC } from '@trpc/server'
import superjson from 'superjson'
import {} from '@/lib/object.ts'
import * as Otel from '@opentelemetry/api'

import * as C from './context.ts'

const t = initTRPC.context<C.TrpcRequest>().create({
	transformer: superjson,
})

const tracer = Otel.trace.getTracer('trpc-server')
const loggerMiddleware = t.middleware(async (opts) => {
	return tracer.startActiveSpan(`trpc:${opts.type}:${opts.path}`, { root: true }, async (span) => {
		try {
			opts.ctx.log.info(`trpc:${opts.type}:${opts.path}`)
			const ctx = opts.ctx
			span.setAttributes({
				username: ctx.user.username,
				user_id: ctx.user.discordId.toString(),
				sessionid_prefix: ctx.sessionId.slice(0, 8),

				ws_client_id: ctx.wsClientId.toString(),
			})
			const result = await opts.next(opts)
			if (!result.ok) {
				C.recordGenericError(result.error)
				opts.ctx.log.error(result.error, 'Error in trpc server: %s', result.error?.message)
			} else if (typeof result.data === 'object' && (result.data as any)?.code && (result.data as any)?.code !== 'ok') {
				const canonicalRes = result.data as { code: string; msg?: string }
				const msg = canonicalRes.msg ? `${canonicalRes.code}: ${canonicalRes.msg}` : canonicalRes.code
				C.setSpanStatus(Otel.SpanStatusCode.ERROR, msg)
			} else {
				C.setSpanStatus(Otel.SpanStatusCode.OK)
			}
			return result
		} catch (error) {
			C.recordGenericError(error)
			let message: string | null = null
			if (error instanceof Error) {
				message = error.message
				opts.ctx.log.error(error, 'Error in trpc server: %s', error.message)
			} else if (typeof error === 'string') {
				message = error
			}
			if (message) opts.ctx.log.error('Error in trpc server: %s', message)
			throw error
		} finally {
			span.end()
		}
	})
})

export const router = t.router
export const procedure = t.procedure.use(loggerMiddleware)
