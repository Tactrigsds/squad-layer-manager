import { TRPCError } from '@trpc/server'
import { CreateFastifyContextOptions } from '@trpc/server/adapters/fastify'
import * as CacheManager from 'cache-manager'
import Cookie from 'cookie'
import { FastifyReply, FastifyRequest } from 'fastify'

import RconCore from '@/lib/rcon/rcon-core.ts'

import * as DB from './db.ts'
import { Logger, baseLogger } from './logger.ts'
import * as Schema from './schema.ts'
import * as Sessions from './systems/sessions.ts'

export type Log = {
	log: Logger
}
export function includeLogProperties<T extends Log & Partial<Db>>(ctx: T, fields: Record<string, any>): T {
	const log = ctx.log.child(fields)
	if (ctx.db) {
		//@ts-expect-error monkey patching
		ctx.db.session.logger.logQuery = function logQuery(query: string, params: unknown[]) {
			if (log.level === 'trace') ctx.log.trace('DB: %s: %o', params)
			else log.debug('DB: %s, %o', query, params)
		}
	}
	return { ...ctx, log }
}

export type Db = {
	db: DB.Db
}

export type Rcon = {
	rcon: RconCore
}

export type UnauthorizedRequest = { req: FastifyRequest; res: FastifyReply }

export type User = {
	user: Schema.User
}

export type Cache = {
	cache: ReturnType<typeof CacheManager.createCache>
}

export async function createAuthorizedRequestContext(req: FastifyRequest, res: FastifyReply) {
	const log = baseLogger.child({ reqId: req.id, path: req.url })
	const cookie = req.headers.cookie
	if (!cookie) return { code: 'unauthorized:no-cookie' as const, message: 'No cookie provided' }
	const sessionId = Cookie.parse(cookie).sessionId
	if (!sessionId) return { code: 'unauthorized:no-session' as const, message: 'No session provided' }

	const db = DB.get({ log })
	const validSession = await Sessions.validateSession(sessionId, { log, db })
	if (!validSession) return { code: 'unauthorized:invalid-session' as const, message: 'Invalid session' }

	return { code: 'ok' as const, ctx: { req: req, res: res, log, sessionId, db } }
}

export async function createTrpcRequestContext(options: CreateFastifyContextOptions) {
	const result = await createAuthorizedRequestContext(options.req, options.res)
	if (result.code !== 'ok') {
		switch (result.code) {
			case 'unauthorized:no-cookie':
			case 'unauthorized:no-session':
			case 'unauthorized:invalid-session':
				throw new TRPCError({ code: 'UNAUTHORIZED', message: result.message })
			default:
				throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Unknown error occurred' })
		}
	}
	return result.ctx
}

export type AuthedRequest = Extract<Awaited<ReturnType<typeof createAuthorizedRequestContext>>, { code: 'ok' }>['ctx']
