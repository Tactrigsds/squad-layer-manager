import { FastifyReply, FastifyRequest } from 'fastify'
import * as ws from 'ws'
import Pino from 'pino'
import * as M from '@/models.ts'
import RconCore from '@/lib/rcon/rcon-core.ts'
import * as DB from './db.ts'
import { Logger } from './logger.ts'

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
	error?: any
	endMsgBindings: Record<string, any>
	[Symbol.asyncDispose]: (err?: any) => Promise<void>
	[Symbol.dispose]: (err?: any) => void
}

let opIdx = 0
type OperationOptions = {
	level?: Pino.Level
	startMsgBindings?: Record<string, any>
}

export function failOperation(ctx: Op, err?: any, code?: string): void {
	ctx.result = code ?? 'err'
	ctx.error = err
}

export function pushOperation<T extends Log>(ctx: T, type: string, _opts?: OperationOptions): T & Op {
	const opts: OperationOptions = _opts ?? {}
	opts.level ??= 'debug'
	opts.startMsgBindings ??= {}
	const operationId = (opIdx++).toString()
	const bindings = ctx.log.bindings()
	const ops = bindings.ops ? [...bindings.ops] : []
	ops.push({ id: operationId, type })

	const handleResult = async () => {
		const result = newCtx.result ?? 'ok'
		if (result && result !== 'ok') {
			lifeCycleLog.error(newCtx.error, 'operation failed: %s', result)
			return
		}
		if (newCtx.tasks.length > 0) {
			await Promise.all(newCtx.tasks).catch((err) => {
				lifeCycleLog.error(err, 'operation failed', type, operationId)
				throw err
			})
		}
		lifeCycleLog[opts.level!]('operation completed', type, operationId)
	}

	const newCtx: T & Op = {
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
} & Log

// indicates the context is in a db transaction
export type Tx = { tx: true }

export type Rcon = {
	rcon: RconCore
}

export type HttpRequest = { req: FastifyRequest; res: FastifyReply }

export type User = {
	user: M.User
}

export type RbacUser = { user: M.UserWithRbac }

export type AuthSession = {
	sessionId: string
}

export type WSSession = {
	wsClientId: string
}

export type AuthedRequest = User & AuthSession & HttpRequest & Db & Log

export type TrpcRequest = User & AuthSession & { wsClientId: string; req: FastifyRequest; ws: ws.WebSocket } & Db & Log
