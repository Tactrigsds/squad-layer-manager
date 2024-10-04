import * as M from '@/models.ts'
import { TRPCError, initTRPC } from '@trpc/server'
import { eq, inArray } from 'drizzle-orm'
import { z } from 'zod'

import { db } from './db.ts'
import * as Schema from './schema.ts'
import { LayersQuerySchema, runLayersQuery } from './systems/layers-query.ts'
import * as Rcon from './systems/rcon.ts'
import * as SS from './systems/server-state.ts'

type User = {
	id: string
	name: string
	bio?: string
}
const users: Record<string, User> = { id_bilbo: { id: 'id_bilbo', name: 'Bilbo Baggins', bio: 'Hobbit' } }
export const t = initTRPC.create()
export const appRouter = t.router({
	getColumnUniqueColumnValues: t.procedure.input(z.enum(M.COLUMN_TYPE_MAPPINGS.string)).query(async ({ input }) => {
		const rows = await db
			.select({ [input]: Schema.layers[input] })
			.from(Schema.layers)
			.groupBy(Schema.layers[input])
		return rows.map((row) => row[input] as string)
	}),
	getLayers: t.procedure.input(LayersQuerySchema).query(async ({ input }) => {
		const res = await runLayersQuery(input)
		return res
	}),
	watchLayerQueueUpdates: t.procedure.subscription(SS.watchUpdates),
	updateQueue: t.procedure.input(M.LayerQueueUpdateSchema).mutation(async ({ input }) => {
		return SS.update(input)
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

	pollServerInfo: t.procedure.subscription(SS.pollServerInfo),
})
// export type definition of API
export type AppRouter = typeof appRouter
