import { TRPCError } from '@trpc/server'
import { SQL, sql } from 'drizzle-orm'
import * as E from 'drizzle-orm/expressions'
import { z } from 'zod'

import * as M from '@/models.ts'
import * as C from '@/server/context'
import * as Schema from '@/server/schema'

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

export async function runLayersQuery(args: { input: LayersQuery; ctx: C.Log & C.Db }) {
	const { ctx: baseCtx, input: input } = args
	await using opCtx = C.pushOperation(baseCtx, 'layers-query:run')

	let whereCondition = sql`1=1`
	const db = opCtx.db

	if (input.filter) {
		whereCondition = (await getWhereFilterConditions(input.filter, [], opCtx)) ?? whereCondition
	}

	let query = db.select().from(Schema.layers).where(whereCondition)

	if (input.sort.type === 'column') {
		//@ts-expect-error idk
		query = query.orderBy(
			input.sort.sortDirection === 'ASC' ? E.asc(Schema.layers[input.sort.sortBy]) : E.desc(Schema.layers[input.sort.sortBy])
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
export async function getWhereFilterConditions(node: M.FilterNode, reentrantFilterIds: string[], ctx: C.Db): Promise<SQL | undefined> {
	let res: SQL | undefined
	if (node.type === 'comp') {
		const comp = node.comp!
		const column = Schema.layers[comp.column]

		switch (comp.code) {
			case 'eq':
				//@ts-expect-error idk
				res = E.eq(column, comp.value)
				break
			case 'in':
				//@ts-expect-error idk
				res = E.inArray(column, comp.values)
				break
			case 'like':
				res = E.like(column, comp.value)
				break
			case 'gt':
				res = E.gt(column, comp.value)
				break
			case 'lt':
				res = E.lt(column, comp.value)
				break
			case 'inrange':
				res = E.between(column, comp.min, comp.max)
				break
		}
	}
	if (node.type === 'apply-filter') {
		if (reentrantFilterIds.includes(node.filterId)) {
			// TODO too lazy to return an error here right now
			throw new TRPCError({ code: 'BAD_REQUEST', message: 'Filter mutually is recursive via filter: ' + node.filterId })
		}
		const entity = await getFilterEntity(node.filterId, ctx)
		if (!entity) {
			// TODO too lazy to return an error here right now
			throw new TRPCError({ code: 'BAD_REQUEST', message: `Filter ${node.filterId} Doesn't exist` })
		}
		const filter = M.FilterNodeSchema.parse(entity.filter)
		res = await getWhereFilterConditions(filter, [...reentrantFilterIds, node.filterId], ctx)
	}

	if (M.isBlockNode(node)) {
		const childConditions = await Promise.all(node.children.map((node) => getWhereFilterConditions(node, reentrantFilterIds, ctx)))
		if (node.type === 'and') {
			res = E.and(...childConditions)
		} else if (node.type === 'or') {
			res = E.or(...childConditions)
		}
	}

	if (res && node.neg) return E.not(res)
	return res
}

async function getFilterEntity(filterId: string, ctx: C.Db) {
	const [filter] = await ctx.db.select().from(Schema.filters).where(E.eq(Schema.filters.id, filterId))
	return filter as Schema.Filter | undefined
}
