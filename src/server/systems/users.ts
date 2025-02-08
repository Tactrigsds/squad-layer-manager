import * as M from '@/models'
import * as Schema from '$root/drizzle/schema.ts'
import * as E from 'drizzle-orm/expressions'
import { procedure, router } from '@/server/trpc.server.ts'
import { z } from 'zod'
import { getUserRbac } from './rbac.system'

export const usersRouter = router({
	getLoggedInUser: procedure.query(async ({ ctx }) => {
		const userRbac = await getUserRbac(ctx, ctx.user.discordId)
		const user: M.UserWithRbac = {
			...ctx.user,
			...userRbac,
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
