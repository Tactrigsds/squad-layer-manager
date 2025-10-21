import * as Schema from '$root/drizzle/schema.ts'
import * as AR from '@/app-routes'
import { sleep } from '@/lib/async'
import * as CS from '@/models/context-shared'
import * as RBAC from '@/rbac.models'
import * as C from '@/server/context'
import * as DB from '@/server/db.ts'
import { baseLogger } from '@/server/logger'
import * as Rbac from '@/server/systems/rbac.system'
import * as Otel from '@opentelemetry/api'
import * as DateFns from 'date-fns'
import * as E from 'drizzle-orm/expressions'

export const SESSION_MAX_AGE = 1000 * 60 * 60 * 24 * 7
const COOKIE_DEFAULTS = { path: '/', httpOnly: true }
const tracer = Otel.trace.getTracer('sessions')

// In-memory cache for sessions
type CachedSession = {
	id: string
	userId: bigint
	expiresAt: Date
	user: typeof Schema.users.$inferSelect
}

const sessionCache = new Map<string, CachedSession>()

// Load all valid sessions into cache on startup
async function loadValidSessionsIntoCache(ctx: C.Db & CS.Log) {
	ctx.log.info('Loading valid sessions into cache...')
	const currentTime = new Date()

	const sessions = await ctx
		.db({ redactParams: true })
		.select({ session: Schema.sessions, user: Schema.users })
		.from(Schema.sessions)
		.where(E.gt(Schema.sessions.expiresAt, currentTime))
		.innerJoin(Schema.users, E.eq(Schema.users.discordId, Schema.sessions.userId))

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

	ctx.log.info(`Loaded ${validCount} valid sessions into cache`)
}

// Helper to update session in both cache and database
async function updateSessionInCacheAndDb(
	ctx: C.Db,
	sessionId: string,
	updates: Partial<Pick<CachedSession, 'expiresAt'>>,
) {
	// Update database first
	await ctx.db({ redactParams: true }).update(Schema.sessions).set(updates).where(E.eq(Schema.sessions.id, sessionId))

	// Update cache
	const cached = sessionCache.get(sessionId)
	if (cached) {
		Object.assign(cached, updates)
	}
}

// Helper to remove session from both cache and database
async function removeSessionFromCacheAndDb(ctx: C.Db, sessionId: string) {
	// Remove from database first
	await ctx.db().delete(Schema.sessions).where(E.eq(Schema.sessions.id, sessionId))

	// Remove from cache
	sessionCache.delete(sessionId)
}

// Helper to add session to both cache and database
async function addSessionToCacheAndDb(ctx: C.Db, session: CachedSession) {
	// Add to database first
	await ctx.db().insert(Schema.sessions).values({
		id: session.id,
		userId: session.userId,
		expiresAt: session.expiresAt,
	})

	// Add to cache
	sessionCache.set(session.id, session)
}

// Transaction-aware version for adding session to cache and database
async function createSessionTx(ctx: C.Db & C.Tx, session: CachedSession) {
	// Add to database first within transaction
	await ctx.db().insert(Schema.sessions).values({
		id: session.id,
		userId: session.userId,
		expiresAt: session.expiresAt,
	})

	// Add to cache (safe to do immediately since we're in a transaction)
	sessionCache.set(session.id, session)
}

export async function setup() {
	// --------  load valid sessions into cache  --------
	const ctx = DB.addPooledDb({ log: baseLogger })
	await loadValidSessionsIntoCache(ctx)

	// --------  cleanup old sessions  --------
	while (true) {
		await sleep(1000 * 60 * 60)
		tracer.startActiveSpan('sessions:cleanup', async (span) => {
			const currentTime = new Date()

			await ctx.db().transaction(async (tx) => {
				// Delete all expired sessions from database
				await tx.delete(Schema.sessions).where(E.lt(Schema.sessions.expiresAt, currentTime))

				// Remove expired sessions from cache
				for (const [sessionId, session] of sessionCache.entries()) {
					if (currentTime > session.expiresAt) {
						sessionCache.delete(sessionId)
					}
				}
			})

			span.setStatus({ code: Otel.SpanStatusCode.OK })
			span.end()
		})
	}
}

