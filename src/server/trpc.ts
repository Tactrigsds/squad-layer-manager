import { transformer } from '@/lib/trpc.ts'
import { initTRPC } from '@trpc/server'
import { z } from 'zod'

import { Context } from './context.ts'

const t = initTRPC.context<Context>().create({ transformer })

const loggerMiddleware = t.middleware(async ({ path, type, next, input, meta }) => {
	const start = Date.now()
	const result = await next()
	const durationMs = Date.now() - start
	if (result.ok) {
		//@ts-expect-error idk man
		const ctx = result.ctx as Context
		ctx.log = ctx.log.child({ type, input })
		ctx.log.debug({ path, type, durationMs, input }, 'TRPC %s: %s ', type, path)
	}
	return result
})

export const router = t.router
export const procedure = t.procedure.use(loggerMiddleware)
export function procedureWithInput<InputSchema extends z.ZodType<any, any, any>>(input: InputSchema) {
	return procedure.input(input).use(loggerMiddleware)
}
