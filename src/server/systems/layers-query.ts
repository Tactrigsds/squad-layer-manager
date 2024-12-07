import { TRPCError } from '@trpc/server'
import { SQL, sql } from 'drizzle-orm'
import * as E from 'drizzle-orm/expressions'
import { z } from 'zod'

import * as M from '@/models.ts'
import * as C from '@/server/context'
import * as Schema from '@/server/schema'
import { assertNever } from '@/lib/typeGuards'

export const LayersQuerySchema = z.object({
	pageIndex: z.number().int().min(0).default(0),
	pageSize: z.number().int().min(1).max(200),
	sort: z
		.discriminatedUnion('type', [
			z.object({
				type: z.literal('column'),
				sortBy: z.enum(M.COLUMN_KEYS_NON_COLLECTION),
				sortDirection: z.enum(['ASC', 'DESC']).optional().default('ASC'),
			}),
			z.object({
				type: z.literal('random'),
				seed: z.number().int().positive(),
			}),
		])
		.optional()
		.describe('if not provided, no sorting will be done'),
	groupBy: z.array(z.enum(M.COLUMN_KEYS_NON_COLLECTION))?.optional(),
	filter: M.FilterNodeSchema.optional(),
})

export type LayersQuery = z.infer<typeof LayersQuerySchema>

export async function runLayersQuery(args: { input: LayersQuery; ctx: C.Log & C.Db }) {
	const { ctx: baseCtx, input: input } = args
	await using opCtx = C.pushOperation(baseCtx, 'layers-query:run')

	let whereCondition = sql`1=1`

	if (input.filter) {
		whereCondition = (await getWhereFilterConditions(input.filter, [], opCtx)) ?? whereCondition
	}

	let query = opCtx.db().select().from(Schema.layers).where(whereCondition)

	if (input.sort && input.sort.type === 'column') {
		// @ts-expect-error idk
		query = query.orderBy(
			input.sort.sortDirection === 'ASC' ? E.asc(Schema.layers[input.sort.sortBy]) : E.desc(Schema.layers[input.sort.sortBy])
		)
	} else if (input.sort && input.sort.type === 'random') {
		// @ts-expect-error idk
		query = query.orderBy(sql`RAND(${input.sort.seed})`)
	}

	if (input.groupBy) {
		// @ts-expect-error idk
		query = query.groupBy(...input.groupBy.map((col) => Schema.layers[col]))
	}
	const [layers, [countResult]] = await Promise.all([
		query
			.offset(input.pageIndex * input.pageSize)
			.limit(input.pageSize)
			.then((layers) => layers.map(M.includeComputedCollections)),
		opCtx
			.db()
			.select({ count: sql<number>`count(*)` })
			.from(Schema.layers)
			.where(whereCondition),
	])
	const totalCount = countResult.count

	return {
		layers,
		totalCount,
		pageCount: input.sort?.type === 'random' ? 1 : Math.ceil(totalCount / input.pageSize),
	}
}

// reentrantFilterIds are IDs that cannot be present in this node,
// as their presence would cause infinite recursion
export async function getWhereFilterConditions(
	node: M.FilterNode,
	reentrantFilterIds: string[],
	ctx: C.Db & C.Log
): Promise<SQL | undefined> {
	let res: SQL | undefined
	if (node.type === 'comp') {
		const comp = node.comp!
		switch (comp.code) {
			case 'has': {
				if (comp.values.length === 0) {
					throw new TRPCError({ code: 'BAD_REQUEST', message: `value for ${comp.column} in 'has' cannot be empty` })
				}
				if (comp.values.length > 2) {
					throw new TRPCError({ code: 'BAD_REQUEST', message: `value for ${comp.column} in 'has' must be less than 3 values` })
				}
				if (comp.column !== 'SubFacMatchup' && new Set(comp.values).size !== comp.values.length) {
					throw new TRPCError({ code: 'BAD_REQUEST', message: `value for ${comp.column} in 'has' has duplicates` })
				}

				if (comp.column === 'FactionMatchup') {
					const conditions: SQL[] = []
					for (const faction of comp.values) {
						conditions.push(hasTeam(faction))
					}
					res = E.and(...conditions)
					break
				}
				if (comp.column === 'FullMatchup') {
					const conditions: SQL[] = []
					for (const { faction, subfac } of comp.values.map(M.parseTeamString)) {
						conditions.push(hasTeam(faction, subfac as M.Subfaction))
					}
					res = E.and(...conditions)
					break
				}
				if (comp.column === 'SubFacMatchup') {
					if (comp.values[0] === comp.values[1]) {
						const value = comp.values[0] as M.Subfaction
						return E.and(E.eq(Schema.layers.SubFac_1, value), E.eq(Schema.layers.SubFac_2, value))
					}
					const conditions: SQL[] = []
					for (const subfaction of comp.values) {
						conditions.push(hasTeam(null, subfaction as M.Subfaction))
					}
					res = E.and(...conditions)
					break
				}
				throw new TRPCError({
					code: 'BAD_REQUEST',
					message: 'has can currently only be used with FactionMatchup, FullMatchup, SubFacMatchup',
				})
			}
			case 'eq': {
				const column = Schema.layers[comp.column]
				// @ts-expect-error idc
				res = E.eq(column, comp.value)
				break
			}
			case 'in': {
				const column = Schema.layers[comp.column]
				// @ts-expect-error idc
				res = E.inArray(column, comp.values)
				break
			}
			case 'like': {
				const column = Schema.layers[comp.column]
				res = E.like(column, comp.value)
				break
			}
			case 'gt': {
				const column = Schema.layers[comp.column]
				res = E.gt(column, comp.value)
				break
			}
			case 'lt': {
				const column = Schema.layers[comp.column]
				res = E.lt(column, comp.value)
				break
			}
			case 'inrange': {
				const column = Schema.layers[comp.column]
				res = E.between(column, comp.min, comp.max)
				break
			}
			default:
				assertNever(comp)
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

function hasTeam(faction: string | null = null, subfaction: M.Subfaction | null = null) {
	if (!faction && !subfaction) {
		throw new Error('At least one of faction or subfaction must be provided')
	}

	if (subfaction === null) {
		return E.or(E.eq(Schema.layers.Faction_1, faction!), E.eq(Schema.layers.Faction_2, faction!))!
	}
	if (faction === null) {
		return E.or(E.eq(Schema.layers.SubFac_1, subfaction), E.eq(Schema.layers.SubFac_2, subfaction))!
	}
	return E.or(
		E.and(E.eq(Schema.layers.Faction_1, faction), E.eq(Schema.layers.SubFac_1, subfaction)),
		E.and(E.eq(Schema.layers.Faction_2, faction), E.eq(Schema.layers.SubFac_2, subfaction))
	)!
}

async function getFilterEntity(filterId: string, ctx: C.Db) {
	const [filter] = await ctx.db().select().from(Schema.filters).where(E.eq(Schema.filters.id, filterId))
	return filter as Schema.Filter | undefined
}
