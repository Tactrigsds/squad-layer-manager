import { eq } from 'drizzle-orm'

import * as AR from '@/app-routes'
import { sleep } from '@/lib/async'
import * as DB from '@/server/db.ts'
import { baseLogger } from '@/server/logger'
import * as Schema from '@/server/schema.ts'

import * as C from '@/server/context'

export const SESSION_MAX_AGE = 1000 * 60 * 60 * 48

export async function setupSessions() {
	// --------  cleanup old sessions  --------
	while (true) {
		await sleep(1000 * 60 * 60)
		await using ctx = C.pushOperation(DB.addPooledDb({ log: baseLogger }), 'sessions:cleanup')
		await ctx.db().transaction(async (tx) => {
			const sessions = await tx.select().from(Schema.sessions)
			for (const session of sessions) {
				if (new Date() > session.expiresAt) {
					await tx.delete(Schema.sessions).where(eq(Schema.sessions.id, session.id))
				}
			}
		})
	}
}

export async function validateSession(sessionId: string, baseCtx: C.Log & C.Db) {
	await using ctx = C.pushOperation(baseCtx, 'sessions:validate')
	const [row] = await ctx
		.db()
		.select({ session: Schema.sessions, user: Schema.users })
		.from(Schema.sessions)
		.where(eq(Schema.sessions.id, sessionId))
		.innerJoin(Schema.users, eq(Schema.users.discordId, Schema.sessions.userId))
	if (!row) return { code: 'err:not-found' as const }
	if (new Date() > row.session.expiresAt) {
		ctx.tasks.push(ctx.db().delete(Schema.sessions).where(eq(Schema.sessions.id, row.session.id)))
		return { code: 'err:expired' as const }
	}
	await Promise.all(ctx.tasks)
	return { code: 'ok' as const, sessionId: row.session.id, user: row.user }
}

export async function logout(ctx: C.AuthedUser & C.HttpRequest) {
	await using opCtx = C.pushOperation(ctx, 'sessions:logout')
	await opCtx.db().delete(Schema.sessions).where(eq(Schema.sessions.id, ctx.sessionId))
	return clearInvalidSession(ctx)
}

export function clearInvalidSession(ctx: C.HttpRequest) {
	return ctx.res.cookie('sessionId', '', { path: '/', maxAge: 0 }).redirect(AR.exists('/login'))
}

export async function getUser(opts: { lock?: boolean }, ctx: C.AuthedUser & C.HttpRequest) {
	await using opCtx = C.pushOperation(ctx, 'sessions:get-user')
	opts.lock ??= false
	const q = opCtx
		.db()
		.select({ user: Schema.users })
		.from(Schema.sessions)
		.where(eq(Schema.sessions.id, ctx.sessionId))
		.leftJoin(Schema.users, eq(Schema.users.discordId, Schema.sessions.userId))

	const [row] = opts.lock ? await q.for('update') : await q

	return row!.user!
}
