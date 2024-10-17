import * as M from '@/models.ts'
import { Context } from '@/server/context'
import * as DB from '@/server/db.ts'
import * as Schema from '@/server/schema'
import { TRPCError } from '@trpc/server'
import { SQL, sql } from 'drizzle-orm'
import { and, asc, between, desc, eq, gt, inArray, like, lt, or } from 'drizzle-orm/expressions'
import { z } from 'zod'

export const LayersQuerySchema = z.object({
	pageIndex: z.number().int().min(0).default(0),
	pageSize: z.number().int().min(1).max(200),
	sort: z.discriminatedUnion('type', [
		z.object({
			type: z.literal('column'),
			sortBy: z.enum(M.COLUMN_KEYS),
			sortDirection: z.enum(['ASC', 'DESC']),
		}),
		z.object({
			type: z.literal('random'),
			seed: z.number().int().positive(),
		}),
	]),
	groupBy: z.array(z.enum(M.COLUMN_KEYS))?.optional(),
	filter: M.FilterNodeSchema.optional(),
})

export type LayersQuery = z.infer<typeof LayersQuerySchema>

export async function runLayersQuery(args: { input: LayersQuery; ctx: Context }) {
	const { ctx, input: input } = args
	let whereCondition = sql`1=1`
	const db = ctx.db

	if (input.filter) {
		whereCondition = (await getWhereFilterConditions(input.filter, [], ctx)) ?? whereCondition
	}

	let query = db.select().from(Schema.layers).where(whereCondition)

	if (input.sort.type === 'column') {
		//@ts-expect-error idk
		query = query.orderBy(
			input.sort.sortDirection === 'ASC' ? asc(Schema.layers[input.sort.sortBy]) : desc(Schema.layers[input.sort.sortBy])
		)
	} else if (input.sort.type === 'random') {
		//@ts-expect-error idk
		query = query.orderBy(sql`RAND(${input.sort.seed})`)
	}

	if (input.groupBy) {
		//@ts-expect-error idk
		query = query.groupBy(...input.groupBy.map((col) => Schema.layers[col]))
	}
	const [layers, [countResult]] = await Promise.all([
		query.offset(input.pageIndex * input.pageSize).limit(input.pageSize),
		db
			.select({ count: sql<number>`count(*)` })
			.from(Schema.layers)
			.where(whereCondition),
	])
	const totalCount = countResult.count

	return {
		layers,
		totalCount,
		pageCount: input.sort.type === 'random' ? 1 : Math.ceil(totalCount / input.pageSize),
	}
}

// reentrantFilterIds are IDs that cannot be present in this node,
// as their presence would cause infinite recursion
export async function getWhereFilterConditions(
	node: M.FilterNode,
	reentrantFilterIds: string[],
	ctx: { db: DB.Db }
): Promise<SQL | undefined> {
	if (node.type === 'comp') {
		const comp = node.comp!
		const column = Schema.layers[comp.column]

		switch (comp.code) {
			case 'eq':
				//@ts-expect-error idk
				return eq(column, comp.value)
			case 'in':
				//@ts-expect-error idk
				return inArray(column, comp.values)
			case 'like':
				return like(column, comp.value)
			case 'gt':
				return gt(column, comp.value)
			case 'lt':
				return lt(column, comp.value)
			case 'inrange':
				return between(column, comp.min, comp.max)
		}
	}
	if (node.type === 'apply-filter') {
		if (reentrantFilterIds.includes(node.filterId)) {
			throw new TRPCError({ code: 'BAD_REQUEST', message: 'Filter mutually is recursive via filter: ' + node.filterId })
		}
		const entity = await getFilterEntity(node.filterId, ctx)
		if (!entity) {
			// TODO too lazy to return an error here right now
			throw new TRPCError({ code: 'BAD_REQUEST', message: `Filter ${node.filterId} Doesn't exist` })
		}
		const filter = M.FilterNodeSchema.parse(entity.filter)
		return getWhereFilterConditions(filter, [...reentrantFilterIds, node.filterId], ctx)
	}

	const childConditions = await Promise.all(node.children!.map((node) => getWhereFilterConditions(node, reentrantFilterIds, ctx)))

	if (node.type === 'and') {
		return and(...childConditions)
	} else if (node.type === 'or') {
		return or(...childConditions)
	}

	//@ts-expect-error I don't trust typescript
	throw new Error(`Unknown filter type: ${node.type}`)
}

async function getFilterEntity(filterId: string, ctx: { db: DB.Db }) {
	const [filter] = await ctx.db.select().from(Schema.filters).where(eq(Schema.filters.id, filterId))
	return filter as Schema.Filter | undefined
}
