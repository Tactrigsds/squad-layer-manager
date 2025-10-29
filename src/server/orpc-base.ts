import { os } from '@orpc/server'
import superjson from 'superjson'
import * as C from './context.ts'
import {} from '@/lib/object.ts'
import * as Otel from '@opentelemetry/api'
import { onError } from '@orpc/server'
import { RPCHandler } from '@orpc/server/ws'
import { appRouter, orpcAppRouter } from './router.ts'
import * as SquadServer from './systems/squad-server.ts'

const loggerMiddleware = os.middleware<C.Socket, any, any>(async ({ context: ctx, path, next }) => {
	// TODO log levels
	return await C.spanOp(`trpc:${path.join(',')}`, {
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

export default os.$context<C.Socket>().middleware(async ({ context: ctx, path, next }) => {
	// TODO log levels
	return await C.spanOp(`trpc:${path.join(',')}`, {
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
		debugger
		return result
	})(opts)
})
