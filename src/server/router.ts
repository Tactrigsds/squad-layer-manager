import * as M from '@/models.ts'
import { initTRPC } from '@trpc/server'
import { z } from 'zod'

import { db } from './db.ts'
import { LayersQuerySchema, runLayersQuery } from './layers-query.ts'

type User = {
	id: string
	name: string
	bio?: string
}
const users: Record<string, User> = { id_bilbo: { id: 'id_bilbo', name: 'Bilbo Baggins', bio: 'Hobbit' } }
export const t = initTRPC.create()
export const appRouter = t.router({
	getColumnUniqueColumnValues: t.procedure.input(z.enum(M.COLUMN_TYPE_MAPPINGS.string)).query(async ({ input }) => {
		// this direct templating is ok because we're using an enum to ensure the input is safe
		const rows = (await db.all(`SELECT DISTINCT ${input} FROM layers`)) as M.Layer[]
		return rows.map((row) => row[input] as string)
	}),
	getLayers: t.procedure.input(LayersQuerySchema).query(async ({ input }) => {
		const res = await runLayersQuery(input)
		return res
	}),
	getUserById: t.procedure.input(z.string()).query((opts) => {
		return users[opts.input] // input type is string
	}),
	createUser: t.procedure
		.input(
			z.object({
				name: z.string().min(3),
				bio: z.string().max(142).optional(),
			})
		)
		.mutation((opts) => {
			const id = Date.now().toString()
			const user: User = { id, ...opts.input }
			users[user.id] = user
			return user
		}),
})
// export type definition of API
export type AppRouter = typeof appRouter
