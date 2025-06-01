import * as Schema from '$root/drizzle/schema.ts'
import * as Arr from '@/lib/array'
import * as FB from '@/lib/filter-builders'
import * as Obj from '@/lib/object'
import * as OneToMany from '@/lib/one-to-many-map'
import { weightedRandomSelection } from '@/lib/random'
import * as SM from '@/lib/rcon/squad-models'
import { assertNever } from '@/lib/typeGuards'
import * as M from '@/models.ts'
import * as C from '@/server/context'
import * as MatchHistory from '@/server/systems/match-history'
import { procedure, router } from '@/server/trpc.server.ts'
import * as Otel from '@opentelemetry/api'
import { TRPCError } from '@trpc/server'
import { count, SQL, sql } from 'drizzle-orm'
import * as E from 'drizzle-orm/expressions'
import { z } from 'zod'
import { CONFIG } from '../config'

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
	constraints: z.array(M.LayerQueryConstraintSchema).optional(),
	historyOffset: z
		.number()
		.int()
		.min(0)
		.optional()
		.describe(
			'Offset of history entries to consider for DNR rules, where 0 is current layer, 1 is the previous layer, etc',
		),
	previousLayerIds: z
		.array(M.LayerIdSchema)
		.optional()
		.describe(
			'Layer Ids to be considered as part of the history for DNR rules',
		),
})

export type LayersQueryInput = z.infer<typeof LayersQueryInputSchema>

const tracer = Otel.trace.getTracer('layer-queries')
export type QueriedLayer = {
	layers: M.Layer & { constraints: boolean[] }
	totalCount: number
}

export async function queryLayers(args: {
	input: LayersQueryInput
	ctx: C.Log & C.Db
}) {
	const { ctx, input: input } = args
	input.pageSize ??= 100
	input.pageIndex ??= 0
	if (input.sort && input.sort.type === 'random') {
		const { layers, totalCount } = await getRandomGeneratedLayers(
			ctx,
			input.pageSize,
			input.constraints ?? [],
			input.previousLayerIds ?? [],
			true,
		)
		return { code: 'ok' as const, layers, totalCount, pageCount: 1 }
	}
	const constraints = input.constraints ?? []

	const { historicLayers, oldestLayerTeamParity } = resolveRelevantLayerHistory(
		ctx,
		constraints,
		input.previousLayerIds ?? [],
		input.historyOffset,
	)
	const { conditions: whereConditions, selectProperties } = await buildConstraintSqlCondition(
		ctx,
		historicLayers,
		oldestLayerTeamParity,
		input.constraints ?? [],
	)

	const includeWhere = (query: any) => {
		if (whereConditions.length > 0) {
			return query.where(E.and(...whereConditions))
		}
		return query
	}

	let query: any = ctx
		.db()
		.select({ ...Schema.layers, ...selectProperties })
		.from(Schema.layers)
	query = includeWhere(query)

	if (input.sort) {
		switch (input.sort.type) {
			case 'column':
				query = query.orderBy(
					input.sort.sortDirection === 'ASC'
						? E.asc(Schema.layers[input.sort.sortBy])
						: E.desc(Schema.layers[input.sort.sortBy]),
				)
				break
			default:
				assertNever(input.sort)
		}
	}
	query = query.offset(input.pageIndex * input.pageSize).limit(input.pageSize)

	let countQuery = ctx
		.db()
		.select({ count: sql<string>`count(*)` })
		.from(Schema.layers)
	countQuery = includeWhere(countQuery)

	const [layers, [countResult]] = await Promise.all(
		[
			query.then((rows: any[]) => postProcessLayers(rows, constraints, historicLayers, oldestLayerTeamParity)),
			countQuery,
		] as const,
	)
	const totalCount = Number(countResult.count)

	return {
		code: 'ok' as const,
		layers: layers as PostProcessedLayers[],
		totalCount,
		pageCount: Math.ceil(totalCount / input.pageSize),
	}
}

export const AreLayersInPoolInputSchema = z.object({
	layers: z.array(M.LayerIdSchema),
})

