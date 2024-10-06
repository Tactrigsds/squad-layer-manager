import * as M from '@/models.ts'
import { initTRPC } from '@trpc/server'
import { CreateFastifyContextOptions } from '@trpc/server/adapters/fastify'
import { sql } from 'drizzle-orm'
import { z } from 'zod'

import * as BaseContext from './context.ts'
import { db } from './db.ts'
import * as Schema from './schema.ts'
import * as LayersQuery from './systems/layers-query.ts'
import * as SS from './systems/server-state.ts'

type User = {
	id: string
	name: string
	bio?: string
}
const users: Record<string, User> = { id_bilbo: { id: 'id_bilbo', name: 'Bilbo Baggins', bio: 'Hobbit' } }

export function createContext(options: CreateFastifyContextOptions) {
	return {
		...BaseContext.createContext(options),
	}
}
type Context = ReturnType<typeof createContext>

export const t = initTRPC.context<Context>().create()

const loggerMiddleware = t.middleware(async ({ path, type, next, input }) => {
	const start = Date.now()
	const result = await next()
	const durationMs = Date.now() - start
	//@ts-expect-error idk man
	const ctx = result.ctx as Context
	ctx.log = ctx.log.child({ type, input })
	ctx.log.info({ path, type, durationMs, input }, 'TRPC %s: %s ', type, path)
	return result
})

const procedure = t.procedure.use(loggerMiddleware)
function procedureWithInput<InputSchema extends z.ZodType<any, any, any>>(input: InputSchema) {
	return procedure.input(input).use(loggerMiddleware)
}

export const appRouter = t.router({
	getColumnUniqueColumnValues: procedureWithInput(
		z.object({
			columns: z.array(z.enum(M.COLUMN_TYPE_MAPPINGS.string)),
			limit: z.number().positive().max(500).default(100),
			filter: M.FilterNodeSchema.optional(),
		})
	).query(async ({ input }) => {
		console.log({ input })
		type Columns = (typeof input.columns)[number]
		const selectObj = input.columns.reduce(
			(acc, column) => {
				acc[column] = Schema.layers[column]
				return acc
			},
			{} as { [key in Columns]: (typeof Schema.layers)[key] }
		)

		const rows = await db
			.select(selectObj)
			.from(Schema.layers)
			// this could be a having clause, but since we're mainly using this for filtering ids, the cardinality is fine before the group-by anyway
			.where(input.filter ? LayersQuery.getWhereFilterConditions(input.filter) : sql`1=1`)
			.groupBy(...input.columns.map((column) => Schema.layers[column]))
			.limit(input.limit)

		return rows
	}),
	getLayers: procedureWithInput(LayersQuery.LayersQuerySchema).query(async ({ input }) => {
		const res = await LayersQuery.runLayersQuery(input)
		return res
	}),
	watchLayerQueueUpdates: procedure.subscription(SS.watchUpdates),
	updateQueue: procedureWithInput(M.LayerQueueUpdateSchema).mutation(async ({ input }) => {
		return SS.update(input)
	}),
	getUserById: procedureWithInput(z.string()).query((opts) => {
		return users[opts.input] // input type is string
	}),
	createUser: procedureWithInput(
		z.object({
			name: z.string().min(3),
			bio: z.string().max(142).optional(),
		})
	).mutation((opts) => {
		const id = Date.now().toString()
		const user: User = { id, ...opts.input }
		users[user.id] = user
		return user
	}),

	pollServerInfo: procedure.subscription(SS.pollServerInfo),
})
// export type definition of API
export type AppRouter = typeof appRouter
