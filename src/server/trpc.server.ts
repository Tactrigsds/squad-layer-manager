import { initTRPC } from '@trpc/server'
import superjson from 'superjson'

import * as C from './context.ts'

const t = initTRPC.context<C.TrpcRequest>().create({
	transformer: superjson,
})

const loggerMiddleware = t.middleware(async (opts) => {
	await using ctx = C.pushOperation(opts.ctx, `trpc:${opts.type}:${opts.path}`, {
		level: 'info',
		startMsgBindings: { input: opts.input },
	})
	opts.ctx = ctx
	const result = await opts.next(opts)
	return result
})

export const router = t.router
export const procedure = t.procedure.use(loggerMiddleware)
