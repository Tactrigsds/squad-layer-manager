import fastifyCookie from '@fastify/cookie'
import fastifyFormBody from '@fastify/formbody'
import { CreateFastifyContextOptions } from '@trpc/server/adapters/fastify'

import * as Messages from '@/messages'
import oauthPlugin from '@fastify/oauth2'
import fastifyStatic from '@fastify/static'
import ws from '@fastify/websocket'
import { fastifyTRPCPlugin, FastifyTRPCPluginOptions } from '@trpc/server/adapters/fastify'
import Cookie from 'cookie'
import { eq } from 'drizzle-orm'
import fastify, { FastifyReply, FastifyRequest } from 'fastify'
import * as path from 'node:path'
import { WebSocket } from 'ws'

import * as Schema from '$root/drizzle/schema.ts'
import * as AR from '@/app-routes.ts'
import { createId } from '@/lib/id.ts'
import { assertNever } from '@/lib/typeGuards.ts'
import * as RBAC from '@/rbac.models'
import * as C from '@/server/context.ts'
import * as DB from '@/server/db'
import { ENV } from '@/server/env.ts'
import { baseLogger, Logger } from '@/server/logger.ts'
import * as Paths from '@/server/paths'
import * as TrpcRouter from '@/server/router'
import * as Discord from '@/server/systems/discord.ts'
import * as Rbac from '@/server/systems/rbac.system.ts'
import * as Sessions from '@/server/systems/sessions.ts'
import * as WsSessionSys from '@/server/systems/ws-session.ts'
import * as Otel from '@opentelemetry/api'
import { TRPCError } from '@trpc/server'

async function getFastifyBase() {
	return await fastify({
		maxParamLength: 5000,
		logger: false,
	})
}
const tracer = Otel.trace.getTracer('fastify')
let instance!: Awaited<ReturnType<typeof getFastifyBase>>

export const setupFastify = C.spanOp('fastify:setup', { tracer }, async () => {
	instance = await getFastifyBase()

	// --------  logging --------
	instance.log = baseLogger
	instance.addHook('onRequest', async (request) => {
		const path = request.url.replace(/^(.*\/\/[^\\/]+)/i, '').split('?')[0]
		if (path.startsWith('/trpc')) return
		const ctx = DB.addPooledDb({ log: instance.log as Logger })
		request.log = ctx.log
		// @ts-expect-error monkey patching
		request.ctx = ctx
	})

	function getCtx(req: FastifyRequest) {
		return (req as any).ctx as C.Log & C.Db
	}

	// --------  static file serving --------
	switch (ENV.NODE_ENV) {
		case 'production':
			instance.register(fastifyStatic, {
				root: path.join(Paths.PROJECT_ROOT, 'dist'),
				// setHeaders: (res) => {
				// 	res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
				// 	res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp')
				// },
			})
			break
		case 'development':
			break
		default:
			assertNever(ENV.NODE_ENV)
	}

	await instance.register(fastifyFormBody)

	await instance.register(fastifyCookie)
	await instance.register(oauthPlugin, {
		name: 'discordOauth2',
		credentials: {
			client: {
				id: ENV.DISCORD_CLIENT_ID,
				secret: ENV.DISCORD_CLIENT_SECRET,
			},
			auth: oauthPlugin.DISCORD_CONFIGURATION,
		},
		startRedirectPath: AR.exists('/login'),

		callbackUri: `${ENV.ORIGIN}${AR.exists('/login/callback')}`,
		scope: ['identify'],
	})

	instance.get(AR.exists('/login/callback'), async function(req, reply) {
		// @ts-expect-error lame
		const tokenResult = await this.discordOauth2.getAccessTokenFromAuthorizationCodeFlow(req)
		const token = tokenResult.token as {
			access_token: string
			token_type: string
		}
		const discordUser = await Discord.getOauthUser(token)
		if (!discordUser) {
			return reply.status(401).send('Failed to get user info from Discord')
		}
		const ctx = getCtx(req)
		const denyRes = await Rbac.tryDenyPermissionsForUser(ctx, discordUser.id, RBAC.perm('site:authorized'))
		if (denyRes) {
			switch (denyRes.code) {
				case 'err:permission-denied':
					return reply.status(401).send(Messages.GENERAL.auth.noApplicationAccess)
				default:
					assertNever(denyRes.code)
			}
		}

		const sessionId = createId(64)
		await ctx.db().transaction(async (tx) => {
			const [user] = await tx.select().from(Schema.users).where(eq(Schema.users.discordId, discordUser.id)).for('update')
			if (!user) {
				await tx.insert(Schema.users).values({
					discordId: discordUser.id,
					username: discordUser.username,
					avatar: discordUser.avatar,
				})
			} else {
				await tx
					.update(Schema.users)
					.set({ username: discordUser.username, avatar: discordUser.avatar })
					.where(eq(Schema.users.discordId, discordUser.id))
			}
			await tx.insert(Schema.sessions).values({
				id: sessionId,
				userId: discordUser.id,
				expiresAt: new Date(Date.now() + Sessions.SESSION_MAX_AGE),
			})
		})
		reply
			.cookie('sessionId', sessionId, {
				path: '/',
				// maxAge: Sessions.SESSION_MAX_AGE,
				httpOnly: true,
			})
			.redirect('/')
	})

	instance.post(AR.exists('/logout'), async function(req, res) {
		const ctx = getCtx(req)
		const authRes = await createAuthorizedRequestContext({ ...ctx, req, span: Otel.trace.getActiveSpan() })
		if (authRes.code !== 'ok') {
			return Sessions.clearInvalidSession({ ...ctx, req, res })
		}

		return await Sessions.logout({ ...authRes.ctx, res })
	})

	await instance.register(ws)
	await instance.register(fastifyTRPCPlugin, {
		prefix: AR.exists('/trpc'),
		useWSS: true,
		keepAlive: {
			enabled: false,
			pingMs: 5000,
			pongWaitMs: 5000,
		},
		trpcOptions: {
			router: TrpcRouter.appRouter,
			createContext: createTrpcRequestContext,
		} satisfies FastifyTRPCPluginOptions<TrpcRouter.AppRouter>['trpcOptions'],
	})

	// -------- webpage serving --------
	async function getHtmlResponse(req: FastifyRequest, res: FastifyReply) {
		res = res.header('Cross-Origin-Opener-Policy', 'same-origin').header('Cross-Origin-Embedder-Policy', 'unsafe-none')
		const ctx = getCtx(req)
		const authRes = await createAuthorizedRequestContext({ ...ctx, req, span: Otel.trace.getActiveSpan() })
		switch (authRes.code) {
			case 'ok':
				break
			case 'unauthorized:no-cookie':
			case 'unauthorized:no-session':
			case 'unauthorized:invalid-session':
				return Sessions.clearInvalidSession({ ...ctx, req, res })
			case 'err:permission-denied':
				return res.status(401).send(Messages.GENERAL.auth.noApplicationAccess)
			default:
				assertNever(authRes)
		}

		switch (ENV.NODE_ENV) {
			case 'development': {
				// --------  dev server proxy setup --------
				// When running in dev mode, we're proxying all html routes through to fastify so we can do auth and stuff. Non-proxied routes will just return the dev index.html, So we can just get it from the dev server. convoluted, but easier than trying to deeply integrate vite into fastify like what @fastify/vite does(badly)
				const htmlRes = await fetch(`${ENV.ORIGIN}/idk`)
				return res
					.type('text/html')
					.header('Access-Control-Allow-Origin', '*')
					.header('Access-Control-Allow-Methods', '*')
					.header('Access-Control-Allow-Headers', '*')
					.header('Cross-Origin-Resource-Policy', 'cross-origin')
					.send(htmlRes.body)
			}
			case 'production': {
				return res.sendFile('index.html')
			}
			default:
				assertNever(ENV.NODE_ENV)
		}
	}

	for (const route of Object.values(AR.routes)) {
		if (route.handle !== 'page') continue
		instance.get(route.server, getHtmlResponse)
	}

	// --------  start server  --------
	instance.log.info('Starting server...')

	await instance.listen({ port: ENV.PORT, host: ENV.HOST })
	const serverClosed = new Promise((resolve) => {
		instance.server.on('closed', () => {
			resolve('Server closed')
		})
	})
	return { serverClosed }
})

