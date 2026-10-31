import * as Otel from '@opentelemetry/api'
import * as E from 'drizzle-orm'
import * as Crypto from 'node:crypto'

import * as Schema from '$root/drizzle/schema.ts'
import * as AR from '@/app-routes'
import { createId } from '@/lib/id'
import * as Prom from '@/lib/promise-utils'
import * as Rx from '@/lib/rxjs'
import * as CS from '@/models/context-shared.models'
import * as ATTRS from '@/models/otel-attrs.models'
import * as RBAC from '@/rbac.models'
import type * as C from '@/server/context'
import * as DB from '@/server/db.ts'
import * as Env from '@/server/env'
import * as Instr from '@/server/instrumentation'
import { initModule } from '@/server/logger'
import * as Sql from '@/server/sql'
import * as CleanupSys from '@/systems/cleanup.server'
import * as Rbac from '@/systems/rbac.server'
import * as Users from '@/systems/users.server'
import * as WsSessionSys from '@/systems/ws-session.server'

export const SESSION_MAX_AGE = 1000 * 60 * 60 * 24 * 7
// extending writes to the db, so a session is extended at most once a day
export const SESSION_REFRESH_WITHIN = SESSION_MAX_AGE - 1000 * 60 * 60 * 24

const module = initModule('sessions')
const SQL = Sql.forModule(module)
let log!: CS.Logger

const buildEnv = Env.getEnvBuilder({ ...Env.groups.general, ...Env.groups.httpServer })

let ENV!: ReturnType<typeof buildEnv>

namespace Q {
	const nowP = SQL.params({ now: Schema.sessions.expiresAt })
	export const validSessions = SQL.def(
		'validSessions',
		nowP,
		SQL.select({ session: Schema.sessions, user: Users.userColumns })
			.from(Schema.sessions)
			.where(E.gt(Schema.sessions.expiresAt, nowP.now))
			.innerJoin(Schema.users, E.eq(Schema.users.discordId, Schema.sessions.userId))
			.innerJoin(Schema.discordAccounts, E.eq(Schema.discordAccounts.discordId, Schema.users.discordId)),
	)
	export const deleteExpiredSessions = SQL.def(
		'deleteExpiredSessions',
		nowP,
		SQL.delete(Schema.sessions).where(E.lt(Schema.sessions.expiresAt, nowP.now)),
	)
	const sessionIdP = SQL.params({ id: Schema.sessions.id })
	export const sessionWithUser = SQL.def(
		'sessionWithUser',
		sessionIdP,
		SQL.select({ session: Schema.sessions, user: Users.userColumns })
			.from(Schema.sessions)
			.where(E.eq(Schema.sessions.id, sessionIdP.id))
			.innerJoin(Schema.users, E.eq(Schema.users.discordId, Schema.sessions.userId))
			.innerJoin(Schema.discordAccounts, E.eq(Schema.discordAccounts.discordId, Schema.users.discordId)),
	)
	export const deleteSession = SQL.def(
		'deleteSession',
		sessionIdP,
		SQL.delete(Schema.sessions).where(E.eq(Schema.sessions.id, sessionIdP.id)),
	)
	const extendP = SQL.params({ id: Schema.sessions.id, expiresAt: Schema.sessions.expiresAt })
	export const extendSession = SQL.def(
		'extendSession',
		extendP,
		SQL.update(Schema.sessions).set({ expiresAt: extendP.expiresAt }).where(E.eq(Schema.sessions.id, extendP.id)),
	)
	const sessionP = SQL.params({ id: Schema.sessions.id, userId: Schema.sessions.userId, expiresAt: Schema.sessions.expiresAt })
	export const insertSession = SQL.def('insertSession', sessionP, SQL.insert(Schema.sessions).values(sessionP))
	const userIdP = SQL.params({ discordId: Schema.users.discordId })
	export const ensureUser = SQL.def('ensureUser', userIdP, SQL.insert(Schema.users).values(userIdP).onConflictDoNothing())
	const usernameP = SQL.params({ username: Schema.discordAccounts.username })
	export const userByUsername = SQL.def(
		'userByUsername',
		usernameP,
		SQL.select(Users.userColumns)
			.from(Schema.users)
			.innerJoin(Schema.discordAccounts, E.eq(Schema.discordAccounts.discordId, Schema.users.discordId))
			.where(E.eq(Schema.discordAccounts.username, usernameP.username)),
		// only the development and test login bypass looks a user up by name
		{ scans: ['discordAccounts'] },
	)
	const lowerNameP = SQL.params({ name: SQL.value<string>() })
	export const accountsByLowerName = SQL.def(
		'accountsByLowerName',
		lowerNameP,
		SQL.select({ discordId: Schema.discordAccounts.discordId, username: Schema.discordAccounts.username })
			.from(Schema.discordAccounts)
			.where(E.eq(E.sql`lower(${Schema.discordAccounts.username})`, lowerNameP.name))
			.orderBy(Schema.discordAccounts.discordId),
		// only the no-auth login looks an account up by name
		{ scans: ['discordAccounts'] },
	)
}

