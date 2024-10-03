import * as M from '@/models.ts'
import { sql } from 'drizzle-orm'
import { and, asc, between, desc, eq, gt, gte, inArray, lt, or } from 'drizzle-orm/expressions'
import seedrandom from 'seedrandom'
import { z } from 'zod'

import { db } from './db'
import * as Schema from './schema'

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
			seed: z.string().max(32).describe('entropy seed for random sort'),
		}),
	]),
	filter: M.FilterNodeSchema.optional(),
})

export type LayersQuery = z.infer<typeof LayersQuerySchema>

export async function runLayersQuery({ pageIndex, pageSize, sort, filter }: LayersQuery) {
	let whereClause: any
	let whereCondition = sql`1=1`

	if (filter) {
		whereCondition = getWhereFilterConditions(filter)
	}

	let layers: M.Layer[]
	let totalCount: number
	if (sort.type === 'column') {
		const [layersResult, countResult] = await Promise.all([
			db
				.select()
				.from(Schema.layers)
				.where(whereCondition)
				.orderBy(sort.sortDirection === 'ASC' ? asc(Schema.layers[sort.sortBy]) : desc(Schema.layers[sort.sortBy]))
				.offset(pageIndex * pageSize)
				.limit(pageSize),
			db
				.select({ count: sql<number>`count(*)` })
				.from(Schema.layers)
				.where(whereCondition),
		])

		layers = layersResult
		;[{ count: totalCount }] = countResult
	} else if (sort.type === 'random') {
		/** -------- random sort --------
		 * mysql doesn't have a built-in method of seeding a random sort. Instead, we assign a random integer to each row(not necessarily unique), and then just return a random range with our required size. there will be correlations in similar random numbers, so we need to update the random ordinals every once and a while. right now we're just going to do it everyt ime.
		 */
		// Count total layers
		const [{ count: countNoFilters }] = await db.select({ count: sql<number>`count(*)` }).from(Schema.layers)

		// Count layers with filters
		const [countWithFilters] = await db
			.select({ count: sql<number>`count(*)` })
			.from(Schema.layers)
			.where(whereClause || sql`1=1`)

		const count = countWithFilters.count

		const toleranceCoefficient = 2
		const random = seedrandom(sort.seed).quick()
		const rangeSize = Math.ceil(pageSize * (countNoFilters / count)) * toleranceCoefficient
		const rangeStart = Math.floor(random * (count - rangeSize))
		const rangeEnd = rangeStart + rangeSize

		// Fetch layers
		const fetchedLayers = await db
			.select()
			.from(Schema.layers)
			.where(and(whereClause || sql`1=1`, gte(Schema.layers.randomOrdinal, rangeStart), lt(Schema.layers.randomOrdinal, rangeEnd)))
			.orderBy(Schema.layers.randomOrdinal)
			.limit(pageSize)

		// Update random ordinals
		const updatePromises = fetchedLayers.map((layer) =>
			db
				.update(Schema.layers)
				.set({ randomOrdinal: Math.floor(Math.random() * countNoFilters) })
				.where(eq(Schema.layers.id, layer.id))
		)
		layers = fetchedLayers
		totalCount = countWithFilters.count

		Promise.all(updatePromises).catch(console.error)
	} else {
		//@ts-expect-error should be unreachable
		throw new Error(`Unknown sort type: ${sort.type}`)
	}

	return {
		layers,
		totalCount,
		pageCount: sort.type === 'random' ? 1 : Math.ceil(totalCount / pageSize),
	}
}

function getWhereFilterConditions(filter: M.FilterNode) {
	if (filter.type === 'comp') {
		const comp = filter.comp!
		const column = Schema.layers[comp.column]

		switch (comp.code) {
			case 'eq':
				return eq(column, comp.value)
			case 'in':
				return inArray(column, comp.values)
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
