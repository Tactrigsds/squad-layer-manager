import * as Arr from '@/lib/array'
import * as Obj from '@/lib/object'
import * as OneToMany from '@/lib/one-to-many-map'
import { weightedRandomSelection } from '@/lib/random'
import { assertNever, isNullOrUndef } from '@/lib/type-guards'
import * as CS from '@/models/context-shared'
import * as FB from '@/models/filter-builders'
import * as F from '@/models/filter.models'
import * as L from '@/models/layer'
import * as LC from '@/models/layer-columns'
import * as LL from '@/models/layer-list.models'
import * as LQY from '@/models/layer-queries.models'
import * as MH from '@/models/match-history.models'
import * as SS from '@/models/server-state.models'
import { count, SQL, sql } from 'drizzle-orm'
import * as E from 'drizzle-orm/expressions'
import { z } from 'zod'

export const LayersQuerySortSchema = z
	.discriminatedUnion('type', [
		z.object({
			type: z.literal('column'),
			sortBy: z.string(),
			sortDirection: z.enum(['ASC', 'DESC']).optional().default('ASC'),
		}),
		z.object({
			type: z.literal('random'),
			seed: z.number().int().positive(),
		}),
	])
	.describe('if not provided, no sorting will be done')

export type QueriedLayer = {
	layers: L.KnownLayer & { constraints: boolean[] }
	totalCount: number
}

export async function queryLayers(args: {
	input: LQY.LayersQueryInput
	ctx: CS.LayerQuery
}) {
	const ctx = args.ctx
	let input = args.input
	input = { ...input }
	input.pageSize ??= 100
	input.pageIndex ??= 0
	input.previousLayerIds ??= []
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
		.layerDb()
		.select({ ...LC.selectAllViewCols(ctx), ...selectProperties })
		.from(LC.layersView(ctx))
	query = includeWhere(query)

	if (input.sort) {
		switch (input.sort.type) {
			case 'column':
				query = query.orderBy(
					input.sort.sortDirection === 'ASC'
						? E.asc(LC.viewCol(input.sort.sortBy, ctx))
						: E.desc(LC.viewCol(input.sort.sortBy, ctx)),
				)
				break
			default:
				assertNever(input.sort)
		}
	}
	query = query.offset(input.pageIndex * input.pageSize).limit(input.pageSize)

	let countQuery = ctx
		.layerDb()
		.select({ count: sql<string>`count(*)` })
		.from(LC.layersView(ctx))
	countQuery = includeWhere(countQuery)

	const queryPromise = query.execute().then(convertQueryOutput)
	const rows = await queryPromise
	const layers = postProcessLayers(ctx, rows, constraints, historicLayers, oldestLayerTeamParity)
	const [countResult] = await countQuery.execute()
	const totalCount = Number(countResult.count)
	return {
		code: 'ok' as const,
		layers: layers,
		totalCount,
		pageCount: Math.ceil(totalCount / input.pageSize),
	}
}

export const AreLayersInPoolInputSchema = z.object({ layers: z.array(L.LayerIdSchema) })

export const LayerExistsInputSchema = z.array(L.LayerIdSchema)
export type LayerExistsInput = L.LayerId[]

export async function layerExists({
	input,
	ctx,
}: {
	input: LayerExistsInput
	ctx: CS.LayerQuery
}) {
	const results = convertQueryOutput(
		await ctx
			.layerDb()
			.select(LC.selectViewCols(['id'], ctx))
			.from(LC.layersView(ctx))
			.where(E.inArray(LC.layers.id, LC.packLayers(input))),
	)
	const existsMap = new Map(results.map((result) => [result.id, true]))

	return {
		code: 'ok' as const,
		results: input.map((id) => ({
			id,
			exists: existsMap.has(id),
		})),
	}
}

export async function queryLayerComponents({
	ctx,
	input,
}: {
	ctx: CS.LayerQuery
	input: LQY.LayerComponentsInput
}) {
	input = { ...input }
	const constraints = input.constraints ?? []
	const { historicLayers, oldestLayerTeamParity } = resolveRelevantLayerHistory(
		ctx,
		input.previousLayerIds ?? [],
	)
	const { conditions: whereConditions } = await buildConstraintSqlCondition(ctx, historicLayers, oldestLayerTeamParity, constraints)

	const res = Object.fromEntries(
		await Promise.all(LC.GROUP_BY_COLUMNS.map(
			async (column) => {
				const res = convertQueryOutput(
					await ctx.layerDb().selectDistinct({ [column]: LC.layers[column] })
						.from(LC.layersView(ctx))
						.where(E.and(...whereConditions)),
				)
					.map((row: any) => row[column])
				return [column, res]
			},
		)),
	)

	return res as Record<LC.GroupByColumn, string[]>
}

