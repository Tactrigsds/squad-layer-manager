import { TRPCError } from '@trpc/server'
import { aliasedTable, SQL, sql } from 'drizzle-orm'
import superjson from 'superjson'
import * as E from 'drizzle-orm/expressions'
import { z } from 'zod'

import * as FB from '@/lib/filter-builders'
import * as M from '@/models.ts'
import * as C from '@/server/context'
import * as Schema from '@/server/schema'
import * as SquadjsSchema from '@/server/schema-squadjs'
import { assertNever } from '@/lib/typeGuards'

export const LayersQuerySortSchema = z
	.discriminatedUnion('type', [
		z.object({
			type: z.literal('column'),
			sortBy: z.enum(M.COLUMN_KEYS),
			sortDirection: z.enum(['ASC', 'DESC']).optional().default('ASC'),
		}),
		z.object({
			type: z.literal('random'),
			seed: z.number().int().positive(),
		}),
	])
	.describe('if not provided, no sorting will be done')

export const LayersQueryInputSchema = z.object({
	pageIndex: z.number().int().min(0).optional(),
	pageSize: z.number().int().min(1).max(200).optional(),
	sort: LayersQuerySortSchema.optional(),
	filter: M.FilterNodeSchema.optional(),
	historyFilters: z.array(M.HistoryFilterSchema).optional(),
	queuedLayerIds: z.array(M.LayerIdSchema).optional(),
})
export const historyFiltersCache = new Map<string, M.FilterNode>()

export type LayersQueryInput = z.infer<typeof LayersQueryInputSchema>

