import { TRPCError } from '@trpc/server'
import { CreateFastifyContextOptions } from '@trpc/server/adapters/fastify'
import Cookie from 'cookie'
import { FastifyReply, FastifyRequest } from 'fastify'
import Pino from 'pino'

import RconCore from '@/lib/rcon/rcon-core.ts'

import * as DB from './db.ts'
import { baseLogger, Logger } from './logger.ts'
import * as Schema from './schema.ts'
import * as Sessions from './systems/sessions.ts'

// -------- Logging --------
export type Log = {
	log: Logger
}

export function includeLogProperties<T extends Log>(ctx: T, fields: Record<string, any>): T {
	return { ...ctx, log: ctx.log.child(fields) }
}

export type Op = {
	tasks: Promise<any>[]
	result?: 'ok' | string
	endMsgBindings: Record<string, any>
	[Symbol.asyncDispose]: (err?: any) => Promise<void>
	[Symbol.dispose]: (err?: any) => void
}

let opIdx = 0
type OperationOptions = {
	level?: Pino.Level
	startMsgBindings?: Record<string, any>
}
export function pushOperation<T extends Log>(ctx: T, type: string, _opts?: OperationOptions): T & Op {
	const opts: OperationOptions = _opts ?? {}
	opts.level ??= 'debug'
	opts.startMsgBindings ??= {}
	const operationId = (opIdx++).toString()
	const bindings = ctx.log.bindings()
	const ops = bindings.ops ? [...bindings.ops] : []
	ops.push({ id: operationId, type })

	const handleResult = async function (this: any, err?: any) {
		const result = err ? 'error' : (this.result ?? 'ok')
		if (result && result !== 'ok') {
			this.log.error(err, 'operation failed', type, operationId)
			return
		}
		if (this.tasks.length > 0) {
			await Promise.all(this.tasks).catch((err) => {
				lifeCycleLog.error(err, 'operation failed', type, operationId)
				throw err
			})
		}
		lifeCycleLog[opts.level!]('operation completed', type, operationId)
	}

	const newCtx = {
		...includeLogProperties(ctx, { ops }),
		endMsgBindings: {},
		tasks: [],
		[Symbol.asyncDispose]: handleResult,
		[Symbol.dispose]: handleResult,
	}
	const lifeCycleLog = newCtx.log.child({ opLifecycle: true })

	lifeCycleLog[opts.level](opts.startMsgBindings, 'operation started', type, operationId)
	return newCtx
}

// -------- Logging end --------

export type Db = {
	db(): DB.Db
}

export type Rcon = {
	rcon: RconCore
}

export type AnyRequest = { req: FastifyRequest; res: FastifyReply }

export type User = {
	user: Schema.User
}

export async function createAuthorizedRequestContext(req: FastifyRequest, res: FastifyReply) {
	const log = baseLogger.child({ reqId: req.id, path: req.url })
	const cookie = req.headers.cookie
	if (!cookie) {
		return {
			code: 'unauthorized:no-cookie' as const,
			message: 'No cookie provided',
		}
	}
	const sessionId = Cookie.parse(cookie).sessionId
	if (!sessionId) {
		return {
			code: 'unauthorized:no-session' as const,
			message: 'No session provided',
		}
	}

	const ctx = DB.addPooledDb({ log })
	const validSession = await Sessions.validateSession(sessionId, ctx)
	if (validSession.code !== 'ok') {
		return {
			code: 'unauthorized:invalid-session' as const,
			message: 'Invalid session',
		}
	}

	return {
		code: 'ok' as const,
		ctx: {
			...ctx,
			log: ctx.log.child({ username: validSession.user.username }),
			req: req,
			res: res,
			sessionId,
			user: validSession.user,
		},
	}
}

// with the websocket transport this will run once per connection. right now there's no way to log users out if their session expires while they're logged in :shrug:
export async function createTrpcRequestContext(options: CreateFastifyContextOptions) {
	const result = await createAuthorizedRequestContext(options.req, options.res)
	if (result.code !== 'ok') {
		switch (result.code) {
			case 'unauthorized:no-cookie':
			case 'unauthorized:no-session':
			case 'unauthorized:invalid-session':
				throw new TRPCError({ code: 'UNAUTHORIZED', message: result.message })
			default:
				throw new TRPCError({
					code: 'INTERNAL_SERVER_ERROR',
					message: 'Unknown error occurred',
				})
		}
	}
	return result.ctx
}

export type AuthedRequest = Extract<Awaited<ReturnType<typeof createAuthorizedRequestContext>>, { code: 'ok' }>['ctx']
