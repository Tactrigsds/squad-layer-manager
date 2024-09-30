import { wrapColName } from '@/lib/sql'
import * as M from '@/models.ts'
import { Database } from 'sqlite'
import * as sqlite3 from 'sqlite3'
import { z } from 'zod'

export const LayersQuerySchema = z.object({
	pageIndex: z.number().int().min(0).default(0),
	pageSize: z.number().int().min(1).max(200),
	sort: z
		.discriminatedUnion('type', [
			z.object({
				type: z.literal('column'),
				sortBy: z.enum(M.COLUMN_KEYS),
				sortDirection: z.enum(['ASC', 'DESC']),
			}),
			z.object({
				type: z.literal('random'),
				seed: z.string().max(32).describe('entropy seed for random sort'),
			}),
		])
		.optional(),
	filter: M.FilterNodeSchema.optional(),
})

export type LayersQuery = z.infer<typeof LayersQuerySchema>

export async function runLayersQuery(
	{ pageIndex, pageSize, sort, filter }: LayersQuery,
	db: Database<sqlite3.Database, sqlite3.Statement>
) {
	let params: Record<string, string | number> = {}
	let countParams: Record<string, string | number> = {}
	let orderClause = ''
	let whereClause = ''
	if (filter) {
		const [whereQuery, whereParams] = getWhereFilterConditions(filter)
		const [whereQueryNamed, whereParamsNamed] = positionalParamsToNamed(whereQuery, whereParams)
		whereClause = `WHERE ${whereQueryNamed}`
		params = { ...params, ...whereParamsNamed }
		countParams = { ...countParams, ...whereParamsNamed }
	}
	if (sort && sort.type === 'column') {
		orderClause = `ORDER BY ${wrapColName(sort.sortBy)} ${sort.sortDirection}`
	}
	const limitClause = 'LIMIT @pageSize'
	params.pageSize = pageSize
	let offsetClause: string
	if (sort && sort.type === 'random') {
		offsetClause = ''
	} else {
		offsetClause = 'OFFSET @offset'
		params.offset = pageIndex * pageSize
	}
	const layersQuery = `SELECT ${M.COLUMN_KEYS.map(wrapColName).join(', ')} FROM layers ${whereClause} ${orderClause} ${limitClause} ${offsetClause}`
	let totalCount: number | undefined
	let layers: M.Layer[]
	const countQuery = `SELECT COUNT(*) as count FROM layers ${whereClause}`
	if (sort?.type !== 'random') {
		let countResult: { count: number } | undefined
		;[layers, countResult] = await Promise.all([db.all<M.Layer[]>(layersQuery, params), db.get<{ count: number }>(countQuery, countParams)])
		totalCount = countResult?.count ?? 0
	} else {
		const { count } = (await db.get<{ count: number }>(countQuery, countParams))!
		const tolerance = 50
		const rangeStart = Math.floor(Math.random() * (count - pageSize - tolerance))
		const rangeEnd = rangeStart + pageSize + tolerance
		const randomCullWhereClause = `(RandomOrdinal >= @rangeStart AND RandomOrdinal < @rangeEnd)`
		params.rangeStart = rangeStart
		params.rangeEnd = rangeEnd
		const query = `SELECT ${M.COLUMN_KEYS.map(wrapColName).join(', ')} FROM layers ${whereClause} AND ${randomCullWhereClause} ${limitClause} ${offsetClause}`
		layers = await db.all<M.Layer[]>(query, params)
		totalCount = count
	}
	return {
		layers,
		totalCount,
		pageCount: Math.ceil(totalCount / pageSize),
	}
}

function positionalParamsToNamed(query: string, params: (string | number)[]) {
	const namedParams = {} as Record<string, string | number>
	for (let i = 0; i < params.length; i++) {
		namedParams[`@${i}`] = params[i]
	}
	const questionmarkIndexes = [...query.matchAll(/\?/g)].map((m) => m.index)
	for (const idx of questionmarkIndexes) {
		query = query.slice(0, idx) + `@${idx}` + query.slice(idx + 1)
	}
	return [query, namedParams] as const
}

// export async function runLayersQuery(
// 	{ pageIndex, pageSize, sort, filter }: LayersQuery,
// 	db: Database<sqlite3.Database, sqlite3.Statement>
// ) {
// 	let params: (string | number)[] = []
// 	let countParams: (string | number)[] = []

