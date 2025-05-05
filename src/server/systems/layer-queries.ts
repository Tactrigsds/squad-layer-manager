import * as Schema from '$root/drizzle/schema.ts'
import * as FB from '@/lib/filter-builders'
import * as OneToMany from '@/lib/one-to-many-map'
import { assertNever } from '@/lib/typeGuards'
import * as M from '@/models.ts'
import * as C from '@/server/context'
import * as LayerQueue from '@/server/systems/layer-queue'
import * as MatchHistory from '@/server/systems/match-history'
import { procedure, router } from '@/server/trpc.server.ts'
import * as Otel from '@opentelemetry/api'
import { TRPCError } from '@trpc/server'
import { SQL, sql } from 'drizzle-orm'
import * as E from 'drizzle-orm/expressions'
import { z } from 'zod'

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
	constraints: z.array(M.QueryConstraintSchema).optional(),
	previousLayerIds: z.array(M.LayerIdSchema).default([]).describe(
		'Layer Ids to be considered as part of the history for filtering purposes',
	),
})
export const historyFiltersCache = new Map<string, M.FilterNode>()

export type LayersQueryInput = z.infer<typeof LayersQueryInputSchema>

const tracer = Otel.trace.getTracer('layer-queries')
export type QueriedLayer = {
	layers: M.Layer & { constraints: boolean[] }
	totalCount: number
}

export async function queryLayers(args: { input: LayersQueryInput; ctx: C.Log & C.Db }) {
	const { ctx, input: input } = args
	input.pageSize ??= 200
	input.pageIndex ??= 0
	const constraints = input.constraints ?? []

	const previousLayerIds = resolveRelevantLayerHistory(ctx, constraints, input.previousLayerIds.length)
	const { conditions: whereConditions, selectProperties } = await buildConstraintSqlCondition(
		ctx,
		previousLayerIds,
		input.constraints ?? [],
	)

	const includeWhere = (query: any) => {
		if (whereConditions.length > 0) return query.where(E.and(...whereConditions))
		return query
	}

	let query: any = ctx.db().select({ ...Schema.layers, ...selectProperties }).from(Schema.layers)
	query = includeWhere(query)

	if (input.sort) {
		switch (input.sort.type) {
			case 'column':
				query = query.orderBy(
					input.sort.sortDirection === 'ASC' ? E.asc(Schema.layers[input.sort.sortBy]) : E.desc(Schema.layers[input.sort.sortBy]),
				)
				break
			case 'random':
				query = query.orderBy(sql`RAND(${input.sort.seed})`)
				break
			default:
				assertNever(input.sort)
		}
	}
	query = query.offset(input.pageIndex * input.pageSize)
		.limit(input.pageSize)

	let countQuery = ctx
		.db()
		.select({ count: sql<string>`count(*)` })
		.from(Schema.layers)
	countQuery = includeWhere(countQuery)

	const postprocessLayers = (layers: (M.Layer & Record<string, boolean>)[]): M.QueriedLayer[] => {
		return layers.map((layer) => {
			// default to true because missing means the constraint is applied via a where condition
			const constraintResults: boolean[] = Array(constraints.length).fill(true)
			for (const key of Object.keys(layer)) {
				const groups = key.match(/^constraint_(\d+)$/)
				if (!groups) continue
				const idx = Number(groups[1])
				constraintResults[idx] = Number(layer[key as keyof M.Layer]) === 1
			}
			return {
				...M.includeComputedCollections(layer),
				constraints: constraintResults,
			}
		})
	}

	const [layers, [countResult]] = await Promise.all(
		[
			query.then(postprocessLayers) as Promise<M.QueriedLayer[]>,
			countQuery,
		] as const,
	)
	const totalCount = Number(countResult.count)

	return {
		code: 'ok' as const,
		layers: layers,
		totalCount,
		pageCount: input.sort?.type === 'random' ? 1 : Math.ceil(totalCount / input.pageSize),
	}
}

export const AreLayersInPoolInputSchema = z.object({
	layers: z.array(M.LayerIdSchema),
})