export const LayerExistsInputSchema = z.array(M.LayerIdSchema)
export type LayerExistsInput = M.LayerId[]

export async function layerExists({
	input,
	ctx,
}: {
	input: LayerExistsInput
	ctx: C.Log & C.Db
}) {
	const results = await ctx
		.db()
		.select({ id: Schema.layers.id })
		.from(Schema.layers)
		.where(E.inArray(Schema.layers.id, input))
	const existsMap = new Map(results.map((result) => [result.id, true]))

	return {
		code: 'ok' as const,
		results: input.map((id) => ({
			id,
			exists: existsMap.has(id),
		})),
	}
}

export const QueryLayerComponentsSchema = z.object({
	constraints: z.array(M.LayerQueryConstraintSchema).optional(),
	previousLayerIds: z.array(M.LayerIdSchema).default([]),
})

export type LayersQueryGroupedByInput = z.infer<
	typeof QueryLayerComponentsSchema
>
export async function queryLayerComponents({
	ctx,
	input,
}: {
	ctx: C.Log & C.Db
	input: LayersQueryGroupedByInput
}) {
	const constraints = input.constraints ?? []
	const { historicLayers, oldestLayerTeamParity } = resolveRelevantLayerHistory(
		ctx,
		constraints,
		input.previousLayerIds,
	)
	const { conditions: whereConditions } = await buildConstraintSqlCondition(ctx, historicLayers, oldestLayerTeamParity, constraints)

	const res = Object.fromEntries(
		await Promise.all(M.GROUP_BY_COLUMNS.map(
			async (column) => {
				const res =
					(await ctx.db().selectDistinct({ [column]: Schema.layers[column] }).from(Schema.layers).where(E.and(...whereConditions)))
						.map((row) => row[column])
				return [column, res]
			},
		)),
	)

	return res as Record<M.GroupByColumn, string[]>
}

export const SearchIdsInputSchema = z.object({
	queryString: z.string().min(1).max(100),
	constraints: z.array(M.LayerQueryConstraintSchema).optional(),
	previousLayerIds: z.array(z.string()).optional(),
})
export type SearchIdsInput = z.infer<typeof SearchIdsInputSchema>

export async function searchIds({ ctx, input }: { ctx: C.Log & C.Db; input: SearchIdsInput }) {
	const { queryString, constraints, previousLayerIds } = input

	const { historicLayers, oldestLayerTeamParity } = resolveRelevantLayerHistory(
		ctx,
		constraints ?? [],
		previousLayerIds ?? [],
	)

	const { conditions: whereConditions } = await buildConstraintSqlCondition(
		ctx,
		historicLayers,
		oldestLayerTeamParity,
		constraints ?? [],
	)

	const results = await ctx
		.db()
		.select({ id: Schema.layers.id })
		.from(Schema.layers)
		.where(E.and(E.like(Schema.layers.id, `%${queryString}%`), ...whereConditions))
		.limit(15)

	return {
		code: 'ok' as const,
		ids: results.map(r => r.id),
	}
}

