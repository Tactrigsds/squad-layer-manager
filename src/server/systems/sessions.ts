import * as Schema from '$root/drizzle/schema.ts'
import * as AR from '@/app-routes'
import { sleep } from '@/lib/async'
import * as RBAC from '@/rbac.models'
import * as C from '@/server/context'
import * as DB from '@/server/db.ts'
import { baseLogger } from '@/server/logger'
import * as Rbac from '@/server/systems/rbac.system'
import * as Otel from '@opentelemetry/api'
import * as DateFns from 'date-fns'
import { eq } from 'drizzle-orm'

export const SESSION_MAX_AGE = 1000 * 60 * 24 * 7
const tracer = Otel.trace.getTracer('sessions')

export async function setupSessions() {
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

export const validateAndUpdate = C.spanOp('sessions:validate-and-update', { tracer }, async (sessionId: string, ctx: C.Log & C.Db) => {
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
			await ctx.db().delete(Schema.sessions).where(eq(Schema.sessions.id, row.session.id))
			return { code: 'err:expired' as const }
		}
		const denyRes = await Rbac.tryDenyPermissionsForUser(ctx, row.user.discordId, RBAC.perm('site:authorized'))
		if (denyRes) return denyRes
		let expiresAt = row.session.expiresAt

		if (DateFns.getTime(row.session.expiresAt) - DateFns.getTime(currentTime) < Math.floor(SESSION_MAX_AGE / 2)) {
			expiresAt = new Date(DateFns.getTime(currentTime) + SESSION_MAX_AGE)
			await ctx.db({ redactParams: true }).update(Schema.sessions).set({
				expiresAt,
			})
		}

		return { code: 'ok' as const, sessionId: row.session.id, expiresAt, user: row.user }
	})
})

export const logout = C.spanOp('sessions:logout', { tracer }, async (ctx: C.AuthedUser & C.HttpRequest) => {
	await ctx.db().delete(Schema.sessions).where(eq(Schema.sessions.id, ctx.sessionId))
	C.setSpanStatus(Otel.SpanStatusCode.OK)
	return clearInvalidSession(ctx)
})

export function clearInvalidSession(ctx: C.HttpRequest) {
	return ctx.res.cookie('sessionId', '', { path: '/', maxAge: 0 }).redirect(AR.exists('/login'))
}
export function updateSession(ctx: C.AuthedUser & C.HttpRequest) {
	return ctx.res.cookie('sessionid', '', { path: '/', maxAge: Math.floor((DateFns.getTime(ctx.expiresAt) - Date.now()) / 1000) })
}

export const getUser = C.spanOp('sessions:get-user', { tracer }, async (opts: { lock?: boolean }, ctx: C.AuthedUser & C.HttpRequest) => {
	C.setSpanOpAttrs({ lock: opts.lock })
	opts.lock ??= false
	const q = ctx
		.db()
		.select({ user: Schema.users })
		.from(Schema.sessions)
		.where(eq(Schema.sessions.id, ctx.sessionId))
		.leftJoin(Schema.users, eq(Schema.users.discordId, Schema.sessions.userId))

	const [row] = opts.lock ? await q.for('update') : await q

	C.setSpanStatus(Otel.SpanStatusCode.OK)
	return row!.user!
})
