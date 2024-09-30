import { wrapColName } from '@/lib/sql'
import * as M from '@/models.ts'
import seedrandom from 'seedrandom'
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
				seed: z.string().length(16).describe('base64 encoded string of some bytes to use to set the random sorting seed'),
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
	let params: (string | number)[] = []
	let countParams: (string | number)[] = []

	let orderClause = ''
	let whereClause = ''
	if (filter) {
		const [whereFilter, whereParams] = getWhereFilterConditions(filter)
		whereClause = `WHERE ${whereFilter}`
		params = [...params, ...whereParams]
		countParams = [...countParams, ...whereParams]
	}
	if (sort && sort.type === 'column') {
		orderClause = `ORDER BY ? ${sort.sortDirection}`
		params.push(wrapColName(sort.sortBy))
	}
	const limitClause = 'LIMIT ?'
	params.push(pageSize)

	let offsetClause: string
	if (sort && sort.type === 'random') {
		offsetClause = ''
	} else {
		offsetClause = 'OFFSET ?'
		params.push(pageIndex * pageSize)
	}

	const layersQuery = `SELECT ${M.COLUMN_KEYS.map(wrapColName).join(', ')} FROM layers ${whereClause} ${orderClause} ${limitClause} ${offsetClause}`
	let totalCount: number | undefined
	let layers: M.Layer[]
	if (sort?.type !== 'random') {
		const countQuery = `SELECT COUNT(*) as count FROM layers ${whereClause}`
		let countResult: { count: number } | undefined
		;[layers, countResult] = await Promise.all([db.all<M.Layer[]>(layersQuery, params), db.get<{ count: number }>(countQuery, countParams)])
		totalCount = countResult?.count ?? 0
	} else {
		// base64 decode
		const random = seedrandom(sort.seed, 'base64') as number

		layers = await db.all<M.Layer[]>(layersQuery, params)
		totalCount = layers.length
	}

	return {
		layers,
		totalCount,
		pageCount: Math.ceil(totalCount / pageSize),
	}
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