// In-memory cache for sessions
type CachedSession = {
	id: string
	userId: bigint
	expiresAt: Date
	user: Users.DbUser
}

const sessionCache = new Map<string, CachedSession>()

// Load all valid sessions into cache on startup
function loadValidSessionsIntoCache(ctx: C.Db) {
	log.info('Loading valid sessions into cache...')
	const sessions = DB.all(ctx, Q.validSessions({ now: new Date() }))

	let validCount = 0
	for (const row of sessions) {
		sessionCache.set(row.session.id, {
			id: row.session.id,
			userId: row.session.userId,
			expiresAt: row.session.expiresAt,
			user: row.user,
		})
		validCount++
	}

	log.info(`Loaded ${validCount} valid sessions into cache`)
}

function extendSessionInCacheAndDb(ctx: C.Db, sessionId: string, expiresAt: Date) {
	DB.run(ctx, Q.extendSession({ id: sessionId, expiresAt }))
	DB.afterCommit(ctx, () => {
		const cached = sessionCache.get(sessionId)
		if (cached) cached.expiresAt = expiresAt
	})
}

function removeSessionFromCacheAndDb(ctx: C.Db, sessionId: string) {
	DB.run(ctx, Q.deleteSession({ id: sessionId }))
	DB.afterCommit(ctx, () => sessionCache.delete(sessionId))
}

function addSessionToCacheAndDb(ctx: C.Db, session: CachedSession) {
	DB.run(ctx, Q.insertSession({ id: session.id, userId: session.userId, expiresAt: session.expiresAt }))
	DB.afterCommit(ctx, () => sessionCache.set(session.id, session))
}

export async function setup() {
	log = module.getLogger()
	ENV = buildEnv()

	// --------  load valid sessions into cache  --------
	const ctx = DB.withDb({ ...CS.init(), signal: CleanupSys.shutdownSignal })
	loadValidSessionsIntoCache(ctx)

	const sweepSub = Rx.merge(Rx.interval(SOCKET_SWEEP_INTERVAL), Rbac.invalidation$)
		.pipe(Instr.durableSub('close-ended-sockets', { module, root: true, taskScheduling: 'exhaust' }, () => closeEndedSockets(ctx)))
		.subscribe()
	CleanupSys.register(() => sweepSub.unsubscribe())

	// --------  cleanup old sessions  --------
	while (!ctx.signal.aborted) {
		try {
			await Prom.sleep(1000 * 60 * 60, ctx.signal)
		} catch {
			break
		}
		module.tracer.startActiveSpan('sessions:cleanup', (span) => {
			const currentTime = new Date()
			DB.run(ctx, Q.deleteExpiredSessions({ now: currentTime }))
			for (const [sessionId, session] of sessionCache.entries()) {
				if (currentTime > session.expiresAt) {
					sessionCache.delete(sessionId)
				}
			}

			span.setStatus({ code: Otel.SpanStatusCode.OK })
			span.end()
		})
	}
}

// A socket is authorized once, at its upgrade, and keeps that ctx for its lifetime. These close the sockets whose
// session has since ended, by logout or expiry, or whose user has lost site access.
const SOCKET_SWEEP_INTERVAL = 60_000
async function closeEndedSockets(ctx: C.Db & CS.AbortSignal) {
	const now = new Date()
	const siteAccess = new Map<bigint, Promise<boolean>>()
	for (const socket of [...WsSessionSys.wsSessions.values()]) {
		const session = sessionCache.get(socket.sessionId)
		let ended = !session || now > session.expiresAt
		if (!ended) {
			const discordId = socket.user.discordId
			let allowed = siteAccess.get(discordId)
			if (!allowed) {
				allowed = Rbac.tryDenyPermissionsForUser({ ...ctx, user: { discordId } }, RBAC.perm('site:authorized')).then((d) => !d)
				siteAccess.set(discordId, allowed)
			}
			ended = !(await allowed)
		}
		if (ended) await WsSessionSys.forceDisconnect({ wsSessionId: socket.wsClientId })
	}
}

