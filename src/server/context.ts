import { CreateFastifyContextOptions } from '@trpc/server/adapters/fastify'

import baseLogger from './logger.ts'

export function createContext(options: CreateFastifyContextOptions) {
	const log = baseLogger.child({ reqId: options.req.id, path: options.req.url })
	return { req: options.req, res: options.res, log }
}
export type Context = Awaited<ReturnType<typeof createContext>>