export const LayerExistsInputSchema = z.array(M.LayerIdSchema)
export type LayerExistsInput = M.LayerId[]

export async function layerExists({ input, ctx }: { input: LayerExistsInput; ctx: C.Log & C.Db }) {
	const results = await ctx.db().select({ id: Schema.layers.id }).from(Schema.layers).where(E.inArray(Schema.layers.id, input))
	const existsMap = new Map(results.map(result => [result.id, true]))

	return {
		code: 'ok' as const,
		results: input.map(id => ({
			id,
			exists: existsMap.has(id),
		})),
	}
}

export const LayersQueryGroupedByInputSchema = z.object({
	columns: z.array(z.enum(M.COLUMN_TYPE_MAPPINGS.string)),
	limit: z.number().positive().max(500).default(500),
	constraints: z.array(M.QueryConstraintSchema).optional(),
	previousLayerIds: z.array(M.LayerIdSchema).default([]),
	sort: LayersQuerySortSchema.optional(),
})

export type LayersQueryGroupedByInput = z.infer<typeof LayersQueryGroupedByInputSchema>
export async function queryLayersGroupedBy({ ctx, input }: { ctx: C.Log & C.Db; input: LayersQueryGroupedByInput }) {
	const whereConditions: SQL<unknown>[] = []
	const constraintBuildingTasks: Promise<any>[] = []
	const constraints = input.constraints ?? []
	const previousLayerIds = resolveRelevantLayerHistory(ctx, constraints, input.previousLayerIds.length)
	for (let i = 0; i < constraints.length; i++) {
		const constraint = constraints[i]
		constraintBuildingTasks.push(
			C.spanOp('layer-queries:build-constraint-sql-condition-groupby', { tracer }, async () => {
				C.setSpanOpAttrs({
					constraintName: constraint.name,
					constraintIndex: i,
					constraintType: constraint.type,
					constraintApplyAs: constraint.applyAs,
				})
				const condition = await getConstraintSQLConditions(ctx, constraint, previousLayerIds)
				if (!condition) return { code: 'err:no-constraint' as const, msg: 'No constraint found' }
				switch (constraint.applyAs) {
					case 'field':
						break
					case 'where-condition':
						whereConditions.push(condition)
						break
					default:
						assertNever(constraint.applyAs)
				}
				return { code: 'ok' as const }
			})(),
		)
	}
	await Promise.all(constraintBuildingTasks)
	type Columns = (typeof input.columns)[number]

	const selectObj = input.columns.reduce(
		(acc, column) => {
			// @ts-expect-error no idea
			acc[column] = Schema.layers[column]
			return acc
		},
		{} as { [key in Columns]: (typeof Schema.layers)[key] },
	)

	let query: any = ctx
		.db()
		.select(selectObj)
		.from(Schema.layers)

	if (whereConditions.length > 0) {
		query = query.where(E.and(...whereConditions))
	}
	query = query.groupBy(...input.columns.map((column) => Schema.layers[column]))

	if (input.sort && input.sort.type === 'column') {
		query = query.orderBy(
			input.sort.sortDirection === 'ASC' ? E.asc(Schema.layers[input.sort.sortBy]) : E.desc(Schema.layers[input.sort.sortBy]),
		)
	} else if (input.sort && input.sort.type === 'random') {
		query = query.orderBy(sql`RAND(${input.sort.seed})`)
	}

	const res = await query.limit(input.limit)
	// TODO fix this type definition
	return res as Record<M.StringColumn, string>[]
}

export async function getConstraintSQLConditions(ctx: C.Log & C.Db, constraint: M.LayerQueryConstraint, previousLayerIds: string[]) {
	switch (constraint.type) {
		case 'filter-anon':
			return await getFilterNodeSQLConditions(ctx, constraint.filter, [])
		case 'filter-entity':
			return await getFilterNodeSQLConditions(ctx, FB.applyFilter(constraint.filterEntityId), [])
		case 'do-not-repeat':
			return getDoNotRepeatSQLConditions(ctx, constraint.rule, previousLayerIds)
			break
		default:
			assertNever(constraint)
	}
}

