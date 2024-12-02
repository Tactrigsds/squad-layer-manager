import { initTRPC } from '@trpc/server'
import superjson from 'superjson'
import { z } from 'zod'

import * as C from './context.ts'

const t = initTRPC.context<C.AuthedRequest>().create({ transformer: superjson })

const loggerMiddleware = t.middleware(async (opts) => {
	const baseCtx = C.includeLogProperties(opts.ctx, { path: opts.path, input: opts.input })
	await using ctx = C.pushOperation(baseCtx, `trpc:${opts.type}:${opts.path}`)
	opts.ctx = ctx
	const result = await opts.next(opts)
	return result
})

export const router = t.router
export const procedure = t.procedure.use(loggerMiddleware)
export function procedureWithInput<InputSchema extends z.ZodType<any, any, any>>(input: InputSchema) {
	return procedure.input(input)
}
