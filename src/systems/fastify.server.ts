import * as Paths from '$root/paths'
import * as AR from '@/app-routes.ts'
import { createId } from '@/lib/id.ts'
import { assertNever } from '@/lib/type-guards'
import * as Messages from '@/messages'
import * as CS from '@/models/context-shared'
import { initModule } from '@/server/logger'

import * as RBAC from '@/rbac.models'
import * as C from '@/server/context.ts'
import * as DB from '@/server/db'
import * as Env from '@/server/env.ts'

import { anySignal } from '@/lib/async'
import * as ORPCServer from '@/server/orpc-handler'
import * as CleanupSys from '@/systems/cleanup.server'
import * as Discord from '@/systems/discord.server'
import * as LayerData from '@/systems/layer-data.server'
import * as LayerEngine from '@/systems/layer-engine.server'
import * as Rbac from '@/systems/rbac.server'
import * as ServerAgent from '@/systems/server-agent.server'
import * as Sessions from '@/systems/sessions.server'
import * as SquadServer from '@/systems/squad-server.server'
import * as UserPresenceSys from '@/systems/user-presence.server'
import * as WsSessionSys from '@/systems/ws-session.server'
import fastifyCookie from '@fastify/cookie'
import fastifyFormBody from '@fastify/formbody'
import oauthPlugin from '@fastify/oauth2'
import fastifyStatic from '@fastify/static'
import fastifyWebsocket from '@fastify/websocket'
import * as Otel from '@opentelemetry/api'
import type { FastifyReply, FastifyRequest } from 'fastify'
import fastify from 'fastify'
import type { WebSocket } from 'ws'

const BASE_HEADERS = {
	'Cross-Origin-Embedder-Policy': 'credentialless',
	'Cross-Origin-Opener-Policy': 'same-origin',
	'Cross-Origin-Resource-Policy': 'cross-origin',
}

const envBuilder = Env.getEnvBuilder({ ...Env.groups.general, ...Env.groups.httpServer, ...Env.groups.discord })
let ENV!: ReturnType<typeof envBuilder>
const module = initModule('fastify')
let log!: CS.Logger
let instance!: Awaited<ReturnType<typeof getFastifyBase>>

async function getFastifyBase() {
	return await fastify({
		routerOptions: {
			maxParamLength: 5000,
		},
		logger: false,
	})
}

