import fastifyCookie from '@fastify/cookie'
import { CreateFastifyContextOptions } from '@trpc/server/adapters/fastify'
import fastifyFormBody from '@fastify/formbody'

import oauthPlugin from '@fastify/oauth2'
import Cookie from 'cookie'
import fastifyStatic from '@fastify/static'
import ws from '@fastify/websocket'
import { WebSocket } from 'ws'
import { fastifyTRPCPlugin, FastifyTRPCPluginOptions } from '@trpc/server/adapters/fastify'
import { eq } from 'drizzle-orm'
import fastify, { FastifyReply, FastifyRequest } from 'fastify'
import * as path from 'node:path'

import * as Paths from '@/server/paths'
import * as AR from '@/app-routes.ts'
import { createId } from '@/lib/id.ts'
import { assertNever } from '@/lib/typeGuards.ts'
import * as Discord from '@/server/systems/discord.ts'
import * as C from '@/server/context.ts'
import * as DB from '@/server/db'
import { ENV } from '@/server/env.ts'
import { baseLogger, Logger } from '@/server/logger.ts'
import * as TrpcRouter from '@/server/router'
import * as Schema from '@/server/schema.ts'
import * as Sessions from '@/server/systems/sessions.ts'
import * as Rbac from '@/server/systems/rbac.system.ts'
import * as RBAC from '@/rbac.models'
import { TRPCError } from '@trpc/server'
import * as WsSessionSys from '@/server/systems/ws-session.ts'

function getFastifyBase() {
	return fastify({
		maxParamLength: 5000,
		logger: false,
	})
}
let server!: ReturnType<typeof getFastifyBase>

export async function setupFastify() {
	server = getFastifyBase()

	// --------  logging --------
	server.log = baseLogger
	server.addHook('onRequest', async (request) => {
		const path = request.url.replace(/^(.*\/\/[^\\/]+)/i, '').split('?')[0]
		if (path.startsWith('/trpc')) return
		const ctx = C.pushOperation({ log: server.log as Logger }, `http:${path}:${request.method}:${request.id}`, {
			level: 'info',
		})
		request.log = ctx.log
		//@ts-expect-error monkey patching
		request.ctx = ctx
	})

	server.addHook('onError', async (request, reply, error) => {
		//@ts-expect-error monkey patching
		const ctx = request.ctx
		ctx.log.error(error, 'request error')
		ctx[Symbol.asyncDispose]()
	})

	server.addHook('onResponse', async (request, reply) => {
		// @ts-expect-error lame
		const ctx = request.ctx
		ctx.log.info(
			{
				reqUrl: request.url,
				method: request.method,
				statusCode: reply.statusCode,
				contentType: reply.getHeader('content-type'),
			},
			'request complete'
		)
		await ctx[Symbol.asyncDispose]()
	})

	// --------  static file serving --------
	switch (ENV.NODE_ENV) {
		case 'production':
			server.register(fastifyStatic, {
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

	await server.register(fastifyFormBody)

	await server.register(fastifyCookie)
	await server.register(oauthPlugin, {
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

	server.get(AR.exists('/login/callback'), async function (req, reply) {
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
		const ctx = DB.addPooledDb({ log: req.log as Logger })
		const denyRes = await Rbac.tryDenyPermissionsForUser(ctx, discordUser.id, { check: 'all', permits: [RBAC.perm('site:authorized')] })
		if (denyRes) {
			switch (denyRes.code) {
				case 'err:permission-denied':
					return reply.status(401).send('You have not been granted access to this application: ')
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
				await tx.update(Schema.users).set({ username: discordUser.username }).where(eq(Schema.users.discordId, user.discordId))
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
				maxAge: Sessions.SESSION_MAX_AGE,
				httpOnly: true,
			})
			.redirect('/')
	})

	server.post(AR.exists('/logout'), async function (req, res) {
		const authRes = await createAuthorizedRequestContext(req, res)
		if (authRes.code !== 'ok') {
			return Sessions.clearInvalidSession({ req, res })
		}

		return await Sessions.logout(authRes.ctx)
	})

	await server.register(ws)
	await server.register(fastifyTRPCPlugin, {
		prefix: AR.exists('/trpc'),
		useWSS: true,
		keepAlive: {
			enabled: true,
			pingMs: 30_000,
			pongWaitMs: 5000,
		},
		trpcOptions: {
			router: TrpcRouter.appRouter,
			createContext: createTrpcRequestContext,
			onError({ path, error, ctx, input, type }) {
				;(ctx ?? server).log.child({ input }).error(error, `Error in tRPC %s on path %s:`, type, path)
			},
		} satisfies FastifyTRPCPluginOptions<TrpcRouter.AppRouter>['trpcOptions'],
	})

	async function getHtmlResponse(req: FastifyRequest, res: FastifyReply) {
		res = res.header('Cross-Origin-Opener-Policy', 'same-origin').header('Cross-Origin-Embedder-Policy', 'unsafe-none')
		const authRes = await createAuthorizedRequestContext(req, res)
		switch (authRes.code) {
			case 'ok':
				break
			case 'unauthorized:no-cookie':
			case 'unauthorized:no-session':
			case 'unauthorized:invalid-session':
				return Sessions.clearInvalidSession({ req, res })
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
		server.get(route.server, getHtmlResponse)
	}

	// --------  start server  --------
	try {
		server.log.info('Starting server...')
		await server.listen({ port: ENV.PORT, host: ENV.HOST })
	} catch (err) {
		server.log.error(err)
		process.exit(1)
	}
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
	const authedCtx: C.AuthedRequest = {
		...ctx,
		sessionId,
		user: validSession.user,
		req,
		res,
		log: log.child({ username: validSession.user.username }),
	}

	return {
		code: 'ok' as const,
		ctx: authedCtx,
	}
}

// with the websocket transport this will run once per connection. right now there's no way to log users out if their session expires while they're logged in :shrug:
export async function createTrpcRequestContext(options: CreateFastifyContextOptions): Promise<C.TrpcRequest> {
	const result = await createAuthorizedRequestContext(options.req, options.res)
	if (result.code !== 'ok') {
		switch (result.code) {
			case 'unauthorized:no-cookie':
			case 'unauthorized:no-session':
			case 'unauthorized:invalid-session':
				// sleep(500).then(() => (options.res as unknown as WebSocket).close())
				throw new TRPCError({ code: 'UNAUTHORIZED', message: result.message })
			default:
				throw new TRPCError({
					code: 'INTERNAL_SERVER_ERROR',
					message: 'Unknown error occurred',
				})
		}
	}
	const wsClientId = createId(32)
	const ctx: C.TrpcRequest = {
		wsClientId,
		user: result.ctx.user,
		sessionId: result.ctx.sessionId,
		req: options.req,
		ws: result.ctx.res as unknown as WebSocket,
		log: result.ctx.log.child({ wsClientId }),
		db: result.ctx.db,
	}
	WsSessionSys.registerClient(ctx)
	return ctx
}