export const SearchIdsInputSchema = z.object({
	queryString: z.string().min(1).max(100),
	constraints: z.array(LQY.LayerQueryConstraintSchema).optional(),
	previousLayerIds: z.array(z.string()).optional(),
})
export type SearchIdsInput = z.infer<typeof SearchIdsInputSchema>

export async function searchIds({ ctx: ctx, input }: { ctx: CS.LayerQuery; input: SearchIdsInput }) {
	const { queryString, constraints, previousLayerIds } = input

	const { historicLayers, oldestLayerTeamParity } = resolveRelevantLayerHistory(
		ctx,
		previousLayerIds ?? [],
	)

	const { conditions: whereConditions } = await buildConstraintSqlCondition(
		ctx,
		historicLayers,
		oldestLayerTeamParity,
		constraints ?? [],
	)

	const results = convertQueryOutput(
		await ctx
			.layerDb()
			.select({ id: LC.layerStrIds.idStr })
			.from(LC.layerStrIds)
			.where(E.and(E.like(LC.layerStrIds.idStr, `%${queryString}%`), ...whereConditions))
			.limit(15),
	)

	return {
		code: 'ok' as const,
		ids: results.map(r => r.id),
	}
}

export async function getConstraintSQLConditions(
	ctx: CS.Log & CS.Layers & CS.Filters,
	constraint: LQY.LayerQueryConstraint,
	previousLayerIds: [L.LayerId, LQY.ViolationReasonItem | undefined][],
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
				ctx,
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
	ctx: CS.Log & CS.Filters & CS.Layers,
	node: F.FilterNode,
	reentrantFilterIds: string[],
): Promise<{ code: 'ok'; condition: SQL } | { code: 'err:recursive-filter' | 'err:unknown-filter'; msg: string }> {
	let condition: SQL | undefined
	if (node.type === 'comp') {
		const comp = node.comp!
		const column = LC.viewCol(comp.column, ctx)
		switch (comp.code) {
			case 'eq': {
				condition = E.eq(column, comp.value)!
				break
			}
			case 'in': {
				condition = E.inArray(column, comp.values)!
				break
			}
			case 'like': {
				condition = E.like(column, comp.value)!
				break
			}
			case 'gt': {
				condition = E.gt(column, comp.value)!
				break
			}
			case 'lt': {
				condition = E.lt(column, comp.value)!
				break
			}
			case 'inrange': {
				const [min, max] = [...comp.range].sort((a, b) => a - b)
				condition = E.and(E.gte(column, min), E.lte(column, max))!
				break
			}
			case 'is-true': {
				condition = E.eq(column, true)!
				break
			}
			default:
				assertNever(comp)
		}
	}
	if (node.type === 'apply-filter') {
		if (reentrantFilterIds.includes(node.filterId)) {
			return {
				code: 'err:recursive-filter',
				msg: 'Filter is mutually recursive via filter: ' + node.filterId,
			}
		}
		const entity = ctx.filters.find(fe => fe.id === node.filterId)
		if (!entity) {
			// TODO too lazy to return an error here right now
			return {
				code: 'err:unknown-filter',
				msg: `Filter ${node.filterId} Doesn't exist`,
			}
		}
		const filter = F.FilterNodeSchema.parse(entity.filter)
		const res = await getFilterNodeSQLConditions(ctx, filter, [
			...reentrantFilterIds,
			node.filterId,
		])
		if (res.code !== 'ok') return res
		condition = res.condition
	}

	if (F.isBlockNode(node)) {
		const childConditions: SQL<unknown>[] = []
		const childResults = await Promise.all(
			node.children.map((node) => getFilterNodeSQLConditions(ctx, node, reentrantFilterIds)),
		)
		for (const childResult of childResults) {
			if (childResult.code !== 'ok') return childResult
			childConditions.push(childResult.condition)
		}
		if (node.type === 'and') {
			condition = E.and(...childConditions)!
		} else if (node.type === 'or') {
			condition = E.or(...childConditions)!
		}
	}

	if (node.neg) condition = E.not(condition!)
	return { code: 'ok' as const, condition: condition! }
}