// reentrantFilterIds are IDs that cannot be present in this node,
// as their presence would cause infinite recursion
export async function getFilterNodeSQLConditions(
	ctx: C.Db & C.Log,
	node: M.FilterNode,
	reentrantFilterIds: string[],
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
						conditions.push(hasTeam(faction, null))
					}
					res = E.and(...conditions)!
					break
				}
				if (comp.column === 'FullMatchup') {
					const factionValues = comp.values.map((v) => M.parseTeamString(v))
					const conditions: SQL[] = []
					for (const { faction, subfac } of factionValues) {
						conditions.push(hasTeam(faction, subfac as M.Subfaction))
					}
					res = E.and(...conditions)!
					break
				}
				if (comp.column === 'SubFacMatchup') {
					if (comp.values[0] === comp.values[1]) {
						const value = comp.values[0] as M.Subfaction
						return E.and(E.eq(Schema.layers.SubFac_1, value), E.eq(Schema.layers.SubFac_2, value))!
					}
					const conditions: SQL[] = []
					for (const subfaction of comp.values) {
						conditions.push(hasTeam(null, subfaction as M.Subfaction))
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
				const column = Schema.layers[comp.column]
				// @ts-expect-error idc
				res = E.eq(column, comp.value)!
				break
			}
			case 'in': {
				const column = Schema.layers[comp.column]
				// @ts-expect-error idc
				res = E.inArray(column, comp.values)!
				break
			}
			case 'like': {
				const column = Schema.layers[comp.column]
				res = E.like(column, comp.value)!
				break
			}
			case 'gt': {
				const column = Schema.layers[comp.column]
				res = E.gt(column, comp.value)!
				break
			}
			case 'lt': {
				const column = Schema.layers[comp.column]
				res = E.lt(column, comp.value)!
				break
			}
			case 'inrange': {
				const column = Schema.layers[comp.column]
				const [min, max] = [...comp.range].sort((a, b) => a - b)
				res = E.and(E.gte(column, min), E.lte(column, max))!
				break
			}
			case 'is-true': {
				const column = Schema.layers[comp.column]
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
		res = await getFilterNodeSQLConditions(ctx, filter, [...reentrantFilterIds, node.filterId])
	}

	if (M.isBlockNode(node)) {
		const childConditions = await Promise.all(
			node.children.map((node) => getFilterNodeSQLConditions(ctx, node, reentrantFilterIds)),
		)
		if (node.type === 'and') {
			res = E.and(...childConditions)!
		} else if (node.type === 'or') {
			res = E.or(...childConditions)!
		}
	}

	if (res && node.neg) return E.not(res)!
	return res!
}

async function buildConstraintSqlCondition(ctx: C.Log & C.Db, previousLayerIds: M.LayerId[], constraints: M.LayerQueryConstraint[]) {
	const conditions: SQL<unknown>[] = []
	const selectProperties: any = {}
	const constraintBuildingTasks: Promise<any>[] = []

	for (let i = 0; i < constraints.length; i++) {
		const constraint = constraints[i]
		constraintBuildingTasks.push(
			C.spanOp('layer-queries:build-constraint-sql-condition', { tracer }, async () => {
				C.setSpanOpAttrs({
					constraintName: constraint.name,
					constraintIndex: i,
					constraintType: constraint.type,
					constraintApplyAs: constraint.applyAs,
				})
				const condition = await getConstraintSQLConditions(ctx, constraint, previousLayerIds)
				if (!condition) return { code: 'err:no-constraint' as const, msg: 'No constraint found' }
				switch (constraint.applyAs) {
					case 'field':
						selectProperties[`constraint_${i}`] = condition
						break
					case 'where-condition':
						conditions.push(condition)
						break
					default:
						assertNever(constraint.applyAs)
				}
				return { code: 'ok' as const }
			})(),
		)
	}
	await Promise.all(constraintBuildingTasks)
	return { conditions, selectProperties }
}

export const LayerStatusesForLayerQueueInputSchema = z.object({
	queue: M.LayerListSchema,
	constraints: z.array(M.QueryConstraintSchema).optional(),
})
export type LayerStatusesForLayerQueueInput = z.infer<typeof LayerStatusesForLayerQueueInputSchema>