export const validateAndUpdate = Instr.spanOp(
	'validateAndUpdate',
	{ module, levels: { event: 'trace' } },
	async (ctx: C.Db & C.FastifyRequestFull & Partial<C.FastifyReply>) => {
		async function errorOrBypass<Res>(res: Res) {
			if (ENV.QUERY_PARAM_AUTH_BYPASS && !!ctx.res) {
				// nb: don't shadow `res` with ctx.res here: returning the FastifyReply where the error
				// result is expected makes callers `await` fastify's thenable reply, which deadlocks
				const reply = ctx.res
				const query = ctx.req.query as Record<string, string>
				if (!query.login) return res
				const username = query['login']
				log.info('bypassing with username %s', username)
				const user = DB.get(ctx, Q.userByUsername({ username }))
				// falling through leaves the caller on the login portal, which is where an unknown name belongs:
				// the portal creates the user, `?login=` only ever picks an existing one
				if (!user) {
					log.warn('no user named %s to bypass as', username)
					return res
				}
				log.info('resolved user: %o', user)
				const loginRes = await logInUser({ ...ctx, res: reply }, { username, id: user.discordId })

				return { code: 'ok' as const, ...loginRes, user: await Users.buildUser(user) }
			}
			return res
		}

		const cookie = ctx.req.headers.cookie
		if (!cookie) {
			return await errorOrBypass({
				code: 'unauthorized:no-cookie' as const,
				message: 'No cookie provided',
			})
		}
		const token = ctx.cookies['session-id']
		if (!token) {
			return await errorOrBypass({
				code: 'unauthorized:no-session' as const,
				message: 'No session provided',
			})
		}
		const sessionId = sessionIdOf(token)

		// Check cache first
		const cachedSession = sessionCache.get(sessionId)

		if (!cachedSession) {
			return await errorOrBypass({ code: 'unauthorized:not-found' as const })
		}

		const currentTime = new Date()
		if (currentTime > cachedSession.expiresAt) {
			removeSessionFromCacheAndDb(ctx, sessionId)
			return await errorOrBypass({ code: 'unauthorized:expired' as const })
		}

		const discordId = cachedSession.user.discordId
		const denyRes = await Rbac.tryDenyPermissionsForUser({ ...ctx, user: { discordId } }, RBAC.perm('site:authorized'))
		if (denyRes) return denyRes

		// The cookie has to be reissued along with the row, or the browser drops it at its original expiry. A websocket
		// upgrade never sends the reply's headers, so only a plain http response can extend the session.
		let expiresAt = cachedSession.expiresAt
		const res = ctx.req.headers.upgrade === undefined ? ctx.res : undefined
		if (res && expiresAt.getTime() - currentTime.getTime() < SESSION_REFRESH_WITHIN) {
			expiresAt = new Date(currentTime.getTime() + SESSION_MAX_AGE)
			extendSessionInCacheAndDb(ctx, sessionId, expiresAt)
			setSessionCookie({ ...ctx, res }, token)
		}

		return { code: 'ok' as const, sessionId, expiresAt, user: await Users.buildUser(cachedSession.user) }
	},
)

// No-auth mode has no identity provider, so the name someone types is the whole identity and their user id is
// derived from it: the same name is the same person across restarts, without a registry to keep. The high bit
// keeps these clear of real discord snowflakes, which are timestamps and so far smaller.
export function noAuthUserId(username: string): bigint {
	const digest = Crypto.createHash('sha256').update(username.toLowerCase()).digest()
	return (digest.readBigUInt64BE(0) >> 2n) | (1n << 61n)
}

// The name typed is the whole identity, so it has to resolve to the account already carrying it rather than mint a
// second one beside it: a derived id never matches the real snowflake a seeded account has, and `?login=` looks
// accounts up by name and cannot choose between two of them.
export async function logInWithoutAuth(ctx: C.Db & C.FastifyRequest & C.FastifyReply, username: string) {
	const existing = DB.all(ctx, Q.accountsByLowerName({ name: username.toLowerCase() }))

	if (existing.length > 1) {
		log.warn('%d accounts are named %s; signing in as the first', existing.length, username)
	}
	if (existing[0]) {
		log.info('logging in %s without authentication, as the account already holding that name', username)
		return await logInUser(ctx, { username: existing[0].username, id: existing[0].discordId })
	}

	log.info('logging in %s without authentication', username)
	return await logInUser(ctx, { username, id: noAuthUserId(username) })
}

