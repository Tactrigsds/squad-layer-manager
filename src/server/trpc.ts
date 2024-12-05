import { initTRPC } from '@trpc/server'
import superjson from 'superjson'
import { z } from 'zod'

import * as C from './context.ts'

const t = initTRPC.context<C.AuthedRequest>().create({ transformer: superjson })

const loggerMiddleware = t.middleware(async (opts) => {
	const baseCtx = C.includeLogProperties(opts.ctx, { path: opts.path, input: opts.input })
	await using ctx = C.pushOperation(baseCtx, `trpc:${opts.type}:${opts.path}`, {level: opts.type === 'mutation' ? 'info' : 'debug'})
	opts.ctx = ctx
	const result = await opts.next(opts)
	return result
})

export const router = t.router
export const procedure = t.procedure.use(loggerMiddleware)