export async function getLayerStatusesForLayerQueue(
	{ ctx, input: { queue, constraints } }: { ctx: C.Db & C.Log; input: LayerStatusesForLayerQueueInput },
) {
	if (!constraints) {
		const serverState = await LayerQueue.getServerState({}, ctx)
		constraints = M.getPoolConstraints(serverState.settings.queue.mainPool)
	}

	const historicLayerIds = resolveRelevantLayerHistory(ctx, constraints, 0)
	const relevantPreviousLayerIds: M.LayerId[] = [...historicLayerIds]
	const blockedState: OneToMany.OneToManyMap<string, string> = new Map()
	const violationDescriptorsState = new Map<string, Record<string, string[] | undefined>>()
	const filterConditions: Map<string, Promise<SQL<unknown>>> = new Map()
	for (let i = 0; i < queue.length; i++) {
		const item = queue[i]
		for (const [queuedLayerKey, layerId] of M.getAllLayerIdsWithQueueKey(item)) {
			const violationDescriptors: Record<string, string[] | undefined> = {}
			for (const constraint of constraints) {
				switch (constraint.type) {
					case 'do-not-repeat': {
						const { isBlocked, descriptors } = getisBlockedByDoNotRepeatRule(constraint.rule, layerId, relevantPreviousLayerIds)
						if (!isBlocked) break
						OneToMany.set(blockedState, queuedLayerKey, constraint.id)
						if (descriptors) violationDescriptors[constraint.id] = descriptors
						break
					}
					case 'filter-anon':
						filterConditions.set(constraint.id, getFilterNodeSQLConditions(ctx, constraint.filter, []))
						break
					case 'filter-entity': {
						filterConditions.set(constraint.id, getFilterNodeSQLConditions(ctx, FB.applyFilter(constraint.filterEntityId), []))
						break
					}
				}
			}
			violationDescriptorsState.set(queuedLayerKey, violationDescriptors)
		}
		if (item.layerId) relevantPreviousLayerIds.unshift(item.layerId)
	}

	const queueLayerIds = M.getAllLayerIdsFromList(queue)

	const selectExpr: any = { _id: Schema.layers.id }
	for (const [id, task] of filterConditions.entries()) {
		// we'll fix this if it happens but unlikely
		if (id === '_id') throw new Error('unexpected id for filter constraint')
		selectExpr[id] = await task
	}

	const rows = await ctx.db().select(selectExpr).from(Schema.layers).where(E.inArray(Schema.layers.id, queueLayerIds))

	const present = new Set<M.LayerId>()
	for (const row of rows) {
		present.add(row._id)
		const layerId = row._id
		for (const key of M.getAllLayerQueueKeysWithLayerId(layerId, queue)) {
			for (const [constraintId, isConstraintBlocked] of Object.entries(row)) {
				if (constraintId === '_id') continue
				if (Number(isConstraintBlocked) === 0) OneToMany.set(blockedState, key, constraintId)
			}
		}
	}

	return { blocked: blockedState, present, violationDescriptors: violationDescriptorsState }
}

function getisBlockedByDoNotRepeatRule(rule: M.DoNotRepeatRule, targetLayerId: M.LayerId, previousLayerIds: M.LayerId[]) {
	const targetLayer = M.getLayerDetailsFromUnvalidated(M.getUnvalidatedLayerFromId(targetLayerId))
	const layerIds = previousLayerIds.slice(0, rule.within)
	const retValue = (v: boolean, descriptors?: string[]) => ({ isBlocked: v, descriptors })
	for (const layerId of layerIds) {
		const layer = M.getLayerDetailsFromUnvalidated(M.getUnvalidatedLayerFromId(layerId))
		switch (rule.field) {
			case 'Level':
			case 'Layer':
				if (layer[rule.field] && targetLayer[rule.field] === layer[rule.field]) return retValue(true)
				break
			case 'Faction': {
				const descriptors: string[] = []
				const layerFactions = [layer.Faction_1, layer.Faction_2].filter(Boolean)
				if (layerFactions.includes(targetLayer.Faction_1)) descriptors.push('Faction_1')
				if (layerFactions.includes(targetLayer.Faction_2)) descriptors.push('Faction_2')
				if (descriptors.length > 0) return retValue(true, descriptors)
				break
			}
			case 'SubFac': {
				const descriptors: string[] = []

				// SubFac can be null instead of undefined indicating a unitless layer, but we just ignore those here
				const layerSubFacs = [layer.SubFac_1, layer.SubFac_2].filter(Boolean)
				if (layerSubFacs.includes(targetLayer.SubFac_1)) descriptors.push('SubFac_1')
				if (layerSubFacs.includes(targetLayer.SubFac_2)) descriptors.push('SubFac_2')
				if (descriptors.length > 0) return retValue(true, descriptors)
				break
			}
			default:
				assertNever(rule.field)
		}
	}
	return retValue(false)
}

