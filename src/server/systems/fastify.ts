import * as Schema from '$root/drizzle/schema.ts'
import * as AR from '@/app-routes.ts'
import { createId } from '@/lib/id.ts'
import { assertNever } from '@/lib/type-guards'
import * as Messages from '@/messages'
import * as CS from '@/models/context-shared'
import * as RBAC from '@/rbac.models'
import * as C from '@/server/context.ts'
import * as DB from '@/server/db'
import * as Env from '@/server/env.ts'
import { baseLogger } from '@/server/logger.ts'
import * as Paths from '@/server/paths'
import * as TrpcRouter from '@/server/router'
import * as Discord from '@/server/systems/discord.ts'
import * as LayerDb from '@/server/systems/layer-db.server'
import * as Rbac from '@/server/systems/rbac.system.ts'
import * as Sessions from '@/server/systems/sessions.ts'
import * as WsSessionSys from '@/server/systems/ws-session.ts'
import fastifyCookie from '@fastify/cookie'
import fastifyFormBody from '@fastify/formbody'
import oauthPlugin from '@fastify/oauth2'
import fastifyStatic from '@fastify/static'
import ws from '@fastify/websocket'
import * as Otel from '@opentelemetry/api'
import { TRPCError } from '@trpc/server'
import { CreateFastifyContextOptions } from '@trpc/server/adapters/fastify'
import { fastifyTRPCPlugin, FastifyTRPCPluginOptions } from '@trpc/server/adapters/fastify'
import { eq } from 'drizzle-orm'
import fastify, { FastifyReply, FastifyRequest } from 'fastify'
import * as path from 'node:path'
import { WebSocket } from 'ws'

const envBuilder = Env.getEnvBuilder({ ...Env.groups.general, ...Env.groups.httpServer, ...Env.groups.discord })
let ENV!: ReturnType<typeof envBuilder>
const tracer = Otel.trace.getTracer('fastify')
let instance!: Awaited<ReturnType<typeof getFastifyBase>>

async function getFastifyBase() {
	return await fastify({
		maxParamLength: 5000,
		logger: false,
	})
}