// 	let orderClause = ''
// 	let whereClause = ''
// 	if (filter) {
// 		const [whereFilter, whereParams] = getWhereFilterConditions(filter)
// 		whereClause = `WHERE ${whereFilter}`
// 		params = [...params, ...whereParams]
// 		countParams = [...countParams, ...whereParams]
// 	}
// 	if (sort && sort.type === 'column') {
// 		orderClause = `ORDER BY ? ${sort.sortDirection}`
// 		params.push(wrapColName(sort.sortBy))
// 	}
// 	const limitClause = 'LIMIT ?'
// 	params.push(pageSize)

// 	let offsetClause: string
// 	if (sort && sort.type === 'random') {
// 		offsetClause = ''
// 	} else {
// 		offsetClause = 'OFFSET ?'
// 		params.push(pageIndex * pageSize)
// 	}

// 	const layersQuery = `SELECT ${M.COLUMN_KEYS.map(wrapColName).join(', ')} FROM layers ${whereClause} ${orderClause} ${limitClause} ${offsetClause}`
// 	let totalCount: number | undefined
// 	let layers: M.Layer[]
// 	const countQuery = `SELECT COUNT(*) as count FROM layers ${whereClause}`
// 	if (sort?.type !== 'random') {
// 		let countResult: { count: number } | undefined
// 		;[layers, countResult] = await Promise.all([db.all<M.Layer[]>(layersQuery, params), db.get<{ count: number }>(countQuery, countParams)])
// 		totalCount = countResult?.count ?? 0
// 	} else {
//   	// RandomOrdinal is effectively a regular ordinal but randomized so we can use it to get a random sample of the results of any query of arbitrary size
// 		const { count } = (await db.get<{ count: number }>(countQuery, countParams))!

// 		// we're only estimating how many entries we get back so we need a reasonable tolerance so we don't end up with too few results
// 		const tolerance = 50
// 		const rangeStart = Math.floor(Math.random() * (count - pageSize - tolerance))
// 		const rangeEnd = rangeStart + pageSize  + tolerance
// 		const randomCullWhereClause = `(RandomOrdinal >= ? AND RandomOrdinal < ?)`
// 		params.push(rangeStart, rangeEnd)

// 		const query = `SELECT ${M.COLUMN_KEYS.map(wrapColName).join(', ')} FROM layers ${whereClause} AND ${randomCullWhereClause} ${limitClause} ${offsetClause}`
// 		const layers = await db.all<M.Layer[]>(query, params)

// 	return {
// 		layers,
// 		totalCount,
// 		pageCount: Math.ceil(totalCount / pageSize),
// 	}
// }

function getWhereFilterConditions(filter: M.FilterNode): [string, string[]] {
	if (filter.type === 'comp') {
		const comp = filter.comp!
		if (comp.code === 'eq') {
			return [`(${wrapColName(comp.column)} = ?)`, [comp.value]] as const
		}
		if (comp.code === 'in') {
			if (comp.values.length === 0) return ['1=1', []] as const
			const inClause = comp.values.map(() => '?').join(',')
			return [`(${wrapColName(comp.column)} IN (${inClause}))`, comp.values] as const
		}
		if (comp.code === 'gt') {
			return [`(${wrapColName(comp.column)} > ?)`, [comp.value.toString()]] as const
		}
		if (comp.code === 'lt') {
			return [`(${wrapColName(comp.column)} < ?)`, [comp.value.toString()]] as const
		}
		if (comp.code === 'inrange') {
			return [`(${wrapColName(comp.column)} BETWEEN ? AND ?)`, [comp.min.toString(), comp.max.toString()]] as const
		}
	}
	const childConditions = filter.children!.map(getWhereFilterConditions)
	const expressions = childConditions.map((c) => c[0])
	const params = childConditions.flatMap((c) => c[1])
	if (filter.type === 'and' || filter.type === 'or') {
		const op = filter.type === 'and' ? 'AND' : 'OR'
		if (expressions.length > 1) {
			return [`(${expressions.join(` ${op} `)})`, params] as const
		}
		return [expressions[0], params] as const
	}

	throw new Error(`Unknown filter type: ${filter.type}`)
}