function getDoNotRepeatSQLConditions(
	ctx: C.Db,
	rule: M.DoNotRepeatRule,
	previousLayerIds: string[],
) {
	const values = new Set<string>()
	const layerIds = previousLayerIds.slice(0, rule.within)
	if (rule.within <= 0) return sql`1=1`
	for (const layerId of layerIds) {
		const layer = M.getLayerDetailsFromUnvalidated(M.getUnvalidatedLayerFromId(layerId))
		switch (rule.field) {
			case 'Level':
			case 'Layer':
				if (layer[rule.field]) values.add(layer[rule.field]!)
				break
			case 'Faction':
				if (layer.Faction_1) values.add(layer.Faction_1!)
				if (layer.Faction_2) values.add(layer.Faction_2!)
				break
			case 'SubFac':
				// SubFac can be null instead of undefined indicating a unitless layer, but we just ignore those here
				if (layer.SubFac_1) values.add(layer.SubFac_1!)
				if (layer.SubFac_2) values.add(layer.SubFac_2!)
				break
			default:
				assertNever(rule.field)
		}
	}
	const valuesArr = Array.from(values)

	switch (rule.field) {
		case 'Level':
		case 'Layer':
			return E.notInArray(Schema.layers[rule.field], valuesArr)
		case 'Faction':
			return E.and(E.notInArray(Schema.layers.Faction_1, valuesArr), E.notInArray(Schema.layers.Faction_2, valuesArr))
		case 'SubFac':
			return E.and(E.notInArray(Schema.layers.SubFac_1, valuesArr), E.notInArray(Schema.layers.SubFac_2, valuesArr))
	}
}

function hasTeam(
	faction: string | null | typeof Schema.layers.Faction_1 = null,
	subfaction: M.Subfaction | null | typeof Schema.layers.SubFac_1 = null,
) {
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
		E.and(E.eq(Schema.layers.Faction_2, faction), E.eq(Schema.layers.SubFac_2, subfaction)),
	)!
}

/**
 * @param constraints The constraints to apply
 * @param previousLayerIds Other IDs which should be considered as being at the front of the history
 */
function resolveRelevantLayerHistory(ctx: C.Db, constraints: M.LayerQueryConstraint[], queueLength: number) {
	const maxHistoryLookback = Math.max(...constraints.map(c => c.type === 'do-not-repeat' ? c.rule.within : -1))
	return MatchHistory.state.recentMatches.slice(0, maxHistoryLookback - queueLength).map(match => match.layerId)
}

async function getFilterEntity(filterId: string, ctx: C.Db) {
	const [filter] = await ctx.db().select().from(Schema.filters).where(E.eq(Schema.filters.id, filterId))
	return filter as Schema.Filter | undefined
}

export const layersRouter = router({
	selectLayers: procedure.input(LayersQueryInputSchema).query(queryLayers),
	selectLayersGroupedBy: procedure.input(LayersQueryGroupedByInputSchema).query(queryLayersGroupedBy),
	layerExists: procedure.input(LayerExistsInputSchema).query(layerExists),
	getLayerStatusesForLayerQueue: procedure.input(LayerStatusesForLayerQueueInputSchema).query(getLayerStatusesForLayerQueue),
})
