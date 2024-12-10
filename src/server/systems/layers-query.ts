import { TRPCError } from '@trpc/server'
import { aliasedTable, SQL, sql } from 'drizzle-orm'
import * as E from 'drizzle-orm/expressions'
import { z } from 'zod'

import * as FB from '@/lib/filter-builders'
import * as M from '@/models.ts'
import * as C from '@/server/context'
import * as Schema from '@/server/schema'
import * as SquadjsSchema from '@/server/schema-squadjs'
import { assertNever } from '@/lib/typeGuards'
import { objKeys } from '@/lib/object'
import { SubscriptionStatus } from 'discord.js'

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
	historyFilters: z.array(M.HistoryFilterSchema).optional(),
	queuedLayerIds: z.array(M.LayerIdSchema).optional(),
})

export type LayersQuery = z.infer<typeof LayersQuerySchema>

export async function runLayersQuery(args: { input: LayersQuery; ctx: C.Log & C.Db }) {
	const { ctx: baseCtx, input: input } = args
	await using opCtx = C.pushOperation(baseCtx, 'layers-query:run')

	let whereCondition = sql`1=1`

	if (input.filter) {
		whereCondition = (await getWhereFilterConditions(input.filter, [], opCtx)) ?? whereCondition
	}
	if (input.historyFilters) {
		whereCondition = E.and(whereCondition, await getHistoryFilterConditions(opCtx, input.historyFilters, input.queuedLayerIds ?? []))
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
	ctx: C.Db & C.Log,
	schema: typeof Schema.layers = Schema.layers,
	substitutedTable?: typeof Schema.layers
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
					const values = substitutedTable ? [substitutedTable?.Faction_1, substitutedTable?.Faction_2] : comp.values
					const conditions: SQL[] = []
					for (const faction of values) {
						conditions.push(hasTeam(faction, null, schema))
					}
					res = E.and(...conditions)
					break
				}
				if (comp.column === 'FullMatchup') {
					const factionValues = substitutedTable
						? [
								{ faction: substitutedTable?.Faction_1, subfac: substitutedTable.SubFac_1 },
								{ faction: substitutedTable?.Faction_2, subfac: substitutedTable.SubFac_2 },
							].slice(0, comp.values.length)
						: comp.values.map(M.parseTeamString)
					const conditions: SQL[] = []
					for (const { faction, subfac } of factionValues) {
						conditions.push(hasTeam(faction, subfac as M.Subfaction, schema))
					}
					res = E.and(...conditions)
					break
				}
				if (comp.column === 'SubFacMatchup') {
					const values = substitutedTable ? [substitutedTable?.SubFac_1, substitutedTable?.SubFac_2].slice(comp.values.length) : comp.values
					if (values[0] === values[1]) {
						const value = comp.values[0] as M.Subfaction
						return E.and(E.eq(schema.SubFac_1, value), E.eq(schema.SubFac_2, value))
					}
					const conditions: SQL[] = []
					for (const subfaction of values) {
						conditions.push(hasTeam(null, subfaction as M.Subfaction, schema))
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
				const column = schema[comp.column]
				// @ts-expect-error idc
				res = E.eq(column, substitutedTable[comp.column] ?? comp.value)
				break
			}
			case 'in': {
				const column = schema[comp.column]
				// @ts-expect-error idc
				res = E.inArray(column, substitutedTable[comp.column] ?? comp.values)
				break
			}
			case 'like': {
				const column = schema[comp.column]
				if (substitutedTable) {
					throw new TRPCError({ code: 'BAD_REQUEST', message: 'Substituted table in like filter is not supported' })
				}
				res = E.like(column, comp.value)
				break
			}
			case 'gt': {
				const column = schema[comp.column]
				if (substitutedTable) {
					throw new TRPCError({ code: 'BAD_REQUEST', message: 'Substituted table in gt filter is not supported' })
				}
				res = E.gt(column, comp.value)
				break
			}
			case 'lt': {
				const column = schema[comp.column]
				if (substitutedTable) {
					throw new TRPCError({ code: 'BAD_REQUEST', message: 'Substituted table in lt filter is not supported' })
				}
				res = E.lt(column, comp.value)
				break
			}
			case 'inrange': {
				const column = schema[comp.column]
				if (substitutedTable) {
					ctx.log.warn('Substituted table in inrange filter. This is not supported')
				}
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
		res = await getWhereFilterConditions(filter, [...reentrantFilterIds, node.filterId], ctx, schema)
	}

	if (M.isBlockNode(node)) {
		const childConditions = await Promise.all(node.children.map((node) => getWhereFilterConditions(node, reentrantFilterIds, ctx, schema)))
		if (node.type === 'and') {
			res = E.and(...childConditions)
		} else if (node.type === 'or') {
			res = E.or(...childConditions)
		}
	}

	if (res && node.neg) return E.not(res)
	return res
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

export async function getHistoryFilterConditions(
	ctx: C.Db & C.Log,
	filteredLayerTable: typeof Schema.layers,
	historyFilters: M.HistoryFilter[],
	layerQueueIds: M.LayerId[]
) {
	if (historyFilters.length === 0) {
		return sql`1=1`
	}
	historyFilters = [...historyFilters].sort((a, b) => b.excludeFor.matches - a.excludeFor.matches)

	const historyMatches = ctx
		.db()
		.select({
			ord: sql`ROW_NUMBER() OVER()`.as('ord'),
			...SquadjsSchema.dbLogMatches,
		})
		.from(SquadjsSchema.dbLogMatches)
		.orderBy(E.desc(SquadjsSchema.dbLogMatches.startTime))
		.limit(historyFilters[0].excludeFor.matches - layerQueueIds.length)
		.as('applicable-matches')

	const subfacteam1 = aliasedTable(Schema.subfactions, 'subfacteam1')
	const subfacteam2 = aliasedTable(Schema.subfactions, 'subfacteam2')
	const layersTable = aliasedTable(Schema.layers, 'queued-layers')

	const historyFilterConditions = []
	for (const historyFilter of historyFilters) {
		const node = FB.comp(historyFilter.comparison)
		const sql = await getWhereFilterConditions(node, [], ctx, layersTable)
		const historyCOndition = E.and(E.lte(historyMatches.ord, Math.max(historyFilter.excludeFor.matches - layerQueueIds.length, 0)), sql)
		historyFilterConditions.push(historyCOndition)
	}
	const historyFilterCondition = E.or(...historyFilterConditions)

	const matchedFromHistoryQuery = ctx
		.db()
		.select({ id: layersTable.id })
		.from(historyMatches)
		.leftJoin(
			subfacteam1,
			E.and(E.eq(subfacteam1.fullName, historyMatches.subFactionTeam1), E.eq(subfacteam1.factionShortName, historyMatches.team1Short))
		)
		.leftJoin(
			subfacteam2,
			E.and(E.eq(subfacteam2.fullName, historyMatches.subFactionTeam2), E.eq(subfacteam2.factionShortName, historyMatches.team2Short))
		)
		.leftJoin(
			layersTable,
			E.and(
				E.eq(layersTable.Layer, historyMatches.layerClassname),
				E.eq(layersTable.Faction_1, historyMatches.team1Short),
				E.eq(layersTable.Faction_2, historyMatches.team2Short),
				E.eq(subfacteam1.shortName, layersTable.SubFac_1),
				E.eq(subfacteam2.shortName, layersTable.SubFac_2)
			)
		)
		.where(E.and(E.isNotNull(layersTable.id), historyFilterCondition))

	const queueConditions: SQL[] = []

	for (const filter of historyFilters) {
		const node = FB.comp(filter.comparison)
		const lastNItems = layerQueueIds.slice(0, filter.excludeFor.matches)
		const condition = E.notExists(
			ctx
				.db()
				.select()
				.from(Schema.layers)
				.where(E.and(E.inArray(Schema.layers.id, lastNItems), await getWhereFilterConditions(node, [], ctx, Schema.layers)))
		)
		queueConditions.push(condition)
	}
	const queueCondition = E.and(...queueConditions)

	return E.and(E.notInArray(filteredLayerTable.id, matchedFromHistoryQuery), queueCondition)
}
