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
	const ctx = opts.ctx
	return await C.spanOp(`trpc:${opts.type}:${opts.path}`, {
		root: true,
		tracer,
		eventLogLevel: opts.type === 'mutation' ? 'info' : 'debug',
		attrs: {
			username: ctx.user.username,
			user_id: ctx.user.discordId.toString(),
			sessionid_prefix: ctx.sessionId.slice(0, 8),

			ws_client_id: ctx.wsClientId.toString(),
		},
	}, async (opts) => {
		const result = await opts.next(opts)
		if (!result.ok) throw result.error
		return result
	})(opts)
})

export const router = t.router
export const procedure = t.procedure.use(loggerMiddleware)