export async function runLayersQuery(args: { input: LayersQueryInput; ctx: C.Log & C.Db }) {
	const { ctx: baseCtx, input: input } = args
	input.pageSize ??= 200
	input.pageIndex ??= 0
	await using opCtx = C.pushOperation(baseCtx, 'layers-query:run')

	let whereCondition = sql`1=1`
	let filter = input.filter

	if (input.historyFilters) {
		let historyFilter: M.FilterNode
		if (historyFiltersCache.has(superjson.stringify(input.historyFilters))) {
			historyFilter = historyFiltersCache.get(superjson.stringify(input.historyFilters))!
		} else {
			historyFilter = await getHistoryFilter(opCtx, input.historyFilters, input.queuedLayerIds ?? [])
		}

		if (filter) {
			filter = FB.and([filter, historyFilter])
		} else {
			filter = historyFilter
		}
	}

	if (filter) {
		whereCondition = (await getWhereFilterConditions(filter, [], opCtx)) ?? whereCondition
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

export const LayersQueryGroupedByInputSchema = z.object({
	columns: z.array(z.enum(M.COLUMN_TYPE_MAPPINGS.string)),
	limit: z.number().positive().max(500).default(500),
	filter: M.FilterNodeSchema.optional(),
	sort: LayersQuerySortSchema.optional(),
})
export type LayersQueryGroupedByInput = z.infer<typeof LayersQueryGroupedByInputSchema>
export async function runLayersQueryGroupedBy(ctx: C.Log & C.Db, input: LayersQueryGroupedByInput) {
	type Columns = (typeof input.columns)[number]
	const selectObj = input.columns.reduce(
		(acc, column) => {
			// @ts-expect-error no idea
			acc[column] = Schema.layers[column]
			return acc
		},
		{} as { [key in Columns]: (typeof Schema.layers)[key] }
	)

	let query = ctx
		.db()
		.select(selectObj)
		.from(Schema.layers)
		// this could be a having clause, but since we're mainly using this for filtering ids, the cardinality is fine before the group-by anyway
		.where(input.filter ? await getWhereFilterConditions(input.filter, [], ctx) : sql`1=1`)
		.groupBy(...input.columns.map((column) => Schema.layers[column]))

	if (input.sort && input.sort.type === 'column') {
		// @ts-expect-error idk
		query = query.orderBy(
			input.sort.sortDirection === 'ASC' ? E.asc(Schema.layers[input.sort.sortBy]) : E.desc(Schema.layers[input.sort.sortBy])
		)
	} else if (input.sort && input.sort.type === 'random') {
		// @ts-expect-error idk
		query = query.orderBy(sql`RAND(${input.sort.seed})`)
	}

	return await query.limit(input.limit)
}

// reentrantFilterIds are IDs that cannot be present in this node,
// as their presence would cause infinite recursion
export async function getWhereFilterConditions(
	node: M.FilterNode,
	reentrantFilterIds: string[],
	ctx: C.Db & C.Log,
	schema: typeof Schema.layers = Schema.layers
): Promise<SQL> {
	let res: SQL | undefined
	if (node.type === 'comp') {
		const comp = node.comp!
		switch (comp.code) {
			case 'has': {
				if (comp.values.length === 0) {
					throw new TRPCError({
						code: 'BAD_REQUEST',
						message: `value for ${comp.column} in 'has' cannot be empty`,
					})
				}
				if (comp.values.length > 2) {
					throw new TRPCError({
						code: 'BAD_REQUEST',
						message: `value for ${comp.column} in 'has' must be less than 3 values`,
					})
				}
				if (comp.column !== 'SubFacMatchup' && new Set(comp.values).size !== comp.values.length) {
					throw new TRPCError({
						code: 'BAD_REQUEST',
						message: `value for ${comp.column} in 'has' has duplicates`,
					})
				}

				if (comp.column === 'FactionMatchup') {
					const values = comp.values as string[]
					const conditions: SQL[] = []
					for (const faction of values) {
						conditions.push(hasTeam(faction, null, schema))
					}
					res = E.and(...conditions)!
					break
				}
				if (comp.column === 'FullMatchup') {
					const factionValues = comp.values.map(M.parseTeamString)
					const conditions: SQL[] = []
					for (const { faction, subfac } of factionValues) {
						conditions.push(hasTeam(faction, subfac as M.Subfaction, schema))
					}
					res = E.and(...conditions)!
					break
				}
				if (comp.column === 'SubFacMatchup') {
					if (comp.values[0] === comp.values[1]) {
						const value = comp.values[0] as M.Subfaction
						return E.and(E.eq(schema.SubFac_1, value), E.eq(schema.SubFac_2, value))!
					}
					const conditions: SQL[] = []
					for (const subfaction of comp.values) {
						conditions.push(hasTeam(null, subfaction as M.Subfaction, schema))
					}
					res = E.and(...conditions)!
					break
				}
				throw new TRPCError({
					code: 'BAD_REQUEST',
					message: 'has can currently only be used with FactionMatchup, FullMatchup, SubFacMatchup',
				})
			}
			case 'eq': {
				const column = schema[comp.column]
				// @ts-expect-error idc
				res = E.eq(column, comp.value)!
				break
			}
			case 'in': {
				const column = schema[comp.column]
				// @ts-expect-error idc
				res = E.inArray(column, comp.values)!
				break
			}
			case 'like': {
				const column = schema[comp.column]
				res = E.like(column, comp.value)!
				break
			}
			case 'gt': {
				const column = schema[comp.column]
				res = E.gt(column, comp.value)!
				break
			}
			case 'lt': {
				const column = schema[comp.column]
				res = E.lt(column, comp.value)!
				break
			}
			case 'inrange': {
				const column = schema[comp.column]
				res = E.and(E.gte(column, comp.min), E.lte(column, comp.max))!
				break
			}
			case 'is-true': {
				const column = schema[comp.column]
				res = E.eq(column, true)!
				break
			}
			default:
				assertNever(comp)
		}
	}
	if (node.type === 'apply-filter') {
		if (reentrantFilterIds.includes(node.filterId)) {
			// TODO too lazy to return an error here right now
			throw new TRPCError({
				code: 'BAD_REQUEST',
				message: 'Filter mutually is recursive via filter: ' + node.filterId,
			})
		}
		const entity = await getFilterEntity(node.filterId, ctx)
		if (!entity) {
			// TODO too lazy to return an error here right now
			throw new TRPCError({
				code: 'BAD_REQUEST',
				message: `Filter ${node.filterId} Doesn't exist`,
			})
		}
		const filter = M.FilterNodeSchema.parse(entity.filter)
		res = await getWhereFilterConditions(filter, [...reentrantFilterIds, node.filterId], ctx, schema)
	}

	if (M.isBlockNode(node)) {
		const childConditions = await Promise.all(node.children.map((node) => getWhereFilterConditions(node, reentrantFilterIds, ctx, schema)))
		if (node.type === 'and') {
			res = E.and(...childConditions)!
		} else if (node.type === 'or') {
			res = E.or(...childConditions)!
		}
	}

	if (res && node.neg) return E.not(res)!
	return res!
}

function hasTeam(
	faction: string | null | typeof Schema.layers.Faction_1 = null,
	subfaction: M.Subfaction | null | typeof Schema.layers.SubFac_1 = null,
	schema: typeof Schema.layers
) {
	if (!faction && !subfaction) {
		throw new Error('At least one of faction or subfaction must be provided')
	}

	if (subfaction === null) {
		return E.or(E.eq(schema.Faction_1, faction!), E.eq(schema.Faction_2, faction!))!
	}
	if (faction === null) {
		return E.or(E.eq(schema.SubFac_1, subfaction), E.eq(schema.SubFac_2, subfaction))!
	}
	return E.or(
		E.and(E.eq(schema.Faction_1, faction), E.eq(schema.SubFac_1, subfaction)),
		E.and(E.eq(schema.Faction_2, faction), E.eq(schema.SubFac_2, subfaction))
	)!
}

async function getFilterEntity(filterId: string, ctx: C.Db) {
	const [filter] = await ctx.db().select().from(Schema.filters).where(E.eq(Schema.filters.id, filterId))
	return filter as Schema.Filter | undefined
}

// function getLast10Layers(ctx: C.Db) {

// }

export async function getHistoryFilter(_ctx: C.Db & C.Log, historyFilters: M.HistoryFilter[], queuedLayerIds: M.LayerId[]) {
	await using ctx = C.pushOperation(_ctx, 'layers-query:get-history-filter-node')
	const sortedHistoryFilters = historyFilters.sort((a, b) => a.excludeFor.matches - b.excludeFor.matches)

	const comparisons: M.FilterNode[] = []

	for (const filter of sortedHistoryFilters) {
		if (!comparisons) {
			throw new TRPCError({ code: 'BAD_REQUEST', message: 'Invalid filter' })
		}
		const subfacteam1 = aliasedTable(Schema.subfactions, 'subfacteam1')
		const subfacteam2 = aliasedTable(Schema.subfactions, 'subfacteam2')

		const numFromHistory = filter.excludeFor.matches - queuedLayerIds.length
		const _sqApplicable = ctx
			.db()
			//@ts-expect-error this works trust me
			.select(Schema.layers)
			.from(SquadjsSchema.dbLogMatches)
			.leftJoin(subfacteam1, E.eq(subfacteam1.fullName, SquadjsSchema.dbLogMatches.subFactionTeam1))
			.leftJoin(subfacteam2, E.eq(subfacteam2.fullName, SquadjsSchema.dbLogMatches.subFactionTeam2))
			.leftJoin(
				Schema.layers,
				E.and(
					E.eq(Schema.layers.Layer, SquadjsSchema.dbLogMatches.layerClassname),
					E.eq(subfacteam1.shortName, Schema.layers.SubFac_1),
					E.eq(subfacteam2.shortName, Schema.layers.SubFac_2),
					E.eq(Schema.layers.Faction_1, SquadjsSchema.dbLogMatches.team1Short),
					E.eq(Schema.layers.Faction_2, SquadjsSchema.dbLogMatches.team2Short)
				)
			)
			.orderBy(E.desc(SquadjsSchema.dbLogMatches.startTime))
			.limit(numFromHistory)
			.as('applicable-matches')

		const applicableHistoryLayerIds = ctx.db().select({ id: _sqApplicable.id }).from(_sqApplicable)

		const numFromQueue = Math.min(filter.excludeFor.matches, queuedLayerIds.length)
		queuedLayerIds = queuedLayerIds.slice(0, numFromQueue)
		const applicableLayers = ctx
			.db()
			.select()
			.from(Schema.layers)
			.where(E.or(E.inArray(Schema.layers.id, queuedLayerIds), E.inArray(Schema.layers.id, applicableHistoryLayerIds)))
			.as('applicable-layers')

		ctx.tasks.push(
			(async () => {
				switch (filter.type) {
					case 'dynamic': {
						let selectedCols: M.LayerColumnKey[] = []
						if (filter.column === 'FullMatchup') {
							selectedCols = ['Faction_1', 'SubFac_1', 'Faction_2', 'SubFac_2']
						} else if (filter.column === 'FactionMatchup') {
							selectedCols = ['Faction_1', 'Faction_2']
						} else if (filter.column === 'SubFacMatchup') {
							selectedCols = ['SubFac_1', 'SubFac_2']
						} else {
							selectedCols = [filter.column]
						}
						const selected = Object.fromEntries(selectedCols.map((col) => [col, applicableLayers[col]]))
						const applicableValues = await ctx.db().select(selected).from(applicableLayers)
						if (M.isColType(filter.column, 'string')) {
							comparisons.push(
								FB.comp(
									FB.inValues(
										filter.column,
										//@ts-expect-error this works trust me
										[...new Set(applicableValues.map((row) => row[filter.substitutedColumn]))]
									),
									{ neg: true }
								)
							)
						} else {
							throw new Error('not implemented')
						}
						break

						// todo match on the column type instead
						// 	if (filter.comparison.code === 'eq') {
						// 		if (!M.isColType(filter.column, 'string')) throw new Error('invalid column type for eq filter')
						// 		comparisons.push(
						// 			FB.comp(
						// 				FB.inValues(
						// 					filter.column,
						// 					//@ts-expect-error this works trust me
						// 					[...new Set(applicableValues.map((row) => row[filter.substitutedColumn]))]
						// 				),
						// 				{ neg: true }
						// 			)
						// 		)
						// 	} else if (filter.comparison.code === 'has') {
						// 		let values: string[][]
						// 		if (filter.substitutedColumn === 'FullMatchup') {
						// 			values = applicableValues.map((row) => [
						// 				M.getLayerTeamString(row.Faction_1, row.SubFac_1),
						// 				M.getLayerTeamString(row.Faction_2, row.SubFac_2),
						// 			])
						// 		} else if (filter.substitutedColumn === 'FactionMatchup') {
						// 			values = applicableValues.map((row) => [row.Faction_1, row.Faction_2])
						// 		} else if (filter.substitutedColumn === 'SubFacMatchup') {
						// 			values = applicableValues.map((row) => [row.SubFac_1, row.SubFac_2])
						// 		} else {
						// 			throw new Error('Invalid column for has filter')
						// 		}

						// 		for (const value of values) {
						// 			comparisons.push(FB.comp(FB.hasAll(filter.substitutedColumn, value), { neg: true }))
						// 		}
						// 	} else {
						// 		throw new Error('Unsupported comparison type for substituted column')
						// 	}
					}
					case 'static': {
						const condition = await getWhereFilterConditions(
							FB.comp(filter.comparison),
							[],
							ctx,
							applicableLayers as unknown as typeof Schema.layers
						)
						const query = ctx
							.db()
							.select({ count: sql<number>`count(*)` })
							.from(applicableLayers)
							.where(condition)

						const [{ count }] = await query

						if (count !== 0) {
							comparisons.push(FB.comp(filter.comparison, { neg: true }))
						}
						break
					}
					default:
						assertNever(filter)
				}
			})()
		)
	}

	await Promise.all(ctx.tasks)
	return FB.and(comparisons)
}

export function setupLayersQuerySystem() {}
