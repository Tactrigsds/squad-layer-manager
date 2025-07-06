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
import Cookie from 'cookie'
import * as DateFns from 'date-fns'
import { eq } from 'drizzle-orm'

export const SESSION_MAX_AGE = 1000 * 60 * 60 * 24 * 7
const COOKIE_DEFAULTS = { path: '/', httpOnly: true }
const tracer = Otel.trace.getTracer('sessions')

export async function setup() {
	// --------  cleanup old sessions  --------
	const ctx = DB.addPooledDb({ log: baseLogger })
	while (true) {
		await sleep(1000 * 60 * 60)
		tracer.startActiveSpan('sessions:cleanup', async (span) => {
			await ctx.db().transaction(async (tx) => {
				const sessions = await tx.select().from(Schema.sessions)
				for (const session of sessions) {
					if (new Date() > session.expiresAt) {
						await tx.delete(Schema.sessions).where(eq(Schema.sessions.id, session.id))
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
	async (ctx: CS.Log & C.Db & Pick<C.HttpRequest, 'req'>, allowRefresh = false) => {
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
		return await DB.runTransaction(ctx, async ctx => {
			const [row] = await ctx
				.db({ redactParams: true })
				.select({ session: Schema.sessions, user: Schema.users })
				.from(Schema.sessions)
				.where(eq(Schema.sessions.id, sessionId))
				.innerJoin(Schema.users, eq(Schema.users.discordId, Schema.sessions.userId))
				.for('update')
			if (!row) return { code: 'err:not-found' as const }
			const currentTime = new Date()
			if (currentTime > row.session.expiresAt) {
				return { code: 'err:expired' as const }
			}
			const denyRes = await Rbac.tryDenyPermissionsForUser(ctx, row.user.discordId, RBAC.perm('site:authorized'))
			if (denyRes) return denyRes
			let expiresAt = row.session.expiresAt
			if (allowRefresh && row.session.expiresAt.getTime() - currentTime.getTime() < Math.floor(SESSION_MAX_AGE / 4)) {
				expiresAt = new Date(DateFns.getTime(currentTime) + SESSION_MAX_AGE)
				await ctx.db({ redactParams: true }).update(Schema.sessions).set({ expiresAt })
			}
			return { code: 'ok' as const, sessionId, expiresAt, user: row.user }
		})
	},
)

export const logout = C.spanOp('sessions:logout', { tracer }, async (ctx: { sessionId: string } & Pick<C.HttpRequest, 'res'> & C.Db) => {
	await ctx.db().delete(Schema.sessions).where(eq(Schema.sessions.id, ctx.sessionId))
	C.setSpanStatus(Otel.SpanStatusCode.OK)
	return clearInvalidSession(ctx)
})

export function setSessionCookie(ctx: C.HttpRequest, sessionId: string, expiresAt?: number) {
	let expireArg: { maxAge?: number; expiresAt?: number }
	if (expiresAt !== undefined) expireArg = { expiresAt }
	else expireArg = { maxAge: SESSION_MAX_AGE }
	return ctx.res.cookie('sessionId', sessionId, { ...COOKIE_DEFAULTS, ...expireArg })
}

export function clearInvalidSession(ctx: Pick<C.HttpRequest, 'res'>) {
	return ctx.res.cookie('sessionId', '', { ...COOKIE_DEFAULTS, maxAge: 0 }).redirect(AR.route('/login'))
}

export const getUser = C.spanOp(
	'sessions:get-user',
	{ tracer },
	async (opts: { lock?: boolean }, ctx: C.AuthedUser & C.HttpRequest & C.Db) => {
		C.setSpanOpAttrs({ lock: opts.lock })
		opts.lock ??= false
		const q = ctx
			.db({ redactParams: true })
			.select({ user: Schema.users })
			.from(Schema.sessions)
			.where(eq(Schema.sessions.id, ctx.sessionId))
			.leftJoin(Schema.users, eq(Schema.users.discordId, Schema.sessions.userId))

		const [row] = opts.lock ? await q.for('update') : await q

		C.setSpanStatus(Otel.SpanStatusCode.OK)
		return row!.user!
	},
)