export const setup = C.spanOp('fastify:setup', { tracer }, async () => {
	ENV = envBuilder()
	instance = await getFastifyBase()

	// --------  logging --------
	instance.log = baseLogger
	instance.addHook('onRequest', async (request) => {
		const path = request.url.replace(/^(.*\/\/[^\\/]+)/i, '').split('?')[0]
		baseLogger.info(
			{
				method: request.method,
				url: request.url,
				ip: request.ip,
				userAgent: request.headers['user-agent'],
			},
			'incoming request %s %s',
			request.method,
			request.url,
		)
		if (path.startsWith('/trpc')) return
		const ctx = DB.addPooledDb({ log: instance.log as CS.Logger })

		request.log = ctx.log
		// @ts-expect-error monkey patching
		request.ctx = ctx
	})

	function getCtx(req: FastifyRequest) {
		return (req as any).ctx as CS.Log & C.Db
	}

	// --------  static file serving --------
	switch (ENV.NODE_ENV) {
		case 'production':
			instance.register(fastifyStatic, {
				root: path.join(Paths.PROJECT_ROOT, 'dist'),
			})
			break
		case 'development':
			break
		case 'test':
			throw new Error('test environment not supported')
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
		startRedirectPath: AR.route('/login'),

		callbackUri: `${ENV.ORIGIN}${AR.route('/login/callback')}`,
		scope: ['identify'],
	})

	instance.get(AR.route('/login/callback'), async function(req, reply) {
		const tokenResult = await (this as any).discordOauth2.getAccessTokenFromAuthorizationCodeFlow(req)
		const token = tokenResult.token as {
			access_token: string
			token_type: string
		}
		const discordUser = await Discord.getOauthUser(token)
		if (!discordUser) {
			return reply.status(401).send('Failed to get user info from Discord')
		}
		const ctx = getCtx(req)
		const denyRes = await Rbac.tryDenyPermissionsForUser(
			ctx,
			discordUser.id,
			RBAC.perm('site:authorized'),
		)
		if (denyRes) {
			switch (denyRes.code) {
				case 'err:permission-denied':
					return reply
						.status(401)
						.send(Messages.GENERAL.auth.noApplicationAccess)
				default:
					assertNever(denyRes.code)
			}
		}

		const sessionId = createId(64)
		await ctx.db().transaction(async (tx) => {
			const [user] = await tx
				.select()
				.from(Schema.users)
				.where(eq(Schema.users.discordId, discordUser.id))
				.for('update')
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

		await Sessions.setSessionCookie({ ...ctx, req, res: reply }, sessionId).redirect(AR.route('/'))
	})

	instance.post(AR.route('/logout'), async function(req, res) {
		const ctx = getCtx(req)
		const authRes = await createAuthorizedRequestContext({
			...ctx,
			req,
			res,
			span: Otel.trace.getActiveSpan(),
		})
		if (authRes.code !== 'ok') {
			return Sessions.clearInvalidSession({ ...ctx, res })
		}

		return await Sessions.logout({ ...authRes.ctx, res })
	})

	instance.get(AR.route('/layers.sqlite3'), async (req, res) => {
		const ifNoneMatch = req.headers['If-None-Match']
		res.header('ETag', `"${LayerDb.hash}"`)
		if (ifNoneMatch && ifNoneMatch === `"${LayerDb.hash}"`) {
			return res.code(304).send()
		}

		res.header('Content-Type', 'application/x-sqlite3')
		const stream = LayerDb.readFilestream()
		return res.send(stream)
	})

	await instance.register(ws)
	await instance.register(fastifyTRPCPlugin, {
		prefix: AR.route('/trpc'),
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
		res = res
			.header('Cross-Origin-Opener-Policy', 'same-origin')
			.header('Cross-Origin-Embedder-Policy', 'require-corp')
		const ctx = getCtx(req)
		const authRes = await createAuthorizedRequestContext({
			...ctx,
			req,
			span: Otel.trace.getActiveSpan(),
		})
		switch (authRes.code) {
			case 'ok':
				break
			case 'unauthorized:no-cookie':
			case 'unauthorized:no-session':
			case 'err:expired':
			case 'err:not-found':
				return await Sessions.clearInvalidSession({ ...ctx, res })
			case 'err:permission-denied':
				return res.status(401).send(Messages.GENERAL.auth.noApplicationAccess)
			default:
				assertNever(authRes)
		}

		switch (ENV.NODE_ENV) {
			case 'development': {
				// --------  dev server proxy setup --------
				// When running in dev mode, we're proxying all html routes through to fastify so we can do auth and stuff. Non-proxied routes will just return the dev index.html, So we can just get it from the dev server. convoluted, but easier than trying to deeply integrate vite into fastify like what @fastify/vite does(badly)
				const htmlRes = await fetch(`${ENV.ORIGIN}/idk`).catch(err => {
					console.error('ERROR while getting /idk')
					console.error(err)
					return err
				})
				const body = await htmlRes.text()
				return res
					.type('text/html')
					.header('Access-Control-Allow-Origin', '*')
					.header('Access-Control-Allow-Methods', '*')
					.header('Access-Control-Allow-Headers', '*')
					.header('Cross-Origin-Resource-Policy', 'cross-origin')
					.send(body)
			}
			case 'production': {
				return res.sendFile('index.html')
			}
			case 'test': {
				throw new Error('Not implemented')
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

export async function createAuthorizedRequestContext<
	T extends CS.Log & C.Db & Partial<C.SpanContext> & Pick<C.HttpRequest, 'req'>,
>(ctx: T) {
	const validSessionRes = await Sessions.validateAndUpdate(ctx)
	if (validSessionRes.code !== 'ok') {
		return validSessionRes
	}

	const authedCtx: T & C.AuthedUser = {
		...ctx,
		user: validSessionRes.user,
		sessionId: validSessionRes.sessionId,
		expiresAt: validSessionRes.expiresAt,
	}

	if (authedCtx.span) {
		authedCtx.span.setAttributes({
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
export async function createTrpcRequestContext(
	options: CreateFastifyContextOptions,
): Promise<C.TrpcRequest> {
	const result = await createAuthorizedRequestContext(
		DB.addPooledDb({ log: baseLogger, req: options.req }),
	)
	if (result.code !== 'ok') {
		switch (result.code) {
			case 'unauthorized:no-cookie':
			case 'unauthorized:no-session':
			case 'err:expired':
			case 'err:not-found':
				throw new TRPCError({ code: 'UNAUTHORIZED', message: result.code })
			case 'err:permission-denied':
				throw new TRPCError({
					code: 'UNAUTHORIZED',
					message: Messages.GENERAL.auth.noApplicationAccess,
				})
			default:
				assertNever(result)
		}
	}
	const wsClientId = createId(32)
	const ctx: C.TrpcRequest = {
		wsClientId,
		user: result.ctx.user,
		sessionId: result.ctx.sessionId,
		expiresAt: result.ctx.expiresAt,
		req: options.req,
		ws: options.res as unknown as WebSocket,
		log: result.ctx.log.child({ wsClientId }),
		db: result.ctx.db,
	}
	WsSessionSys.registerClient(ctx)
	return ctx
}
