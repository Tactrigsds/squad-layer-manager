import * as M from '@/models'
import * as Schema from '@/server/schema'
import * as E from 'drizzle-orm/expressions'
import { procedure, router } from '@/server/trpc.server.ts'
import { z } from 'zod'

export const usersRouter = router({
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
