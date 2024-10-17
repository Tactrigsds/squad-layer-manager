import * as AR from '@/app-routes'
import { sleep } from '@/lib/async'
import * as DB from '@/server/db.ts'
import { Logger, baseLogger as log } from '@/server/logger'
import * as Schema from '@/server/schema.ts'
import { eq } from 'drizzle-orm'

import { Context } from '../context'

export const SESSION_MAX_AGE = 1000 * 60 * 60 * 48
export async function setupSessions() {
	const db = DB.get({ log })
	// --------  cleanup old sessions  --------
	do {
		await sleep(1000 * 60 * 60)
		await db.transaction(async (db) => {
			const sessions = await db.select().from(Schema.sessions)
			for (const session of sessions) {
				if (new Date() > session.expiresAt) {
					await db.delete(Schema.sessions).where(eq(Schema.sessions.id, session.id))
				}
			}
		})
	} while (true)
}

export async function validateSession(sessionId: string, ctx: { db: DB.Db; log: Logger }) {
	const [session] = await ctx.db.select().from(Schema.sessions).where(eq(Schema.sessions.id, sessionId))
	if (!session) return false
	if (new Date() > session.expiresAt) {
		await ctx.db.delete(Schema.sessions).where(eq(Schema.sessions.id, session.id))
		return false
	}
	return true
}

export async function logout(ctx: { db: DB.Db; sessionId: string; res: any }) {
	await ctx.db.delete(Schema.sessions).where(eq(Schema.sessions.id, ctx.sessionId))
	const reply = ctx.res
	return reply.cookie('sessionId', '', { path: '/', maxAge: 0 }).redirect(AR.exists('/login'))
}

export async function getUser(opts: { lock?: boolean }, ctx: Context) {
	opts.lock ??= false
	const q = ctx.db
		.select({ user: Schema.users })
		.from(Schema.sessions)
		.where(eq(Schema.sessions.id, ctx.sessionId))
		.leftJoin(Schema.users, eq(Schema.users.discordId, Schema.sessions.id))

	const [row] = opts.lock ? await q.for('update') : await q

	return row!.user!
}