export async function createAuthorizedRequestContext<T extends C.Log & C.Db & Partial<C.SpanContext> & { req: FastifyRequest }>(ctx: T) {
	const cookie = ctx.req.headers.cookie
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

	const validSessionRes = await Sessions.validateSession(sessionId, ctx)
	switch (validSessionRes.code) {
		case 'err:expired':
		case 'err:not-found':
			return {
				code: 'unauthorized:invalid-session' as const,
				message: 'Invalid session',
			}
		case 'err:permission-denied':
			return validSessionRes
		case 'ok':
			break
		default:
			assertNever(validSessionRes)
	}

	const authedCtx: T & C.AuthedUser = {
		...ctx,
		sessionId,
		user: validSessionRes.user,
		log: ctx.log.child({ username: validSessionRes.user.username }),
	}
	if (ctx.span) {
		ctx.span.setAttributes({
			username: authedCtx.user.username,
			user_id: authedCtx.user.discordId.toString(),
			sessionid_prefix: authedCtx.sessionId.slice(0, 8),
		})
	}

	return {
		code: 'ok' as const,
		ctx: authedCtx,
	}
}

// with the websocket transport this will run once per connection. right now there's no way to log users out if their session expires while they're logged in :shrug:
export async function createTrpcRequestContext(options: CreateFastifyContextOptions): Promise<C.TrpcRequest> {
	const result = await createAuthorizedRequestContext(DB.addPooledDb({ log: baseLogger, req: options.req }))
	if (result.code !== 'ok') {
		switch (result.code) {
			case 'unauthorized:no-cookie':
			case 'unauthorized:no-session':
			case 'unauthorized:invalid-session':
				// sleep(500).then(() => (options.res as unknown as WebSocket).close())
				throw new TRPCError({ code: 'UNAUTHORIZED', message: result.message })
			case 'err:permission-denied':
				throw new TRPCError({ code: 'UNAUTHORIZED', message: Messages.GENERAL.auth.noApplicationAccess })
			default:
				assertNever(result)
		}
	}
	const wsClientId = createId(32)
	const ctx: C.TrpcRequest = {
		wsClientId,
		user: result.ctx.user,
		sessionId: result.ctx.sessionId,
		req: options.req,
		ws: options.res as unknown as WebSocket,
		log: result.ctx.log.child({ wsClientId }),
		db: result.ctx.db,
	}
	WsSessionSys.registerClient(ctx)
	return ctx
}
