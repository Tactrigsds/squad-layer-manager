import * as Schema from '$root/drizzle/schema.ts'
import * as RBAC from '@/rbac.models'
import { procedure, router } from '@/server/trpc.server.ts'
import * as E from 'drizzle-orm/expressions'
import { z } from 'zod'
import { getUserRbacPerms as getUserRbacPerms } from './rbac.system'

export const usersRouter = router({
	getLoggedInUser: procedure.query(async ({ ctx }) => {
		const perms = await getUserRbacPerms(ctx, ctx.user.discordId)
		const user: RBAC.UserWithRbac = {
			...ctx.user,
			perms,
		}
		return { ...user, wsClientId: ctx.wsClientId }
	}),
	getUser: procedure.input(z.bigint()).query(async ({ ctx, input }) => {
		const [user] = await ctx.db().select().from(Schema.users).where(E.eq(Schema.users.discordId, input))
		if (!user) return { code: 'err:not-found' as const }
		return { code: 'ok' as const, user }
	}),
	getUsers: procedure.query(async ({ ctx }) => {
		const users = await ctx.db().select().from(Schema.users)
		return { code: 'ok' as const, users }
	}),
})
