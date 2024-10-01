import { wrapColName } from '@/lib/sql'
import * as M from '@/models.ts'
import seedrandom from 'seedrandom'
import { Database } from 'sqlite'
import * as sqlite3 from 'sqlite3'
import { z } from 'zod'

import * as DB from './db.ts'

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

export async function runLayersQuery(
	{ pageIndex, pageSize, sort, filter }: LayersQuery,
	db: Database<sqlite3.Database, sqlite3.Statement>
) {
	let params: Record<string, string | number> = {}
	let countParams: Record<string, string | number> = {}
	let whereClause = ''
	if (filter) {
		const [whereQuery, whereParams] = getWhereFilterConditions(filter)
		const [whereQueryNamed, whereParamsNamed] = positionalParamsToNamed(whereQuery, whereParams)
		whereClause = `WHERE ${whereQueryNamed}`
		params = { ...params, ...whereParamsNamed }
		countParams = { ...countParams, ...whereParamsNamed }
	}
	let orderClause = ''
	if (sort && sort.type === 'column') {
		orderClause = `ORDER BY ${wrapColName(sort.sortBy)} ${sort.sortDirection}`
	}
	const limitClause = 'LIMIT @pageSize'
	params['@pageSize'] = pageSize
	let offsetClause: string
	if (sort && sort.type === 'random') {
		offsetClause = ''
	} else {
		offsetClause = 'OFFSET @offset'
		params['@offset'] = pageIndex * pageSize
	}
	let totalCount: number | undefined
	let layers: M.Layer[]
	const countQuery = `SELECT COUNT(*) as count FROM layers ${whereClause}`
	if (sort.type === 'column') {
		const query = `SELECT ${M.COLUMN_KEYS.map(wrapColName).join(', ')} FROM layers ${whereClause} ${orderClause} ${limitClause} ${offsetClause}`
		let countResult: { count: number } | undefined
		;[layers, countResult] = await Promise.all([db.all<M.Layer[]>(query, params), db.get<{ count: number }>(countQuery, countParams)])
		totalCount = countResult?.count ?? 0
	} else if (sort.type === 'random') {
		/** -------- random sort --------
		 * sqlite doesn't have a built-in method of seeding a random sort. Instead, we assign a random integer to each row(not necessarily unique), and then just return a random range with our required size. there will be correlations in similar random numbers, so we need to update the random ordinals every once and a while. right now we're just going to do it everyt ime.
		 */
		const { count: countNoFilters } = (await db.get<{ count: number }>('SELECT COUNT(*) as count from layers'))!
		const { count } = (await db.get<{ count: number }>(countQuery, countParams))!
		const toleranceCoefficient = 2
		const random = seedrandom(sort.seed).quick()
		const rangeSize = Math.ceil(pageSize * (countNoFilters / count)) * toleranceCoefficient
		const rangeStart = Math.floor(random * (count - rangeSize))
		const rangeEnd = rangeStart + rangeSize
		const randomCullWhereClause = `(RandomOrdinal >= @rangeStart AND RandomOrdinal < @rangeEnd)`
		params['@rangeStart'] = rangeStart
		params['@rangeEnd'] = rangeEnd
		whereClause = (whereClause ? whereClause + ' AND' : 'WHERE ') + randomCullWhereClause
		const query = `SELECT ${M.COLUMN_KEYS.map(wrapColName).join(', ')} FROM layers ${whereClause} ORDER BY RandomOrdinal ${limitClause}` // reseed random ordinals
		layers = await db.all<M.Layer[]>(query, params)
		// separate connection and no await because we don't want to block on this operation
		;(async () => {
			const db = await DB.openConnection()
			try {
				const randomlySelectedLayers = await db.all<{ Id: string }[]>(`SELECT Id from layers ${whereClause}`)
				const ops: Promise<unknown>[] = []
				for (const layer of randomlySelectedLayers) {
					ops.push(db.run('UPDATE layers SET RandomOrdinal = ? WHERE Id = ?', [Math.floor(Math.random() * countNoFilters), layer.Id]))
				}
				await Promise.all(ops)
			} finally {
				db.close()
			}
		})()
		totalCount = count
	} else {
		throw new Error('Invalid sort type')
	}
	return {
		layers,
		totalCount,
		pageCount: Math.ceil(totalCount / pageSize),
	}
}

function positionalParamsToNamed(query: string, params: (string | number)[]) {
	const namedParams = {} as Record<string, string | number>
	const questionmarkIndexes = [...query.matchAll(/\?/g)].map((m) => m.index)
	if (params.length !== questionmarkIndexes.length) throw new Error('params length does not match query')
	let offset = 0
	for (let i = 0; i < params.length; i++) {
		const paramKey = `@${i}`
		namedParams[paramKey] = params[i]
		const markIndex = questionmarkIndexes[i] + offset
		query = query.slice(0, markIndex) + paramKey + query.slice(markIndex + 1)
		// account for length change due to adding paramKey
		offset += paramKey.length - 1
	}
	return [query, namedParams] as const
}

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
