import { TRPCError } from '@trpc/server'
import { CreateFastifyContextOptions } from '@trpc/server/adapters/fastify'
import Cookie from 'cookie'

import * as DB from './db.ts'
import { baseLogger } from './logger.ts'
import * as Sessions from './systems/sessions.ts'

export async function createContext(options: CreateFastifyContextOptions) {
	const log = baseLogger.child({ reqId: options.req.id, path: options.req.url })
	const cookie = options.req.headers.cookie
	if (!cookie) throw new TRPCError({ code: 'UNAUTHORIZED', message: 'No cookie' })
	const sessionId = Cookie.parse(cookie).sessionId
	if (!sessionId) throw new TRPCError({ code: 'UNAUTHORIZED', message: 'No sessionId' })

	const db = DB.get({ log })
	const validSession = await Sessions.validateSession(sessionId, { log, db })
	if (!validSession) throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Invalid sessionId' })

	return { req: options.req, res: options.res, log, sessionId, db }
}
export type Context = Awaited<ReturnType<typeof createContext>>
