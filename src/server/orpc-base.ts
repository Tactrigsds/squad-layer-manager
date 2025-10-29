import { os } from '@orpc/server'
import * as C from './context.ts'
import {} from '@/lib/object.ts'
import * as Otel from '@opentelemetry/api'

const tracer = Otel.trace.getTracer('layer-queue')

const base = os.$context<C.OrpcBase>()

const loggerMiddleware = base.middleware(async (opts) => {
	const ctx = opts.context
	const path = opts.path
	// TODO log levels
	return await C.spanOp(`orpc:${path.join('.')}`, {
		root: true,
		tracer,
		eventLogLevel: 'debug',
		attrs: {
			username: ctx.user.username,
			user_id: ctx.user.discordId.toString(),
			sessionid_prefix: ctx.sessionId.slice(0, 8),

			ws_client_id: ctx.wsClientId.toString(),
		},
	}, async (opts) => {
		const result = await opts.next(opts)
		debugger
		return result
	})(opts)
})

export default base