async function buildConstraintSqlCondition(
	ctx: CS.Log & CS.Filters & CS.Layers,
	previousLayerIds: [L.LayerId, LQY.ViolationReasonItem | undefined][],
	oldestLayerTeamParity: number,
	constraints: LQY.LayerQueryConstraint[],
) {
	const conditions: SQL<unknown>[] = []
	const selectProperties: any = {}
	const constraintBuildingTasks: Promise<any>[] = []

	for (let i = 0; i < constraints.length; i++) {
		const constraint = constraints[i]
		constraintBuildingTasks.push(
			(async () => {
				const res = await getConstraintSQLConditions(
					ctx,
					constraint,
					previousLayerIds,
					oldestLayerTeamParity,
				)
				if (res.code !== 'ok') {
					return res
				}
				switch (constraint.applyAs) {
					case 'field':
						selectProperties[`constraint_${i}`] = res.condition
						break
					case 'where-condition':
						conditions.push(res.condition)
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
	queue: LL.LayerListSchema,
	pool: SS.PoolConfigurationSchema,
})
export type LayerStatusesForLayerQueueInput = z.infer<
	typeof LayerStatusesForLayerQueueInputSchema
>

export async function getLayerStatusesForLayerQueue({
	ctx,
	input: { queue, pool },
}: {
	ctx: CS.LayerQuery
	input: LayerStatusesForLayerQueueInput
}) {
	ctx.log.info('getting layer statuses')
	const constraints = SS.getPoolConstraints(pool)
	// eslint-disable-next-line prefer-const
	let { historicLayers, oldestLayerTeamParity } = resolveRelevantLayerHistory(
		ctx,
		[],
	)
	const blockedState: OneToMany.OneToManyMap<string, string> = new Map()
	const violationDescriptorsState = new Map<
		string,
		LQY.ViolationDescriptor[]
	>()
	const filterConditionResults: Map<string, ReturnType<typeof getFilterNodeSQLConditions>> = new Map()
	for (let i = 0; i < queue.length; i++) {
		const item = queue[i]
		for (
			const [queuedLayerKey, layerId] of LL.getAllLayerIdsWithQueueKey(
				item,
			)
		) {
			const violationDescriptors: LQY.ViolationDescriptor[] = []
			for (const constraint of constraints) {
				switch (constraint.type) {
					case 'do-not-repeat': {
						const { isBlocked, descriptors } = getisBlockedByDoNotRepeatRuleDirect(
							ctx,
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
						filterConditionResults.set(
							constraint.id,
							getFilterNodeSQLConditions(ctx, constraint.filter, []),
						)
						break
					case 'filter-entity': {
						filterConditionResults.set(
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

	const queueLayerIds = LL.getAllLayerIdsFromList(queue)

	const selectExpr: any = { _id: LC.layers.id }
	for (const [id, task] of filterConditionResults.entries()) {
		// we'll fix this if it happens but unlikely
		if (id === '_id') throw new Error('unexpected id for filter constraint')
		const res = await task
		if (res.code !== 'ok') return res
		selectExpr[id] = res.condition
	}

	const rows = convertQueryOutput(
		await ctx
			.layerDb()
			.select(selectExpr)
			.from(LC.layersView(ctx))
			.where(E.inArray(LC.layers.id, LC.packLayers(queueLayerIds))),
	)

	const present = new Set<L.LayerId>()
	for (const row of rows) {
		present.add(row._id)
		const layerId = row._id
		for (const key of LL.getAllLayerQueueKeysWithLayerId(layerId, queue)) {
			for (const [constraintId, isConstraintBlocked] of Object.entries(row)) {
				if (constraintId === '_id') continue
				if (Number(isConstraintBlocked) === 0) {
					OneToMany.set(blockedState, key, constraintId)
				}
			}
		}
	}

	return {
		code: 'ok' as const,
		statuses: {
			blocked: blockedState,
			present,
			violationDescriptors: violationDescriptorsState,
		},
	}
}

function getisBlockedByDoNotRepeatRuleDirect(
	ctx: CS.Log,
	constraintId: string,
	rule: LQY.RepeatRule,
	targetLayerId: L.LayerId,
	previousLayerIds: [L.LayerId, LQY.ViolationReasonItem | undefined][],
	oldestPrevLayerTeamParity: number,
) {
	ctx.log.debug(
		`getisBlockedByDoNotRepeatRuleDirect: Checking rule ${rule.field} for target layer ${targetLayerId}, constraint ${constraintId}`,
	)
	ctx.log.debug(`Rule details: within=${rule.within}, targetValues=${JSON.stringify(rule.targetValues)}`)

	const targetLayer = L.toLayer(targetLayerId)
	const targetLayerTeamParity = MH.getTeamParityForOffset({ ordinal: oldestPrevLayerTeamParity }, previousLayerIds.length)

	ctx.log.debug(`Target layer: ${targetLayer.Layer}, team parity: ${targetLayerTeamParity}`)
	ctx.log.debug(`Checking against ${previousLayerIds.length} previous layers`)

	let isBlocked = false
	const descriptors: LQY.ViolationDescriptor[] = []
	for (let i = previousLayerIds.length - 1; i >= Math.max(previousLayerIds.length - rule.within, 0); i--) {
		let layerTeamParity = MH.getTeamParityForOffset({ ordinal: oldestPrevLayerTeamParity }, i)
		const getViolationDescriptor = (field: LQY.ViolationDescriptor['field']): LQY.ViolationDescriptor => ({
			constraintId,
			type: 'repeat-rule',
			field: field,
			reasonItem: previousLayerIds[i][1],
		})
		const layerId = previousLayerIds[i][0]
		const layer = L.toLayer(layerId)

		ctx.log.debug(`Checking previous layer ${i}: ${layer.Layer} (ID: ${layerId}), team parity: ${layerTeamParity}`)
		switch (rule.field) {
			case 'Map':
			case 'Gamemode':
			case 'Layer':
			case 'Size':
				ctx.log.debug(`Checking ${rule.field}: target=${targetLayer[rule.field]}, previous=${layer[rule.field]}`)
				if (
					layer[rule.field]
					&& targetLayer[rule.field] === layer[rule.field]
					&& (rule.targetValues?.includes(layer[rule.field] as string) ?? true)
				) {
					ctx.log.debug(`VIOLATION: ${rule.field} matches - ${layer[rule.field]}`)
					descriptors.push(getViolationDescriptor(rule.field))
					isBlocked = true
				}
				break
			case 'Faction': {
				const checkFaction = (team: 'A' | 'B') => {
					// TODO: getTeamNormalizedFactionProp is in match-history.models.ts, needs proper import
					const targetFaction = targetLayer[MH.getTeamNormalizedFactionProp(targetLayerTeamParity, team)]!
					const previousFaction = layer[MH.getTeamNormalizedFactionProp(layerTeamParity, team)]
					ctx.log.debug(`Checking Faction team ${team}: target=${targetFaction}, previous=${previousFaction}`)
					if (
						targetFaction
						&& previousFaction === targetFaction
						&& (rule.targetValues?.includes(targetFaction) ?? true)
					) {
						ctx.log.debug(`VIOLATION: Faction team ${team} matches - ${targetFaction}`)
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
					// TODO: getTeamNormalizedFactionProp and getTeamNormalizedUnitProp are in match-history.models.ts, need proper imports
					const targetFaction = targetLayer[MH.getTeamNormalizedFactionProp(targetLayerTeamParity, team)]!
					const targetUnit = targetLayer[MH.getTeamNormalizedUnitProp(targetLayerTeamParity, team)]
					const targetFactionAndUnit = LQY.getFactionAndUnitValue(
						targetFaction,
						targetUnit,
					)

					const faction = layer[MH.getTeamNormalizedFactionProp(layerTeamParity, team)]
					const unit = layer[MH.getTeamNormalizedUnitProp(layerTeamParity, team)]

					ctx.log.debug(
						`Checking FactionAndUnit team ${team}: target=${targetFactionAndUnit}, previous=${
							faction ? LQY.getFactionAndUnitValue(faction, unit) : 'null'
						}`,
					)

					if (targetFaction && faction) {
						const factionAndUnit = LQY.getFactionAndUnitValue(faction, unit)
						if (
							factionAndUnit === targetFactionAndUnit
							&& (rule.targetValues?.includes(factionAndUnit) ?? true)
						) {
							ctx.log.debug(`VIOLATION: FactionAndUnit team ${team} matches - ${factionAndUnit}`)
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
					// TODO: getTeamNormalizedFactionProp is in match-history.models.ts, needs proper import
					const targetFaction = targetLayer[MH.getTeamNormalizedFactionProp(targetLayerTeamParity, team)]
					const previousFaction = layer[MH.getTeamNormalizedFactionProp(layerTeamParity, team)]

					if (!targetFaction || !previousFaction) return

					const targetAlliance = L.StaticLayerComponents.factionToAlliance[targetFaction]
					const previousAlliance = L.StaticLayerComponents.factionToAlliance[previousFaction]

					ctx.log.debug(
						`Checking Alliance team ${team}: target=${targetAlliance} (${targetFaction}), previous=${previousAlliance} (${previousFaction})`,
					)

					if (!targetAlliance || !previousAlliance) return

					if (targetAlliance === previousAlliance && (rule.targetValues?.includes(targetAlliance) ?? true)) {
						ctx.log.debug(`VIOLATION: Alliance team ${team} matches - ${targetAlliance}`)
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
	ctx.log.debug(`getisBlockedByDoNotRepeatRuleDirect result: isBlocked=${isBlocked}, violations=${descriptors.length}`)
	return { isBlocked, descriptors }
}

function getDoNotRepeatSQLConditions(
	ctx: CS.EffectiveColumnConfig,
	rule: LQY.RepeatRule,
	previousLayerIds: [L.LayerId, LQY.ViolationReasonItem | undefined][],
	oldestLayerTeamParity: number,
) {
	const values = new Set<string>()
	if (rule.within <= 0) return { code: 'ok' as const, condition: sql`1=1` }

	let teamParity = MH.getTeamParityForOffset({ ordinal: oldestLayerTeamParity }, previousLayerIds.length - 1)
	for (let i = previousLayerIds.length - 1; i >= Math.max(previousLayerIds.length - rule.within, 0); i--) {
		const layer = L.toLayer(previousLayerIds[i][0])
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
					// TODO: getTeamNormalizedFactionProp is in match-history.models.ts, needs proper import
					const value = layer[MH.getTeamNormalizedFactionProp(teamParity, team)]
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
					// TODO: getTeamNormalizedFactionProp and getTeamNormalizedUnitProp are in match-history.models.ts, need proper imports
					const faction = layer[MH.getTeamNormalizedFactionProp(teamParity, team)]
					if (!faction) return
					const subFac = layer[MH.getTeamNormalizedUnitProp(teamParity, team)]
					const factionAndUnit = LQY.getFactionAndUnitValue(faction, subFac)
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
					// TODO: getTeamNormalizedFactionProp is in match-history.models.ts, needs proper import
					const faction = layer[MH.getTeamNormalizedFactionProp(teamParity, team)]
					if (!faction) return
					const alliance = L.StaticLayerComponents.factionToAlliance[faction]
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
		return { code: 'ok' as const, condition: sql`1=1` }
	}

	const targetLayerTeamParity = MH.getTeamParityForOffset({ ordinal: oldestLayerTeamParity }, previousLayerIds.length)
	let resultSql: SQL
	switch (rule.field) {
		case 'Map':
		case 'Gamemode':
		case 'Size':
		case 'Layer':
			resultSql = E.notInArray(LC.viewCol(rule.field, ctx), valuesArr)
			break
		case 'Faction': {
			const valuesArrA = valuesArr
				.filter((v) => v.startsWith('A:'))
				.map((v) => v.slice(2))
			const valuesArrB = valuesArr
				.filter((v) => v.startsWith('B:'))
				.map((v) => v.slice(2))
			resultSql = E.and(
				E.notInArray(
					LC.viewCol(MH.getTeamNormalizedFactionProp(targetLayerTeamParity, 'A'), ctx),
					valuesArrA,
				),
				E.notInArray(
					LC.viewCol(MH.getTeamNormalizedFactionProp(targetLayerTeamParity, 'B'), ctx),
					valuesArrB,
				),
			)!
			break
		}
		case 'FactionAndUnit': {
			// TODO: getTeamNormalizedFactionProp and getTeamNormalizedUnitProp are in match-history.models.ts, need proper imports
			const getExpr = (team: 'A' | 'B') =>
				sql`CONCAT(${LC.viewCol(MH.getTeamNormalizedFactionProp(oldestLayerTeamParity, team), ctx)}, '_', ${
					LC.layers[MH.getTeamNormalizedUnitProp(oldestLayerTeamParity, team)]
				})`

			const factionAndUnitExpressionA = getExpr('A')
			const valuesArrA = valuesArr
				.filter((v) => v.startsWith('A:'))
				.map((v) => v.slice(2))

			const factionAndUnitExpressionB = getExpr('B')
			const valuesArrB = valuesArr
				.filter((v) => v.startsWith('B:'))
				.map((v) => v.slice(2))

			resultSql = E.and(
				E.notInArray(factionAndUnitExpressionA, valuesArrA),
				E.notInArray(factionAndUnitExpressionB, valuesArrB),
			)!
			break
		}
		case 'Alliance': {
			const getAllianceExpr = (team: 'A' | 'B') => {
				// TODO: getTeamNormalizedFactionProp is in match-history.models.ts, needs proper import
				const factionColumn = LC.viewCol(MH.getTeamNormalizedFactionProp(targetLayerTeamParity, team), ctx)
				// Create a CASE expression to map factions to alliances
				const allianceMapping = Object.entries(L.StaticLayerComponents.factionToAlliance)
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

			resultSql = E.and(
				E.notInArray(allianceExpressionA, valuesArrA),
				E.notInArray(allianceExpressionB, valuesArrB),
			)!
			break
		}
		default:
			assertNever(rule.field)
	}

	return {
		code: 'ok' as const,
		condition: resultSql,
	}
}

export async function getRandomGeneratedLayers<ReturnLayers extends boolean>(
	ctx: CS.LayerQuery,
	number: number,
	constraints: LQY.LayerQueryConstraint[],
	previousLayerIds: string[],
	returnLayers: ReturnLayers,
): Promise<ReturnLayers extends true ? { layers: PostProcessedLayer[]; totalCount: number } : { ids: string[]; totalCount: number }> {
	const { historicLayers, oldestLayerTeamParity } = resolveRelevantLayerHistory(
		ctx,
		previousLayerIds,
	)
	const { conditions, selectProperties } = await buildConstraintSqlCondition(
		ctx,
		historicLayers,
		oldestLayerTeamParity,
		constraints,
	)
	const p_condition = conditions.length > 0 ? E.and(...conditions) : sql`1=1`

	const colOrderRowsPromise = ctx.layerDb().select({ columnName: LC.genLayerColumnOrder.columnName }).from(LC.genLayerColumnOrder)
		.orderBy(E.asc(LC.genLayerColumnOrder.ordinal)).execute()
	const totalCountPromise = ctx.layerDb().select({ totalCount: count() }).from(LC.layersView(ctx)).where(p_condition).execute()
	const allWeightsPromise = ctx.layerDb().select().from(LC.genLayerWeights).execute()

	const colOrderRows = await colOrderRowsPromise
	const orderedColumns = colOrderRows.map(row => row.columnName).filter(colName =>
		(LC.WEIGHT_COLUMNS as unknown as string[]).includes(colName)
	) as [LC.WeightColumn, ...LC.WeightColumn[]]

	const baseLayerPoolPromise = ctx.layerDb().select(
		Obj.selectProps(LC.layers, [...orderedColumns, 'id'] as [LC.WeightColumn, ...LC.WeightColumn[], 'id']),
	).from(LC.layersView(ctx))
		.where(p_condition).limit(300 * number).orderBy(E.asc(sql`random()`))
		.execute().then(convertQueryOutput)

	const totalCountResult = await totalCountPromise
	const totalCount = Number(totalCountResult[0].totalCount)
	const baseLayerPool = await baseLayerPoolPromise
	const allWeights = await allWeightsPromise

	if (baseLayerPool.length === 0) {
		// @ts-expect-error idgaf
		if (returnLayers) return { layers: [], totalCount } as { layers: PostProcessedLayer[]; totalCount: number }
		// @ts-expect-error idgaf
		return { ids: [], totalCount: 0 } as { ids: string[]; totalCount: number }
	}

	const selected: number[] = []
	for (let i = 0; i < number; i++) {
		let layerPool = baseLayerPool
		for (const columnName of orderedColumns) {
			const weightsForColl = allWeights.filter(w => w.columnName === columnName)
			const values: (number | null)[] = []
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

	const results = convertQueryOutput(
		await ctx.layerDb().select({ ...LC.layers, ...selectProperties })
			.from(LC.layersView(ctx))
			.where(
				E.inArray(LC.layers.id, selected),
			).orderBy(sql`rand()`),
	)
	if (returnLayers) {
		// @ts-expect-error idgaf
		return {
			layers: postProcessLayers(
				ctx,
				results as (L.KnownLayer & Record<string, string | number | boolean> & Record<string, boolean>)[],
				constraints,
				historicLayers,
				oldestLayerTeamParity,
			),
			totalCount,
		}
	}
	// @ts-expect-error idgaf
	return { ids: selected, totalCount }
}

/**
 * @param constraints The constraints to apply
 * @param previousLayerIds Other IDs which should be considered as being at the front of the history, in the order they appear in the queue/list
 */
function resolveRelevantLayerHistory(
	ctx: CS.Log & CS.MatchHistory,
	previousLayerIds: ([L.LayerId, LQY.ViolationReasonItem | undefined] | L.LayerId)[],
	startWithOffset?: number,
) {
	const historicMatches = ctx.recentMatches.slice(0, ctx.recentMatches.length - (startWithOffset ?? 0))
	const historicLayers: [string, LQY.ViolationReasonItem | undefined][] = []
	for (const match of historicMatches) {
		const details = L.toLayer(match.layerId)
		// don't consider jensens or seeding layers
		if (details.Layer?.includes('Jensens') || details.Gamemode && Arr.includes(['Training', 'Seed'], details.Gamemode)) break
		historicLayers.push([match.layerId, { type: 'history-entry', historyEntryId: match.historyEntryId }])
	}
	for (const entry of previousLayerIds) {
		if (typeof entry === 'string') historicLayers.push([entry, undefined])
		else historicLayers.push(entry)
	}

	ctx.log.debug('previous layer ids: %s', JSON.stringify(previousLayerIds))
	ctx.log.debug('Resolved relevant layer history: %s', JSON.stringify(historicLayers))
	return {
		historicLayers,
		oldestLayerTeamParity: (historicMatches?.[0]?.ordinal ?? 0) % 2,
	}
}

export type PostProcessedLayer = Awaited<
	ReturnType<typeof postProcessLayers>
>[number]
function postProcessLayers(
	ctx: CS.Log,
	layers: (L.KnownLayer & Record<string, string | number | boolean> & Record<string, boolean>)[],
	constraints: LQY.LayerQueryConstraint[],
	historicLayers: [L.LayerId, LQY.ViolationReasonItem | undefined][],
	oldestLayerTeamParity: number,
) {
	return layers.map((layer) => {
		// default to true because missing means the constraint is applied via a where condition
		const constraintResults: boolean[] = Array(constraints.length).fill(true)
		const violationDescriptors: LQY.ViolationDescriptor[] = []
		for (const key of Object.keys(layer)) {
			const groups = key.match(/^constraint_(\d+)$/)
			if (!groups) continue
			const idx = Number(groups[1])
			constraintResults[idx] = Number(layer[key as keyof L.KnownLayer]) === 1
			const constraint = constraints[idx]
			if (constraint.type === 'do-not-repeat') {
				// TODO being able to do this makes the SQL conditions we made for the dnr rules redundant, we should remove them
				const { isBlocked, descriptors } = getisBlockedByDoNotRepeatRuleDirect(
					ctx,
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
			...layer,
			constraints: constraintResults,
			violationDescriptors,
		}
	})
}

function convertQueryOutput(rows: Record<string, any>[]) {
	const merged: any[] = []
	for (const row of rows) {
		const flattened = Obj.flattenShallow(row)
		for (const [key, value] of Object.entries(flattened)) {
			let valueNorm: string | undefined
			if (key === 'id') {
				valueNorm = LC.unpackId(value as number)
			} else {
				valueNorm = LC.fromEnum(key, value as number)
			}
			if (!isNullOrUndef(valueNorm)) flattened[key] = valueNorm
		}
		merged.push(flattened)
	}
	return merged
}