export const validateAndUpdate = C.spanOp(
	'sessions:validate-and-update',
	{ tracer },
	async (ctx: CS.Log & C.Db & Pick<C.HttpRequest, 'req' | 'cookies'>, allowRefresh = false) => {
		const cookie = ctx.req.headers.cookie
		if (!cookie) {
			return {
				code: 'unauthorized:no-cookie' as const,
				message: 'No cookie provided',
			}
		}
		const sessionId = ctx.cookies['session-id']
		if (!sessionId) {
			return {
				code: 'unauthorized:no-session' as const,
				message: 'No session provided',
			}
		}

		// Check cache first
		const cachedSession = sessionCache.get(sessionId)

		if (!cachedSession) {
			return { code: 'unauthorized:not-found' as const }
		}

		const currentTime = new Date()
		if (currentTime > cachedSession.expiresAt) {
			// Remove expired session from cache and database
			await removeSessionFromCacheAndDb(ctx, sessionId)
			return { code: 'unauthorized:expired' as const }
		}

		const discordId = cachedSession.user.discordId
		const denyRes = await Rbac.tryDenyPermissionsForUser({ ...ctx, user: { discordId } }, RBAC.perm('site:authorized'))
		if (denyRes) return denyRes

		let expiresAt = cachedSession.expiresAt
		if (allowRefresh && cachedSession.expiresAt.getTime() - currentTime.getTime() < Math.floor(SESSION_MAX_AGE / 4)) {
			expiresAt = new Date(DateFns.getTime(currentTime) + SESSION_MAX_AGE)
			await updateSessionInCacheAndDb(ctx, sessionId, { expiresAt })
		}

		return { code: 'ok' as const, sessionId, expiresAt, user: cachedSession.user }
	},
)

export const logout = C.spanOp('sessions:logout', { tracer }, async (ctx: { sessionId: string } & Pick<C.HttpRequest, 'res'> & C.Db) => {
	await removeSessionFromCacheAndDb(ctx, ctx.sessionId)
	C.setSpanStatus(Otel.SpanStatusCode.OK)
	return clearInvalidSession(ctx)
})

export function setSessionCookie(ctx: C.HttpRequest, sessionId: string, expiresAt?: number) {
	let expireArg: { maxAge?: number; expiresAt?: number }
	if (expiresAt !== undefined) expireArg = { expiresAt }
	else expireArg = { maxAge: SESSION_MAX_AGE }
	return ctx.res.cookie(AR.COOKIE_KEY.Values['session-id'], sessionId, { ...COOKIE_DEFAULTS, ...expireArg })
}

export function clearInvalidSession(ctx: Pick<C.HttpRequest, 'res'>) {
	return ctx.res.cookie(AR.COOKIE_KEY.Values['session-id'], '', { ...COOKIE_DEFAULTS, maxAge: 0 }).redirect(AR.route('/login'))
}

export const getUser = C.spanOp(
	'sessions:get-user',
	{ tracer, attrs: ({ lock }) => ({ lock }) },
	async (opts: { lock?: boolean }, ctx: C.AuthedUser & C.HttpRequest & C.Db) => {
		opts.lock ??= false

		// Check cache first
		const cachedSession = sessionCache.get(ctx.sessionId)
		if (cachedSession) {
			return cachedSession.user
		}

		// Fallback to database (cache miss - this shouldn't happen often)
		ctx.log?.warn('Session cache miss in getUser, falling back to database', { sessionId: ctx.sessionId })
		const q = ctx
			.db({ redactParams: true })
			.select({ user: Schema.users })
			.from(Schema.sessions)
			.where(E.eq(Schema.sessions.id, ctx.sessionId))
			.leftJoin(Schema.users, E.eq(Schema.users.discordId, Schema.sessions.userId))

		const [row] = opts.lock ? await q.for('update') : await q

		if (row?.user) {
			// Add back to cache if found
			const session = await ctx
				.db({ redactParams: true })
				.select()
				.from(Schema.sessions)
				.where(E.eq(Schema.sessions.id, ctx.sessionId))
				.then(rows => rows[0])

			if (session) {
				sessionCache.set(ctx.sessionId, {
					id: session.id,
					userId: session.userId,
					expiresAt: session.expiresAt,
					user: row.user,
				})
			}
		}

		return row!.user!
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

// Export cache for other systems that might need to create sessions
export { addSessionToCacheAndDb as createSession, createSessionTx, sessionCache }
