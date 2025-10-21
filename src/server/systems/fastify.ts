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
import * as SquadServer from '@/server/systems/squad-server'
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
import * as Users from './users'

const BASE_HEADERS = {
	'Cross-Origin-Embedder-Policy': 'require-corp',
	'Cross-Origin-Opener-Policy': 'same-origin',
	'Cross-Origin-Resource-Policy': 'cross-origin',
}

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
		const route = AR.resolveRoute(request.url)
		baseLogger.debug('incoming request %s %s', request.method, request.url)
		if (route?.id === '/trpc') return

		const ctx = DB.addPooledDb({ log: instance.log as CS.Logger })

		request.log = ctx.log

		// @ts-expect-error monkey patching. we don't include the full request context to avoid circular references
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
				setHeaders: (header) => {
					for (const [key, value] of Object.entries(BASE_HEADERS)) {
						header.setHeader(key, value)
					}
				},
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
		const ctx = { ...getCtx(req), user: { discordId: discordUser.id } }
		const denyRes = await Rbac.tryDenyPermissionsForUser(ctx, RBAC.perm('site:authorized'))
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
		const expiresAt = new Date(Date.now() + Sessions.SESSION_MAX_AGE)

		await DB.runTransaction(ctx, async (ctx) => {
			const [user] = await ctx.db()
				.select()
				.from(Schema.users)
				.where(eq(Schema.users.discordId, discordUser.id))
				.for('update')
			if (!user) {
				await ctx.db().insert(Schema.users).values({
					discordId: discordUser.id,
					username: discordUser.username,
				})
			} else {
				await ctx.db()
					.update(Schema.users)
					.set({ username: discordUser.username })
					.where(eq(Schema.users.discordId, discordUser.id))
			}
			// Use the transaction-aware write-through cache for session creation
			await Sessions.createSessionTx(ctx, {
				id: sessionId,
				userId: discordUser.id,
				expiresAt,
				user: await Users.buildUser(ctx, {
					discordId: discordUser.id,
					username: discordUser.username,
					steam64Id: user?.steam64Id || null,
					nickname: null,
				}),
			})
		})
		const requestCtx = buildRequestContext(ctx, req, reply)

		await Sessions.setSessionCookie(requestCtx, sessionId).redirect(AR.route('/'))
	})

	instance.post(AR.route('/logout'), async function(req, res) {
		const ctx = buildRequestContext({ ...getCtx(req), span: Otel.trace.getActiveSpan() }, req, res)
		const authRes = await createAuthorizedRequestContext(ctx)
		if (authRes.code !== 'ok') {
			return Sessions.clearInvalidSession(ctx)
		}

		return await Sessions.logout({ ...authRes.ctx, res })
	})

	instance.get(AR.route('/layers.sqlite3'), async (req, res) => {
		for (const [key, value] of Object.entries(BASE_HEADERS)) {
			res = res.header(key, value)
		}
		const ifNoneMatch = req.headers['if-none-match']
		const etag = `"${LayerDb.hash}"`
		res.header('ETag', etag)
		if (ifNoneMatch && ifNoneMatch === etag) {
			return res.code(304).send()
		}

		res.header('Content-Type', 'application/x-sqlite3')
		const stream = LayerDb.readFilestream()
		return res.send(stream)
	})

	instance.get(AR.route('/check-auth'), async (req, res) => {
		const ctx = buildRequestContext({ ...getCtx(req), span: Otel.trace.getActiveSpan() }, req, res)
		const authRes = await createAuthorizedRequestContext(ctx)
		if (authRes.code !== 'ok') {
			return ctx.res.status(401).send({ error: 'Unauthorized' })
		}
		return res.status(200).send({ status: 'ok' })
	})

	// Discord avatar proxy endpoint to escape CORS
	instance.get(AR.route('/avatars/:discordId/:avatarId'), async (req, res) => {
		const params = req.params as { discordId: string; avatarId: string }

		// Determine the Discord URL to fetch
		let discordAvatarUrl: string
		// dumb but whatever
		if (params.avatarId.length < 5) {
			discordAvatarUrl = `https://cdn.discordapp.com/embed/avatars/${params.avatarId}.png`
		} else if (params.avatarId === 'default') {
			discordAvatarUrl = `https://cdn.discordapp.com/embed/avatars/0.png`
		} else {
			discordAvatarUrl = `https://cdn.discordapp.com/avatars/${params.discordId}/${params.avatarId}.png`
		}

		try {
			const response = await fetch(discordAvatarUrl)

			// Copy relevant headers from Discord's response
			const contentType = response.headers.get('content-type')
			const contentLength = response.headers.get('content-length')
			const cacheControl = response.headers.get('cache-control')
			const etag = response.headers.get('etag')

			if (contentType) res.header('content-type', contentType)
			if (response.ok) {
				if (contentLength) res.header('content-length', contentLength)
				if (cacheControl) res.header('cache-control', cacheControl)
				if (etag) res.header('etag', etag)
			}

			res = res.status(response.status)
			if (response.body) {
				res = res.send(new Uint8Array(await response.arrayBuffer()))
			}
			return res
		} catch (error) {
			req.log.error(error, 'Failed to proxy Discord avatar')
			return res.status(500).send({ error: 'Failed to fetch avatar' })
		}
	})

	instance.register(ws)

	instance.register(fastifyTRPCPlugin, {
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
		for (const [key, value] of Object.entries(BASE_HEADERS)) {
			res.header(key, value)
		}
		let ctx = buildRequestContext({ ...getCtx(req), span: Otel.trace.getActiveSpan() }, req, res)
		const authRes = await createAuthorizedRequestContext(ctx)
		switch (authRes.code) {
			case 'ok':
				break
			case 'unauthorized:no-cookie':
			case 'unauthorized:no-session':
			case 'unauthorized:expired':
			case 'unauthorized:not-found':
				return await Sessions.clearInvalidSession(ctx)
			case 'err:permission-denied':
				return ctx.res.status(401).send(Messages.GENERAL.auth.noApplicationAccess)
			default:
				assertNever(authRes)
		}

		ctx = SquadServer.manageDefaultServerIdForRequest(ctx)

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
				return ctx.res
					.type('text/html')
					.header('Access-Control-Allow-Origin', '*')
					.header('Access-Control-Allow-Methods', '*')
					.header('Access-Control-Allow-Headers', '*')
					.send(body)
			}
			case 'production': {
				return ctx.res.sendFile('index.html')
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
	T extends CS.Log & C.Db & Partial<C.SpanContext> & Pick<C.HttpRequest, 'req' | 'cookies'>,
>(ctx: T) {
	const validSessionRes = await Sessions.validateAndUpdate(ctx)
	if (validSessionRes.code !== 'ok') {
		return validSessionRes
	}

	const authedCtx: T & C.AuthedUser = {
		...ctx,
		// note: we actually modify this objefct in-place when linking/unlinking steam accounts in src/server/systems/users.ts
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
	const cookies = options.req.headers.cookie!
	if (!cookies) throw new TRPCError({ code: 'UNAUTHORIZED', message: 'unauthorized:no-cookie' })
	const result = await createAuthorizedRequestContext(
		DB.addPooledDb({
			log: baseLogger,
			req: options.req,
			cookies: AR.parseCookies(cookies),
		}),
	)
	if (result.code !== 'ok') {
		switch (result.code) {
			case 'unauthorized:no-cookie':
			case 'unauthorized:no-session':
			case 'unauthorized:expired':
			case 'unauthorized:not-found':
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

	if (options.req.headers.cookie) {
		// we always expect a default server id to be set and in-line with the current route when the ws connection is established to be set when the ws connection is established.
		const defaultServerId = AR.parseCookies(options.req.headers.cookie)['default-server-id']!
		SquadServer.state.selectedServers.set(wsClientId, defaultServerId)
	}
	const ctx: C.TrpcRequest = C.initLocks({
		wsClientId,
		user: result.ctx.user,
		sessionId: result.ctx.sessionId,
		expiresAt: result.ctx.expiresAt,
		req: options.req,
		ws: options.res as unknown as WebSocket,
		log: result.ctx.log.child({ wsClientId }),
		db: result.ctx.db,
	})
	WsSessionSys.registerClient(ctx)
	return ctx
}

// only works for known resolved paths
function buildRequestContext<Ctx extends object>(ctx: Ctx, req: FastifyRequest, res: FastifyReply): C.HttpRequest & Ctx {
	const route = AR.resolveRoute(req.url) ?? undefined
	const cookies = req.headers.cookie ? AR.parseCookies(req.headers.cookie) : {} as AR.Cookies
	return {
		...ctx,
		req,
		res,
		route,
		cookies,
	}
}