// A session is stored under the sha256 of the token its cookie carries, so a copy of the database or a backup holds no
// usable login. The digest is the session's id everywhere past the cookie.
export function sessionIdOf(token: string): string {
	return Crypto.createHash('sha256').update(token).digest('hex')
}

export async function logInUser(ctx: C.Db & C.FastifyRequest & C.FastifyReply, discordUser: { username: string; id: bigint }) {
	const token = createId(64)
	const sessionId = sessionIdOf(token)
	const expiresAt = new Date(Date.now() + SESSION_MAX_AGE)

	// resolved before the transaction, which may not await: it fetches the discord member over the network
	const builtUser = await Users.buildUser({
		discordId: discordUser.id,
		username: discordUser.username,
		nickname: null,
	})

	DB.transaction(ctx, {}, (ctx) => {
		// the account carries the username and must exist first: the user row references it
		Users.recordDiscordAccount(ctx, discordUser.id, discordUser.username)
		DB.run(ctx, Q.ensureUser({ discordId: discordUser.id }))
		addSessionToCacheAndDb(ctx, { id: sessionId, userId: discordUser.id, expiresAt, user: builtUser })
	})
	setSessionCookie(ctx, token)
	return { sessionId, expiresAt, res: ctx.res }
}

export const logout = Instr.spanOp('logout', { module }, async (ctx: { sessionId: string } & C.FastifyReply & C.Db) => {
	removeSessionFromCacheAndDb(ctx, ctx.sessionId)
	await WsSessionSys.forceDisconnect({ authSessionId: ctx.sessionId })
	Instr.setSpanStatus(Otel.SpanStatusCode.OK)
	// not awaited: clearInvalidSession returns the FastifyReply (for chaining), and a reply is a thenable that only
	// settles once the response is sent. Awaiting it here deadlocks POST /logout -- the handler blocks waiting for a
	// send that can't happen until it returns. Same trap as the errorOrBypass note above.
	clearInvalidSession(ctx)
})

export function setSessionCookie(ctx: C.FastifyReply, token: string) {
	ctx.res.cookie(AR.COOKIE_KEY.enum['session-id'], token, { ...sessionCookieDefaults(), maxAge: SESSION_MAX_AGE / 1000 })
}

export function clearInvalidSession(ctx: C.FastifyReply) {
	return ctx.res.cookie(AR.COOKIE_KEY.enum['session-id'], '', { ...sessionCookieDefaults(), maxAge: 0 })
}

function sessionCookieDefaults() {
	return { ...AR.COOKIE_DEFAULTS, secure: ENV.ORIGIN.startsWith('https:') }
}

export const getUser = Instr.spanOp(
	'getUser',
	{ module, levels: { event: 'trace' }, attrs: ({ lock }) => ({ [ATTRS.Session.LOCK]: lock ?? false }) },
	async (opts: { lock?: boolean }, ctx: C.AuthedUser & C.HttpRequest & C.Db) => {
		opts.lock ??= false

		// Check cache first
		const cachedSession = sessionCache.get(ctx.sessionId)
		if (cachedSession) {
			return cachedSession.user
		}

		// Fallback to database (cache miss - this shouldn't happen often)
		log.warn({ sessionId: ctx.sessionId }, 'Session cache miss in getUser, falling back to database')
		const row = DB.get(ctx, Q.sessionWithUser({ id: ctx.sessionId }))
		if (row) {
			sessionCache.set(ctx.sessionId, {
				id: row.session.id,
				userId: row.session.userId,
				expiresAt: row.session.expiresAt,
				user: row.user,
			})
		}

		return row!.user
	},
)

// Cache statistics and debugging helpers
export function getCacheStats() {
	return {
		size: sessionCache.size,
		sessions: Array.from(sessionCache.keys()),
	}
}

export function getCachedSession(sessionId: string) {
	return sessionCache.get(sessionId)
}

export function clearCache() {
	sessionCache.clear()
}

export { addSessionToCacheAndDb as createSession, sessionCache }
