import * as AR from '@/appRoutes.ts'
import { createId } from '@/lib/id.ts'
import fastifyCookie from '@fastify/cookie'
import oauthPlugin from '@fastify/oauth2'
import fastifyStatic from '@fastify/static'
import ws from '@fastify/websocket'
import { FastifyTRPCPluginOptions, fastifyTRPCPlugin } from '@trpc/server/adapters/fastify'
import { eq } from 'drizzle-orm'
import fastify from 'fastify'
import fastifySocketIo from 'fastify-socket.io'
import path from 'node:path'
import { Server } from 'socket.io'

import { createContext } from './context.ts'
import * as DB from './db'
import { ENV, setupEnv } from './env.ts'
import { Logger, baseLogger, setupLogger } from './logger.ts'
import * as TrpcRouter from './router'
import * as Schema from './schema.ts'
import * as Discord from './systems/discord.ts'
import { setupLayerQueue } from './systems/layer-queue.ts'
import * as Sessions from './systems/sessions.ts'

const PROJECT_ROOT = path.join(path.dirname(import.meta.dirname), '../../dist')

// --------  system initialization --------
setupEnv()
await setupLogger()
DB.setupDatabase()
setupLayerQueue()
Sessions.setupSessions()

// --------  server configuration --------
const server = fastify({
	maxParamLength: 5000,
	loggerInstance: baseLogger,
})

server.register(fastifyStatic, {
	root: path.join(PROJECT_ROOT, 'dist'),
	setHeaders: (res) => {
		res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
		res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp')
	},
})

server.register(fastifyCookie)
server.register(oauthPlugin, {
	name: 'discordOauth2',
	credentials: {
		client: {
			id: ENV.DISCORD_CLIENT_ID,
			secret: ENV.DISCORD_CLIENT_SECRET,
		},
		auth: oauthPlugin.DISCORD_CONFIGURATION,
	},
	startRedirectPath: AR.exists('/login'),
	callbackUri: `${ENV.ORIGIN}/${AR.exists('/login/callback')}`,
	scope: ['identify'],
})

server.get(AR.exists('/login/callback'), async function (req, reply) {
	//@ts-expect-error lame
	const tokenResult = await this.discordOauth2.getAccessTokenFromAuthorizationCodeFlow(req)
	const token = tokenResult.token as { access_token: string; token_type: string }
	const discordUser = await Discord.getUser(token)
	if (!discordUser) return reply.status(401).send('Failed to get user info from Discord')
	const db = DB.get({ log: req.log })

	const sessionId = createId(64)
	await db.transaction(async (db) => {
		const [user] = await db.select().from(Schema.users).where(eq(Schema.users.discordId, discordUser.id))
		if (!user) {
			await db.insert(Schema.users).values({ discordId: discordUser.id, username: discordUser.username, avatar: discordUser.avatar })
		} else {
			await db.update(Schema.users).set({ username: discordUser.username }).where(eq(Schema.users.discordId, user.discordId))
		}
		await db
			.insert(Schema.sessions)
			.values({ id: sessionId, userId: discordUser.id, expiresAt: new Date(Date.now() + Sessions.SESSION_MAX_AGE) })
	})
	reply.cookie('sessionId', sessionId, { path: '/', maxAge: Sessions.SESSION_MAX_AGE, httpOnly: true }).redirect('/')
})

async function logout(reply: any, ctx: { db: DB.Db; sessionId: string }) {
	await ctx.db.delete(Schema.sessions).where(eq(Schema.sessions.id, ctx.sessionId))
	reply.cookie('sessionId', '', { path: '/', maxAge: 0 }).redirect('/')
	reply.redirect(AR.exists('/login'))
}

server.register(ws)
server.register(fastifySocketIo)

server.register(fastifyTRPCPlugin, {
	prefix: AR.exists('/trpc'),
	useWSS: true,
	keepAlive: {
		enabled: true,
		pingMs: 30_000,
		pongWaitMs: 5000,
	},
	trpcOptions: {
		router: TrpcRouter.appRouter,
		createContext: createContext,
		onError({ path, error }) {
			server.log.error(error, `Error in tRPC handler on path '${path}':`)
		},
	} satisfies FastifyTRPCPluginOptions<TrpcRouter.AppRouter>['trpcOptions'],
})

async function getHtmlResponse(req: any, reply: any) {
	reply = reply.header('Cross-Origin-Opener-Policy', 'same-origin').header('Cross-Origin-Embedder-Policy', 'require-corp')
	const sessionId = req.cookies.sessionId
	function logout() {
		reply.cookie('sessionId', '')
		return reply.redirect(AR.exists('/logout'))
	}
	if (typeof sessionId !== 'string') return logout()

	const db = DB.get({ log: req.log })
	const valid = await Sessions.validateSession(sessionId, { db, log: req.log as Logger })
	if (!valid) return logout()

	// --------  dev server proxy setup --------
	// when running in dev mode, we're proxying all public routes through to fastify so we an do auth and stuff. non-proxied routes will just return the dev index.html, so we can just get it from the dev server. convoluted, but easier than trying to deeply integrate vite into fastify like what @fastify/vite does(badly)
	if (ENV.NODE_ENV === 'development') {
		const res = await fetch(`${ENV.ORIGIN}/idk`)
		return reply.type('text/html').send(res.body)
	}
	return reply.sendFile('index.html')
}

for (const route of AR.routes) {
	if (route.handle !== 'page') continue
	server.get(route.server, getHtmlResponse)
}

// --------  start server  --------
try {
	const port = 3000
	await server.listen({ port })
	server.log.info('listening on port ', port)
} catch (err) {
	server.log.error(err)
	process.exit(1)
}

declare module 'fastify' {
	interface FastifyInstance {
		io: Server<{ hello: any }>
	}
}