export async function getConstraintSQLConditions(
	ctx: C.Log & C.Db,
	constraint: M.LayerQueryConstraint,
	previousLayerIds: [M.LayerId, M.ViolationReasonItem | undefined][],
	teamParity: number,
) {
	switch (constraint.type) {
		case 'filter-anon':
			return await getFilterNodeSQLConditions(ctx, constraint.filter, [])
		case 'filter-entity':
			return await getFilterNodeSQLConditions(
				ctx,
				FB.applyFilter(constraint.filterEntityId),
				[],
			)
		case 'do-not-repeat':
			return getDoNotRepeatSQLConditions(
				constraint.rule,
				previousLayerIds,
				teamParity,
			)
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
				if (
					comp.column !== 'SubFacMatchup'
					&& new Set(comp.values).size !== comp.values.length
				) {
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
						conditions.push(hasTeam(faction, subfac))
					}
					res = E.and(...conditions)!
					break
				}
				if (comp.column === 'SubFacMatchup') {
					if (comp.values[0] === comp.values[1]) {
						const value = comp.values[0]
						return E.and(
							E.eq(Schema.layers.Unit_1, value),
							E.eq(Schema.layers.Unit_2, value),
						)!
					}
					const conditions: SQL[] = []
					for (const subfaction of comp.values) {
						conditions.push(hasTeam(null, subfaction))
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
		res = await getFilterNodeSQLConditions(ctx, filter, [
			...reentrantFilterIds,
			node.filterId,
		])
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

async function buildConstraintSqlCondition(
	ctx: C.Log & C.Db,
	previousLayerIds: [M.LayerId, M.ViolationReasonItem | undefined][],
	oldestLayerTeamParity: number,
	constraints: M.LayerQueryConstraint[],
) {
	const conditions: SQL<unknown>[] = []
	const selectProperties: any = {}
	const constraintBuildingTasks: Promise<any>[] = []

	for (let i = 0; i < constraints.length; i++) {
		const constraint = constraints[i]
		constraintBuildingTasks.push(
			C.spanOp(
				'layer-queries:build-constraint-sql-condition',
				{ tracer },
				async () => {
					C.setSpanOpAttrs({
						constraintName: constraint.name,
						constraintIndex: i,
						constraintType: constraint.type,
						constraintApplyAs: constraint.applyAs,
					})
					const condition = await getConstraintSQLConditions(
						ctx,
						constraint,
						previousLayerIds,
						oldestLayerTeamParity,
					)
					if (!condition) {
						return {
							code: 'err:no-constraint' as const,
							msg: 'No constraint found',
						}
					}
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
				},
			)(),
		)
	}
	await Promise.all(constraintBuildingTasks)
	return { conditions, selectProperties }
}

export const LayerStatusesForLayerQueueInputSchema = z.object({
	queue: M.LayerListSchema,
	pool: M.PoolConfigurationSchema,
})
export type LayerStatusesForLayerQueueInput = z.infer<
	typeof LayerStatusesForLayerQueueInputSchema
>

export async function getLayerStatusesForLayerQueue({
	ctx,
	input: { queue, pool },
}: {
	ctx: C.Db & C.Log
	input: LayerStatusesForLayerQueueInput
}) {
	const constraints = M.getPoolConstraints(pool)

	// eslint-disable-next-line prefer-const
	let { historicLayers, oldestLayerTeamParity } = resolveRelevantLayerHistory(
		ctx,
		constraints,
		[],
	)
	const blockedState: OneToMany.OneToManyMap<string, string> = new Map()
	const violationDescriptorsState = new Map<
		string,
		M.ViolationDescriptor[]
	>()
	const filterConditions: Map<string, Promise<SQL<unknown>>> = new Map()
	for (let i = 0; i < queue.length; i++) {
		const item = queue[i]
		for (
			const [queuedLayerKey, layerId] of M.getAllLayerIdsWithQueueKey(
				item,
			)
		) {
			const violationDescriptors: M.ViolationDescriptor[] = []
			for (const constraint of constraints) {
				switch (constraint.type) {
					case 'do-not-repeat': {
						const { isBlocked, descriptors } = getisBlockedByDoNotRepeatRuleDirect(
							constraint.id,
							constraint.rule,
							layerId,
							historicLayers,
							oldestLayerTeamParity,
						)
						if (!isBlocked) break
						OneToMany.set(blockedState, queuedLayerKey, constraint.id)
						if (descriptors) violationDescriptors.push(...descriptors)
						break
					}
					case 'filter-anon':
						filterConditions.set(
							constraint.id,
							getFilterNodeSQLConditions(ctx, constraint.filter, []),
						)
						break
					case 'filter-entity': {
						filterConditions.set(
							constraint.id,
							getFilterNodeSQLConditions(
								ctx,
								FB.applyFilter(constraint.filterEntityId),
								[],
							),
						)
						break
					}
				}
			}
			violationDescriptorsState.set(queuedLayerKey, violationDescriptors)
		}
		if (item.layerId) {
			historicLayers.push([item.layerId, { type: 'layer-list-item', layerListItemId: item.itemId }])
		}
	}

	const queueLayerIds = M.getAllLayerIdsFromList(queue)

	const selectExpr: any = { _id: Schema.layers.id }
	for (const [id, task] of filterConditions.entries()) {
		// we'll fix this if it happens but unlikely
		if (id === '_id') throw new Error('unexpected id for filter constraint')
		selectExpr[id] = await task
	}

	const rows = await ctx
		.db()
		.select(selectExpr)
		.from(Schema.layers)
		.where(E.inArray(Schema.layers.id, queueLayerIds))

	const present = new Set<M.LayerId>()
	for (const row of rows) {
		present.add(row._id)
		const layerId = row._id
		for (const key of M.getAllLayerQueueKeysWithLayerId(layerId, queue)) {
			for (const [constraintId, isConstraintBlocked] of Object.entries(row)) {
				if (constraintId === '_id') continue
				if (Number(isConstraintBlocked) === 0) {
					OneToMany.set(blockedState, key, constraintId)
				}
			}
		}
	}

	return {
		blocked: blockedState,
		present,
		violationDescriptors: violationDescriptorsState,
	}
}

function getisBlockedByDoNotRepeatRuleDirect(
	constraintId: string,
	rule: M.RepeatRule,
	targetLayerId: M.LayerId,
	previousLayerIds: [M.LayerId, M.ViolationReasonItem | undefined][],
	oldestPrevLayerTeamParity: number,
) {
	const targetLayer = M.getLayerDetailsFromUnvalidated(
		M.getUnvalidatedLayerFromId(targetLayerId),
	)
	const targetLayerTeamParity = SM.getTeamParityForOffset({ ordinal: oldestPrevLayerTeamParity }, previousLayerIds.length)

	let isBlocked = false
	const descriptors: M.ViolationDescriptor[] = []
	for (let i = previousLayerIds.length - 1; i >= Math.max(previousLayerIds.length - rule.within, 0); i--) {
		let layerTeamParity = SM.getTeamParityForOffset({ ordinal: oldestPrevLayerTeamParity }, i)
		const getViolationDescriptor = (field: M.ViolationDescriptor['field']): M.ViolationDescriptor => ({
			constraintId,
			type: 'repeat-rule',
			field: field,
			reasonItem: previousLayerIds[i][1],
		})
		const layerId = previousLayerIds[i][0]
		const layer = M.getLayerDetailsFromUnvalidated(
			M.getUnvalidatedLayerFromId(layerId),
		)
		switch (rule.field) {
			case 'Map':
			case 'Gamemode':
			case 'Layer':
			case 'Size':
				if (
					layer[rule.field]
					&& targetLayer[rule.field] === layer[rule.field]
					&& (rule.targetValues?.includes(layer[rule.field] as string) ?? true)
				) {
					descriptors.push(getViolationDescriptor(rule.field))
					isBlocked = true
				}
				break
			case 'Faction': {
				const checkFaction = (team: 'A' | 'B') => {
					const targetFaction = targetLayer[M.getTeamNormalizedFactionProp(targetLayerTeamParity, team)]!
					if (
						targetFaction
						&& layer[M.getTeamNormalizedFactionProp(layerTeamParity, team)]
							=== targetFaction
						&& (rule.targetValues?.includes(targetFaction) ?? true)
					) {
						descriptors.push(getViolationDescriptor(`Faction_${team}`))
						isBlocked = true
					}
				}
				checkFaction('A')
				checkFaction('B')
				break
			}
			case 'FactionAndUnit': {
				const checkFactionAndUnit = (team: 'A' | 'B') => {
					const targetFaction = targetLayer[M.getTeamNormalizedFactionProp(targetLayerTeamParity, team)]!
					const targetUnit = targetLayer[M.getTeamNormalizedUnitProp(targetLayerTeamParity, team)]
					const targetFactionAndUnit = M.getFactionAndUnitValue(
						targetFaction,
						targetUnit,
					)

					const faction = layer[M.getTeamNormalizedFactionProp(layerTeamParity, team)]
					const unit = layer[M.getTeamNormalizedUnitProp(layerTeamParity, team)]

					if (targetFaction && faction) {
						const factionAndUnit = M.getFactionAndUnitValue(faction, unit)
						if (
							factionAndUnit === targetFactionAndUnit
							&& (rule.targetValues?.includes(factionAndUnit) ?? true)
						) {
							descriptors.push(getViolationDescriptor(`FactionAndUnit_${team}`))
							isBlocked = true
						}
					}
				}

				checkFactionAndUnit('A')
				checkFactionAndUnit('B')
				break
			}
			case 'Alliance': {
				const checkAlliance = (team: 'A' | 'B') => {
					const targetFaction = layer[M.getTeamNormalizedFactionProp(layerTeamParity, team)]
					if (!targetFaction) return
					const targetAlliance = M.StaticLayerComponents.factionToAlliance[targetFaction]
					if (!targetAlliance) return
					const faction = M.getTeamNormalizedFactionProp(layerTeamParity, team)
					if (!faction) return
					const alliance = M.StaticLayerComponents.factionToAlliance[faction]
					if (!alliance) return
					if (targetAlliance === alliance && (rule.targetValues?.includes(targetAlliance) ?? true)) {
						descriptors.push(getViolationDescriptor(`Alliance_${team}`))
						isBlocked = true
					}
				}

				checkAlliance('A')
				checkAlliance('B')
				break
			}
			default:
				assertNever(rule.field)
		}
		layerTeamParity--
	}
	return { isBlocked, descriptors }
}

function getDoNotRepeatSQLConditions(
	rule: M.RepeatRule,
	previousLayerIds: [M.LayerId, M.ViolationReasonItem | undefined][],
	oldestLayerTeamParity: number,
) {
	const values = new Set<string>()
	if (rule.within <= 0) return sql`1=1`

	let teamParity = SM.getTeamParityForOffset({ ordinal: oldestLayerTeamParity }, previousLayerIds.length - 1)
	for (let i = previousLayerIds.length - 1; i >= Math.max(previousLayerIds.length - rule.within, 0); i--) {
		const layer = M.getLayerDetailsFromUnvalidated(
			M.getUnvalidatedLayerFromId(previousLayerIds[i][0]),
		)
		switch (rule.field) {
			case 'Map':
			case 'Gamemode':
			case 'Size':
			case 'Layer':
				if (
					layer[rule.field]
					&& (rule.targetValues?.includes(layer[rule.field]!) ?? true)
				) {
					values.add(layer[rule.field]!)
				}
				break
			case 'Faction': {
				const addApplicable = (team: 'A' | 'B') => {
					const value = layer[M.getTeamNormalizedFactionProp(teamParity, team)]
					if (value && (rule.targetValues?.includes(value) ?? true)) {
						values.add(team + ':' + value)
					}
				}
				addApplicable('A')
				addApplicable('B')
				break
			}
			case 'FactionAndUnit': {
				const addApplicable = (team: 'A' | 'B') => {
					const faction = layer[M.getTeamNormalizedFactionProp(teamParity, team)]
					if (!faction) return
					const subFac = layer[M.getTeamNormalizedUnitProp(teamParity, team)]
					const factionAndUnit = M.getFactionAndUnitValue(faction, subFac)
					if (
						factionAndUnit
						&& (rule.targetValues?.includes(factionAndUnit) ?? true)
					) {
						values.add(team + ':' + factionAndUnit)
					}
				}
				addApplicable('A')
				addApplicable('B')
				break
			}
			case 'Alliance': {
				const addApplicable = (team: 'A' | 'B') => {
					const faction = layer[M.getTeamNormalizedFactionProp(teamParity, team)]
					if (!faction) return
					const alliance = M.StaticLayerComponents.factionToAlliance[faction]
					if (!alliance) return
					if (rule.targetValues?.includes(alliance) ?? true) {
						values.add(team + ':' + alliance)
					}
				}
				addApplicable('A')
				addApplicable('B')
				break
			}
			default:
				assertNever(rule.field)
		}
		teamParity = (teamParity - 1) % 2
	}

	const valuesArr = Array.from(values)
	if (valuesArr.length === 0) {
		return sql`1=1`
	}

	const targetLayerTeamParity = SM.getTeamParityForOffset({ ordinal: oldestLayerTeamParity }, previousLayerIds.length)
	switch (rule.field) {
		case 'Map':
		case 'Gamemode':
		case 'Size':
		case 'Layer':
			return E.notInArray(Schema.layers[rule.field], valuesArr)
		case 'Faction': {
			const valuesArrA = valuesArr
				.filter((v) => v.startsWith('A:'))
				.map((v) => v.slice(2))
			const valuesArrB = valuesArr
				.filter((v) => v.startsWith('B:'))
				.map((v) => v.slice(2))
			return E.and(
				E.notInArray(
					Schema.layers[M.getTeamNormalizedFactionProp(targetLayerTeamParity, 'A')],
					valuesArrA,
				),
				E.notInArray(
					Schema.layers[M.getTeamNormalizedFactionProp(targetLayerTeamParity, 'B')],
					valuesArrB,
				),
			)
		}
		case 'FactionAndUnit': {
			const getExpr = (team: 'A' | 'B') =>
				sql`CONCAT(${Schema.layers[M.getTeamNormalizedFactionProp(oldestLayerTeamParity, team)]}, '_', ${
					Schema.layers[M.getTeamNormalizedUnitProp(oldestLayerTeamParity, team)]
				})`

			const factionAndUnitExpressionA = getExpr('A')
			const valuesArrA = valuesArr
				.filter((v) => v.startsWith('A:'))
				.map((v) => v.slice(2))

			const factionAndUnitExpressionB = getExpr('B')
			const valuesArrB = valuesArr
				.filter((v) => v.startsWith('B:'))
				.map((v) => v.slice(2))

			return E.and(
				E.notInArray(factionAndUnitExpressionA, valuesArrA),
				E.notInArray(factionAndUnitExpressionB, valuesArrB),
			)
		}
		case 'Alliance': {
			const getAllianceExpr = (team: 'A' | 'B') => {
				const factionColumn = Schema.layers[M.getTeamNormalizedFactionProp(targetLayerTeamParity, team)]
				// Create a CASE expression to map factions to alliances
				const allianceMapping = Object.entries(M.StaticLayerComponents.factionToAlliance)
					.map(([faction, alliance]) => `WHEN ${factionColumn.name} = '${faction}' THEN '${alliance}'`)
					.join(' ')
				return sql`CASE ${allianceMapping} END`
			}

			const allianceExpressionA = getAllianceExpr('A')
			const valuesArrA = valuesArr
				.filter((v) => v.startsWith('A:'))
				.map((v) => v.slice(2))

			const allianceExpressionB = getAllianceExpr('B')
			const valuesArrB = valuesArr
				.filter((v) => v.startsWith('B:'))
				.map((v) => v.slice(2))

			return E.and(
				E.notInArray(allianceExpressionA, valuesArrA),
				E.notInArray(allianceExpressionB, valuesArrB),
			)
		}
		default:
			assertNever(rule.field)
	}
}

export async function getRandomGeneratedLayers<ReturnLayers extends boolean>(
	ctx: C.Log & C.Db,
	number: number,
	constraints: M.LayerQueryConstraint[],
	previousLayerIds: string[],
	returnLayers: ReturnLayers,
): Promise<ReturnLayers extends true ? { layers: PostProcessedLayers[]; totalCount: number } : { ids: string[]; totalCount: number }> {
	const { historicLayers, oldestLayerTeamParity } = resolveRelevantLayerHistory(
		ctx,
		constraints,
		previousLayerIds,
	)
	const { conditions, selectProperties } = await buildConstraintSqlCondition(
		ctx,
		historicLayers,
		oldestLayerTeamParity,
		constraints,
	)
	const p_condition = conditions.length > 0 ? E.and(...conditions) : sql`1=1`

	const colOrderRowsPromise = ctx.db().select({ columnName: Schema.genLayerColumnOrder.columnName }).from(Schema.genLayerColumnOrder)
		.orderBy(E.asc(Schema.genLayerColumnOrder.ordinal)).execute()
	const totalCountPromise = ctx.db().select({ totalCount: count() }).from(Schema.layers).where(p_condition).execute()
	const allWeightsPromise = ctx.db().select().from(Schema.genLayerWeights).execute()

	const colOrderRows = await colOrderRowsPromise
	const orderedColumns = colOrderRows.map(row => row.columnName).filter(colName =>
		(M.WEIGHT_COLUMNS as unknown as string[]).includes(colName)
	) as [M.WeightColumn, ...M.WeightColumn[]]

	const baseLayerPoolPromise = ctx.db().select(
		Obj.selectProps(Schema.layers, [...orderedColumns, 'id'] as [M.WeightColumn, ...M.WeightColumn[], 'id']),
	).from(Schema.layers).where(p_condition).limit(CONFIG.layerGenerationMaxBasePoolSizePerItem * number).orderBy(E.asc(sql`rand()`))
		.execute()

	const totalCountResult = await totalCountPromise
	const totalCount = Number(totalCountResult[0].totalCount)
	const baseLayerPool = await baseLayerPoolPromise
	const allWeights = await allWeightsPromise

	if (baseLayerPool.length === 0) {
		// @ts-expect-error idgaf
		if (returnLayers) return { layers: [], totalCount } as { layers: PostProcessedLayers[]; totalCount: number }
		// @ts-expect-error idgaf
		return { ids: [], totalCount: 0 } as { ids: string[]; totalCount: number }
	}

	const selected: string[] = []
	for (let i = 0; i < number; i++) {
		let layerPool = baseLayerPool
		for (const columnName of orderedColumns) {
			const weightsForColl = allWeights.filter(w => w.columnName === columnName)
			const values: (string | null)[] = []
			const weights: number[] = []
			const defaultWeight = 1 / values.length
			for (const layer of layerPool) {
				if (values.includes(layer[columnName]) || selected.includes(layer.id)) continue
				values.push(layer[columnName])
				weights.push(weightsForColl.find(w => w.value === layer[columnName])?.weight ?? defaultWeight)
			}
			if (values.length === 0) continue
			const chosen = weightedRandomSelection(values, weights)
			layerPool = layerPool.filter(l => l[columnName] === chosen)
		}
		if (layerPool.length === 0) {
			for (const layer of baseLayerPool) {
				if (!selected.includes(layer.id)) {
					selected.push(layer.id)
				}
			}
		} else {
			selected.push(layerPool[0].id)
		}
	}

	const results = await ctx.db().select({ ...Schema.layers, ...selectProperties }).from(Schema.layers).where(
		E.inArray(Schema.layers.id, selected),
	).orderBy(sql`rand()`)
	if (returnLayers) {
		// @ts-expect-error idgaf
		return {
			layers: postProcessLayers(results as (M.Layer & Record<string, boolean>)[], constraints, historicLayers, oldestLayerTeamParity),
			totalCount,
		}
	}
	// @ts-expect-error idgaf
	return { ids: selected, totalCount }
}

function hasTeam(
	faction: string | null,
	subfaction: string | null,
) {
	if (!faction && !subfaction) {
		throw new Error('At least one of faction or subfaction must be provided')
	}

	if (subfaction === null) {
		return E.or(
			E.eq(Schema.layers.Faction_1, faction!),
			E.eq(Schema.layers.Faction_2, faction!),
		)!
	}
	if (faction === null) {
		return E.or(
			E.eq(Schema.layers.Unit_1, subfaction),
			E.eq(Schema.layers.Unit_2, subfaction),
		)!
	}
	return E.or(
		E.and(
			E.eq(Schema.layers.Faction_1, faction),
			E.eq(Schema.layers.Unit_1, subfaction),
		),
		E.and(
			E.eq(Schema.layers.Faction_2, faction),
			E.eq(Schema.layers.Unit_2, subfaction),
		),
	)!
}

/**
 * @param constraints The constraints to apply
 * @param previousLayerIds Other IDs which should be considered as being at the front of the history, in the order they appear in the queue/list
 */
function resolveRelevantLayerHistory(
	ctx: C.Db & C.Log,
	constraints: M.LayerQueryConstraint[],
	previousLayerIds: ([M.LayerId, M.ViolationReasonItem | undefined] | M.LayerId)[],
	startWithOffset?: number,
) {
	const historicMatches = MatchHistory.state.recentMatches.slice(0, MatchHistory.state.recentMatches.length - (startWithOffset ?? 0))
	const historicLayers: [string, M.ViolationReasonItem | undefined][] = []
	for (const match of historicMatches) {
		const details = M.getLayerDetailsFromUnvalidated(M.getUnvalidatedLayerFromId(match.layerId))
		// don't consider jensens or seeding layers
		if (details.Layer?.includes('Jensens') || details.Gamemode && Arr.includes(['Training', 'Seed'], details.Gamemode)) break
		historicLayers.push([match.layerId, { type: 'history-entry', historyEntryId: match.historyEntryId }])
	}
	for (const entry of previousLayerIds) {
		if (typeof entry === 'string') historicLayers.push([entry, undefined])
		else historicLayers.push(entry)
	}
	return {
		historicLayers,
		oldestLayerTeamParity: (historicMatches?.[0]?.ordinal ?? 0) % 2,
	}
}

type PostProcessedLayers = Awaited<
	ReturnType<typeof postProcessLayers>
>[number]
function postProcessLayers(
	layers: (M.Layer & Record<string, boolean>)[],
	constraints: M.LayerQueryConstraint[],
	historicLayers: [M.LayerId, M.ViolationReasonItem | undefined][],
	oldestLayerTeamParity: number,
) {
	return layers.map((layer) => {
		// default to true because missing means the constraint is applied via a where condition
		const constraintResults: boolean[] = Array(constraints.length).fill(true)
		const violationDescriptors: M.ViolationDescriptor[] = []
		for (const key of Object.keys(layer)) {
			const groups = key.match(/^constraint_(\d+)$/)
			if (!groups) continue
			const idx = Number(groups[1])
			constraintResults[idx] = Number(layer[key as keyof M.Layer]) === 1
			const constraint = constraints[idx]
			if (constraint.type === 'do-not-repeat') {
				// TODO being able to do this makes the SQL conditions we made for the dnr rules redundant, we should remove them
				const { isBlocked, descriptors } = getisBlockedByDoNotRepeatRuleDirect(
					constraint.id,
					constraint.rule,
					layer.id,
					historicLayers,
					oldestLayerTeamParity,
				)
				if (isBlocked) constraintResults[idx] = false
				if (descriptors && descriptors.length > 0) {
					violationDescriptors.push(...descriptors)
				}
			}
		}
		return {
			...M.includeComputedCollections(layer),
			constraints: constraintResults,
			violationDescriptors,
		}
	})
}

async function getFilterEntity(filterId: string, ctx: C.Db) {
	const [filter] = await ctx
		.db()
		.select()
		.from(Schema.filters)
		.where(E.eq(Schema.filters.id, filterId))
	return filter as Schema.Filter | undefined
}

export const layersRouter = router({
	queryLayers: procedure.input(LayersQueryInputSchema).query(queryLayers),
	queryLayerComponents: procedure
		.input(QueryLayerComponentsSchema)
		.query(queryLayerComponents),
	searchIds: procedure.input(SearchIdsInputSchema).query(searchIds),
	layerExists: procedure.input(LayerExistsInputSchema).query(layerExists),
	getLayerStatusesForLayerQueue: procedure
		.input(LayerStatusesForLayerQueueInputSchema)
		.query(getLayerStatusesForLayerQueue),
})
