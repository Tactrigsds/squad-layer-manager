import * as M from '@/models.ts'
import { Context } from '@/server/context'
import * as DB from '@/server/db.ts'
import * as Schema from '@/server/schema'
import { SQL, sql } from 'drizzle-orm'
import { and, asc, between, desc, eq, gt, gte, inArray, like, lt, or } from 'drizzle-orm/expressions'
import { SelectedFields } from 'drizzle-orm/mysql-core'
import seedrandom from 'seedrandom'
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
	let whereClause: any
	let whereCondition = sql`1=1`
	const db = ctx.db

	if (input.filter) {
		whereCondition = getWhereFilterConditions(input.filter) ?? whereCondition
	}

	let query = db.select().from(Schema.layers).where(whereCondition)

	if (input.sort.type === 'column') {
		query = query.orderBy(
			input.sort.sortDirection === 'ASC' ? asc(Schema.layers[input.sort.sortBy]) : desc(Schema.layers[input.sort.sortBy])
		)
	} else if (input.sort.type === 'random') {
		query = query.orderBy(sql`RAND(${input.sort.seed})`)
	}

	if (input.groupBy) {
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

export function getWhereFilterConditions(filter: M.FilterNode): SQL | undefined {
	if (filter.type === 'comp') {
		const comp = filter.comp!
		const column = Schema.layers[comp.column]

		switch (comp.code) {
			case 'eq':
				return eq(column, comp.value)
			case 'in':
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

	const childConditions = filter.children!.map(getWhereFilterConditions)

	if (filter.type === 'and') {
		return and(...childConditions)
	} else if (filter.type === 'or') {
		return or(...childConditions)
	}

	throw new Error(`Unknown filter type: ${filter.type}`)
}
