import * as M from '@/models'
import * as Schema from '@/server/schema'
import * as E from 'drizzle-orm/expressions'
import * as RBAC from '@/rbac.models'
import * as Rbac from '@/server/systems/rbac.system.ts'
import { procedure, router } from '@/server/trpc.server.ts'
import { z } from 'zod'

export const usersRouter = router({
	getUser: procedure.input(z.bigint()).query(async ({ ctx, input }) => {
		const denyRes = await Rbac.tryDenyPermissionsForUser(ctx, ctx.user.discordId, { check: 'all', permits: [RBAC.perm('users:get')] })
		if (denyRes) return denyRes

		const [user] = await ctx.db().select().from(Schema.users).where(E.eq(Schema.users.discordId, input))
		if (!user) return { code: 'err:not-found' as const }
		return { code: 'ok' as const, user }
	}),
	getUsers: procedure.query(async ({ ctx }) => {
		const denyRes = await Rbac.tryDenyPermissionsForUser(ctx, ctx.user.discordId, { check: 'all', permits: [RBAC.perm('users:get')] })
		if (denyRes) return denyRes

		const users = await ctx.db().select().from(Schema.users)
		return { code: 'ok' as const, users }
	}),
})
