import { returnInsertErrors, returnUpdateErrors } from '@/lib/drizzle.ts'
import { transformer } from '@/lib/trpc.ts'
import * as M from '@/models.ts'
import { initTRPC } from '@trpc/server'
import { eq, sql } from 'drizzle-orm'
import { z } from 'zod'

import { Context } from './context.ts'
import * as Schema from './schema.ts'
import * as LQ from './systems/layer-queue.ts'
import * as LayersQuery from './systems/layers-query.ts'

export const t = initTRPC.context<Context>().create({ transformer })

const loggerMiddleware = t.middleware(async ({ path, type, next, input, meta }) => {
	const start = Date.now()
	const result = await next()
	const durationMs = Date.now() - start
	if (result.ok) {
		//@ts-expect-error idk man
		const ctx = result.ctx as Context
		ctx.log = ctx.log.child({ type, input })
		ctx.log.debug({ path, type, durationMs, input }, 'TRPC %s: %s ', type, path)
	}
	return result
})

const procedure = t.procedure.use(loggerMiddleware)
function procedureWithInput<InputSchema extends z.ZodType<any, any, any>>(input: InputSchema) {
	return procedure.input(input).use(loggerMiddleware)
}

export const appRouter = t.router({
	getLoggedInUser: procedure.query(async ({ ctx }) => {
		const [row] = await ctx.db
			.select()
			.from(Schema.sessions)
			.where(eq(Schema.sessions.id, ctx.sessionId))
			.leftJoin(Schema.users, eq(Schema.sessions.userId, Schema.users.discordId))
		return row.users
	}),
	// could be merged with getLayers if this becomes too unweildy, mostly duplicate functionality
	getUniqueValues: procedureWithInput(
		z.object({
			columns: z.array(z.enum(M.COLUMN_TYPE_MAPPINGS.string)),
			limit: z.number().positive().max(500).default(100),
			filter: M.FilterNodeSchema.optional(),
		})
	).query(async ({ input, ctx }) => {
		type Columns = (typeof input.columns)[number]
		const selectObj = input.columns.reduce(
			(acc, column) => {
				acc[column] = Schema.layers[column]
				return acc
			},
			{} as { [key in Columns]: (typeof Schema.layers)[key] }
		)

		const rows = await ctx.db
			.select(selectObj)
			.from(Schema.layers)
			// this could be a having clause, but since we're mainly using this for filtering ids, the cardinality is fine before the group-by anyway
			.where(input.filter ? LayersQuery.getWhereFilterConditions(input.filter) : sql`1=1`)
			.groupBy(...input.columns.map((column) => Schema.layers[column]))
			.limit(input.limit)
		return rows
	}),
	getLayers: procedureWithInput(LayersQuery.LayersQuerySchema).query(LayersQuery.runLayersQuery),
	watchServerUpdates: procedure.subscription(LQ.watchUpdates),
	updateQueue: procedureWithInput(M.ServerStateSchema).mutation(async ({ input }) => {
		return LQ.update(input)
	}),
	pollServerInfo: procedure.subscription(LQ.pollServerInfo),
	getFilters: procedure.query(async ({ ctx }) => {
		return ctx.db.select().from(Schema.filters) as Promise<M.FilterEntity[]>
	}),
	createFilter: procedureWithInput(M.FilterEntitySchema).mutation(async ({ input, ctx }) => {
		const res = await returnInsertErrors(ctx.db.insert(Schema.filters).values(input))
		return res.code
	}),
	updateFilter: procedureWithInput(z.tuple([M.FilterEntitySchema.shape.id, M.FilterUpdateSchema.partial()])).mutation(
		async ({ input, ctx }) => {
			const [id, update] = input
			const res = await returnUpdateErrors(ctx.db.update(Schema.filters).set(update).where(eq(Schema.filters.id, id)))
			ctx.log.info(res, 'Updated filter %d', id)
			return res.code
		}
	),
	deleteFilter: procedureWithInput(M.FilterEntitySchema.shape.id).mutation(async ({ input, ctx }) => {
		const [res] = await ctx.db.delete(Schema.filters).where(eq(Schema.filters.id, input))
		if (res.affectedRows === 0) {
			return { code: 'err:filter-not-found' }
		}
		return { code: 'ok' }
	}),
})
// export type definition of API
export type AppRouter = typeof appRouter