export const setup = C.spanOp('setup', { module }, async () => {
	log = module.getLogger()
	ENV = envBuilder()
	instance = await getFastifyBase()

	// --------  logging --------
	instance.log = log
	instance.addHook('onRequestAbort', async (request) => {
		;((request as any).ctxAbort as AbortController | undefined)?.abort(new DOMException('client disconnected', 'AbortError'))
	})
	instance.addHook('onRequest', async (request) => {
		monkeyPatchContextAndLogs(request)
		let level: 'info' | 'debug' = 'info'
		if (request.method === 'GET') level = 'debug'
		log[level](`%s %s`, request.method, request.url)
	})

	// --------  static file serving --------
	switch (ENV.NODE_ENV) {
		// test serves the built frontend exactly as production does: e2e tests drive the real client,
		// and serving it from the instance itself keeps each test's app self-contained on its own port
		case 'test':
		case 'production':
			instance.register(fastifyStatic, {
				root: Paths.DIST,

				// if this is on it'll cause a duplicate route issue, but it means we can't do dynamic files at the moment
				wildcard: false,

				// don't try to server index.html, conflicting with our routes
				index: false,
				setHeaders: (header) => {
					for (const [key, value] of Object.entries(BASE_HEADERS)) {
						header.setHeader(key, value)
					}
				},
			})
			break
		case 'development':
			// the dev server serves the frontend; fastify only provides the API + websocket surface
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
		const discordUser = await Discord.getOauthUser(getPatchedCtx(req), token)
		if (!discordUser) {
			return reply.status(401).send('Failed to get user info from Discord')
		}
		const ctx = { ...getPatchedCtx(req), user: { discordId: discordUser.id } }
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

		const requestCtx = buildHttpRequestContext(req, reply)
		await Sessions.logInUser(requestCtx, discordUser)
		reply.redirect(AR.route('/'), 302)
	})

	instance.post(AR.route('/logout'), async function(req, res) {
		const ctx = getAuthedCtx(req)
		await Sessions.logout({ ...ctx, res })
	})

	instance.get(AR.route('/layers.bin'), async (req, res) => {
		for (const [key, value] of Object.entries(BASE_HEADERS)) {
			res = res.header(key, value)
		}
		await LayerEngine.ready
		const ifNoneMatch = req.headers['if-none-match']
		const etag = `"${LayerEngine.hash}"`
		res.header('ETag', etag)
		if (ifNoneMatch && ifNoneMatch === etag) {
			return res.code(304).send()
		}

		const [stream, contentType] = LayerEngine.readFilestream()
		res.header('Content-Type', contentType)
		return res.send(stream)
	})

	instance.get(AR.route('/layer-data.json'), async (req, res) => {
		for (const [key, value] of Object.entries(BASE_HEADERS)) {
			res = res.header(key, value)
		}
		const etag = `"${LayerData.hash}"`
		res.header('ETag', etag)
		res.header('Cache-Control', 'no-cache')
		if (req.headers['if-none-match'] === etag) {
			return res.code(304).send()
		}
		res.header('Content-Type', 'application/json')
		if (req.headers['accept-encoding']?.includes('gzip')) {
			res.header('Content-Encoding', 'gzip')
			return res.send(LayerData.gzipped)
		}
		return res.send(LayerData.raw)
	})

	instance.get(AR.route('/check-auth'), async (req, res) => {
		const ctx = buildHttpRequestContext(req, res)
		const authRes = await authorizeRequest(ctx, res)
		if (authRes.code !== 'ok') {
			return ctx.res.status(401).send({ error: 'Unauthorized' })
		}
		return res.status(200).send({ status: 'ok' })
	})

	const authedCtxCreatedAt = new Map<FastifyRequest['id'], number>()
	const authedCtxMap = new Map<FastifyRequest['id'], C.FastifyRequestFull & C.AuthedUser>()
	function getAuthedCtx(req: FastifyRequest) {
		const ctx = authedCtxMap.get(req.id)
		if (!ctx) {
			throw new Error('No authed context found')
		}
		return ctx
	}

	instance.addHook('preValidation', async (req, reply) => {
		const baseCtx = buildFastifyRequestContext(req)
		if (baseCtx.route?.def.authed === false) return
		const authRes = await authorizeRequest(baseCtx, reply)
		switch (authRes.code) {
			case 'ok':
				authedCtxMap.set(req.id, authRes.ctx)
				authedCtxCreatedAt.set(req.id, Date.now())
				break
			case 'unauthorized:no-cookie':
			case 'unauthorized:no-session':
			case 'unauthorized:expired':
			case 'unauthorized:not-found':
				reply = Sessions.clearInvalidSession({ ...CS.init(), res: reply })
				if (baseCtx.route?.def.handle === 'page') {
					return await reply.redirect(AR.route('/login'), 302)
				} else {
					return await reply.status(401).send(Messages.GENERAL.auth.unAuthenticated)
				}
			case 'err:permission-denied':
				return await reply.status(401).send(Messages.GENERAL.auth.noApplicationAccess)
			default:
				assertNever(authRes)
		}
	})

	instance.addHook('onResponse', async (req, res) => {
		const statusCode = res.statusCode
		if (statusCode >= 400) {
			req.log.warn('Response %d for %s %s', statusCode, req.method, req.url)
		}
		authedCtxMap.delete(req.id)
		authedCtxCreatedAt.delete(req.id)
		for (const [reqId, createdAt] of Object.entries(authedCtxCreatedAt)) {
			if (Date.now() - createdAt > 10_000) {
				authedCtxMap.delete(reqId)
				authedCtxCreatedAt.delete(reqId)
			}
		}
	})

	instance.addContentTypeParser('*', (request, payload, done) => {
		// Fully utilize oRPC feature by allowing any content type
		// And let oRPC parse the body manually by passing `undefined`
		done(null, undefined)
	})

	instance.register(fastifyWebsocket)
	instance.register(async function(instance) {
		instance.get(AR.route('/orpc'), { websocket: true }, async (connection, req) => {
			// carries the connection-level signal; orpc middleware narrows it per-call
			const ctx = createOrpcSessionBase(getAuthedCtx(req), connection)
			void ORPCServer.orpcHandler.upgrade(connection, { context: ctx })
		})
		// server agents stream a squad server's logs + proxy RCON here; token-authed, no oRPC (see server-agent.server.ts)
		instance.get(AR.route('/server-agent'), { websocket: true }, async (connection, req) => {
			ServerAgent.handleConnection(connection, req)
		})
	})

	// -------- webpage serving --------
	async function getHtmlResponse(req: FastifyRequest, res: FastifyReply) {
		for (const [key, value] of Object.entries(BASE_HEADERS)) {
			res.header(key, value)
		}
		// resolves the default-server-id cookie for this page load: sets it to the default/first available server, or
		// clears it when no server is available, so the '/' route can redirect to /servers instead of /servers/undefined
		SquadServer.manageDefaultServerIdForRequest(buildHttpRequestContext(req, res))
		switch (ENV.NODE_ENV) {
			case 'development': {
				// --------  dev server proxy setup --------
				// When running in dev mode, we're proxying all html routes through to fastify so we can do auth and stuff. Non-proxied routes will just return the dev index.html, So we can just get it from the dev server. convoluted, but easier than trying to deeply integrate vite into fastify like what @fastify/vite does(badly)
				return res
					.type('text/html')
					.header('Access-Control-Allow-Origin', '*')
					.header('Access-Control-Allow-Methods', '*')
					.header('Access-Control-Allow-Headers', '*')
					.send('')
			}
			case 'test':
			case 'production': {
				return res.sendFile('index.html')
			}
			default:
				assertNever(ENV.NODE_ENV)
		}
	}

	instance.get('/', getHtmlResponse)
	instance.get('/*', getHtmlResponse)

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

export async function authorizeRequest<
	T extends C.FastifyRequestFull,
>(ctx: T, res?: FastifyReply) {
	const validSessionRes = await Sessions.validateAndUpdate({ ...ctx, res })
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

	const span = Otel.trace.getActiveSpan()

	if (span) {
		span.setAttributes({
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

// With the websocket handler this will run once per connection.
export function createOrpcSessionBase(
	ctx: C.FastifyRequestFull & C.AuthedUser,
	websocket: WebSocket,
): C.OrpcBase {
	// reconnecting clients send the id they last held as `?prior=`, so the socket picks up its held presence
	// (activity + locks) in place with no visible break and leaves no ghost "other session"; otherwise mint a fresh id
	const priorClientId = typeof (ctx.req.query as { prior?: unknown })?.prior === 'string'
		? (ctx.req.query as { prior: string }).prior
		: undefined
	const wsClientId = UserPresenceSys.reclaimClientId(ctx.user.discordId, priorClientId) ?? createId(32)

	const wsCtx: C.OrpcBase = {
		wsClientId,
		...ctx,
		ws: websocket,
	}

	WsSessionSys.registerClient(wsCtx)
	return wsCtx
}

function buildHttpRequestContext(
	req: FastifyRequest,
	res: FastifyReply,
): C.HttpRequestFull {
	const ctx = buildFastifyRequestContext(req)
	return { ...ctx, res: res }
}

function buildFastifyRequestContext(req: FastifyRequest): C.FastifyRequestFull {
	const patchedCtx = getPatchedCtx(req)
	const cookies = req.headers.cookie ? AR.parseCookies(req.headers.cookie) : {} as AR.Cookies
	const ctx: C.FastifyRequestFull = { ...patchedCtx, req, cookies }
	return ctx
}

function monkeyPatchContextAndLogs(request: FastifyRequest) {
	const route = AR.resolveRoute(request.url)
	// aborts if the client disconnects prematurely (see the onRequestAbort hook) or the process shuts down
	const abort = new AbortController()
	const signal = anySignal(CleanupSys.shutdownSignal, abort.signal)!
	const ctx: C.AttachedFastify = DB.addPooledDb({ ...CS.init(), route: route ?? undefined, signal })
	// @ts-expect-error monkey patching. we don't include the full request context to avoid circular references
	request.ctx = ctx
	// @ts-expect-error monkey patching
	request.ctxAbort = abort
}

function getPatchedCtx(req: FastifyRequest): C.AttachedFastify {
	const ctx = (req as any).ctx as C.AttachedFastify
	return ctx
}
