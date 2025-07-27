import * as OneToMany from '@/lib/one-to-many-map'
import { shuffled, weightedRandomSelection } from '@/lib/random'
import { assertNever } from '@/lib/type-guards'
import * as CS from '@/models/context-shared'
import * as FB from '@/models/filter-builders'
import * as F from '@/models/filter.models'
import * as L from '@/models/layer'
import * as LC from '@/models/layer-columns'
import * as LQY from '@/models/layer-queries.models'
import * as MH from '@/models/match-history.models'
import { SQL, sql } from 'drizzle-orm'
import * as E from 'drizzle-orm/expressions'

export type QueriedLayer = {
	layers: L.KnownLayer & { constraints: boolean[] }
	totalCount: number
}

export async function queryLayers(args: {
	input: LQY.LayersQueryInput
	ctx: CS.LayerQuery
}) {
	const ctx: CS.LayerQuery = { ...args.ctx, layerItemsState: LQY.applyItemStatePatches(args.ctx.layerItemsState, args.input) }
	const input = { ...args.input }
	input.pageSize ??= 100
	input.pageIndex ??= 0
	if (input.sort && input.sort.type === 'random') {
		const { layers, totalCount } = await getRandomGeneratedLayers(
			args.ctx,
			input.pageSize,
			input,
			true,
		)
		return { code: 'ok' as const, layers, totalCount, pageCount: 1 }
	}

	const { conditions: whereConditions, selectProperties } = buildConstraintSqlCondition(ctx, input)

	const includeWhere = (query: any) => {
		if (whereConditions.length > 0) {
			return query.where(E.and(...whereConditions))
		}
		return query
	}
	const selectCols = { ...LC.selectAllViewCols(ctx), ...selectProperties }

	let query: any = ctx
		.layerDb()
		.select(selectCols)
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
	query = query.offset(input.pageIndex! * input.pageSize!).limit(input.pageSize)

	let countQuery = ctx
		.layerDb()
		.select({ count: sql<string>`count(*)` })
		.from(LC.layersView(ctx))
	countQuery = includeWhere(countQuery)

	const rows = await query
	const layers = postProcessLayers(ctx, rows, input)
	const [countResult] = await countQuery.execute()
	const totalCount = Number(countResult.count)
	return {
		code: 'ok' as const,
		layers: layers,
		totalCount,
		pageCount: Math.ceil(totalCount / input.pageSize!),
	}
}

export async function layerExists({
	input,
	ctx,
}: {
	input: LQY.LayerExistsInput
	ctx: CS.LayerQuery
}) {
	const packedIds = LC.packLayers(input)
	const results = await ctx
		.layerDb()
		.select(LC.selectViewCols(['id'], ctx))
		.from(LC.layersView(ctx))
		.where(E.inArray(LC.viewCol('id', ctx), packedIds))
	const existsMap = new Map(results.map((result) => [result.id, true]))

	return {
		code: 'ok' as const,
		results: packedIds.map((id) => ({
			id: LC.unpackId(id),
			exists: existsMap.has(id),
		})),
	}
}

export async function queryLayerComponent(args: {
	ctx: CS.LayerQuery
	input: LQY.LayerComponentInput
}) {
	const ctx: CS.LayerQuery = { ...args.ctx, layerItemsState: LQY.applyItemStatePatches(args.ctx.layerItemsState, args.input) }
	const input = args.input
	const { conditions: whereConditions } = buildConstraintSqlCondition(ctx, input)
	const res = (await ctx.layerDb().selectDistinct({ [input.column]: LC.viewCol(input.column, ctx) })
		.from(LC.layersView(ctx))
		.where(E.and(...whereConditions)))
		.map((row: any) => LC.fromDbValue(input.column, row[input.column], ctx))
	return res as string[]
}

export async function searchIds({ ctx: ctx, input }: { ctx: CS.LayerQuery; input: LQY.SearchIdsInput }) {
	const { conditions: whereConditions } = buildConstraintSqlCondition(ctx, input)

	const results = await ctx
		.layerDb()
		.select({ id: LC.layerStrIds.idStr })
		.from(LC.layerStrIds)
		.leftJoin(LC.layersView(ctx), E.eq(LC.viewCol('id', ctx), LC.layerStrIds.id))
		.where(E.and(E.like(LC.layerStrIds.idStr, `%${input.queryString}%`), ...whereConditions))
		.limit(15)

	return {
		code: 'ok' as const,
		ids: results.map(r => r.id),
	}
}

export const getConstraintSQLConditions = LC.coalesceLookupErrors((
	ctx: CS.Log & CS.LayerDb & CS.Filters & CS.LayerItemsState,
	cursorIndex: number,
	constraint: LQY.LayerQueryConstraint,
) => {
	switch (constraint.type) {
		case 'filter-anon':
			return getFilterNodeSQLConditions(ctx, constraint.filter, [])
		case 'filter-entity':
			return getFilterNodeSQLConditions(
				ctx,
				FB.applyFilter(constraint.filterEntityId),
				[],
			)
		case 'do-not-repeat':
			return getRepeatSQLConditions(ctx, cursorIndex, constraint.rule)
		default:
			assertNever(constraint)
	}
})

// reentrantFilterIds are IDs that cannot be present in this node,
// as their presence would cause infinite recursion
export function getFilterNodeSQLConditions(
	ctx: CS.Log & CS.Filters & CS.LayerDb,
	node: F.FilterNode,
	reentrantFilterIds: string[],
): { code: 'ok'; condition: SQL } | { code: 'err:recursive-filter' | 'err:unknown-filter'; msg: string } {
	let condition: SQL | undefined
	if (node.type === 'comp') {
		const comp = node.comp!
		const dbVal = (v: string | number | boolean | null) => LC.dbValue(comp.column, v, ctx)
		const dbVals = (vs: (string | number | boolean | null)[]) => vs.map(v => dbVal(v))
		switch (comp.code) {
			case 'eq': {
				const column = LC.viewCol(comp.column, ctx)
				condition = E.eq(column, dbVal(comp.value))!
				break
			}
			case 'neq': {
				const column = LC.viewCol(comp.column, ctx)
				condition = E.ne(column, dbVal(comp.value))!
				break
			}
			case 'in': {
				const column = LC.viewCol(comp.column, ctx)
				condition = E.inArray(column, dbVals(comp.values))!
				break
			}
			case 'notin': {
				const column = LC.viewCol(comp.column, ctx)
				condition = E.notInArray(column, dbVals(comp.values))!
				break
			}
			case 'factions:allow-matchups': {
				const mode = comp.mode ?? 'either' as const
				switch (mode) {
					case 'both': {
						if (comp.allMasks[0].length > 0) {
							condition = E.and(
								E.or(...comp.allMasks[0].map(mask => factionMaskToSqlCondition(mask, 1, ctx))),
								E.or(...comp.allMasks[0].map(mask => factionMaskToSqlCondition(mask, 2, ctx))),
							)
						} else {
							condition = sql`1 = 1`
						}
						break
					}
					case 'either': {
						if (comp.allMasks[0].length > 0) {
							condition = E.or(
								E.and(...comp.allMasks[0].map(mask => factionMaskToSqlCondition(mask, 1, ctx))),
								E.and(...comp.allMasks[0].map(mask => factionMaskToSqlCondition(mask, 2, ctx))),
							)
						} else {
							condition = sql`1 = 1`
						}
						break
					}
					case 'split': {
						if (comp.allMasks[0].length > 0 && comp.allMasks[1].length > 0) {
							condition = E.or(
								E.and(
									E.or(...comp.allMasks[0].map(mask => factionMaskToSqlCondition(mask, 1, ctx))),
									E.or(...comp.allMasks[1].map(mask => factionMaskToSqlCondition(mask, 2, ctx))),
								),
								E.and(
									E.or(...comp.allMasks[1].map(mask => factionMaskToSqlCondition(mask, 1, ctx))),
									E.or(...comp.allMasks[0].map(mask => factionMaskToSqlCondition(mask, 2, ctx))),
								),
							)
						} else {
							condition = sql`1 = 1`
						}
						break
					}
					default:
						assertNever(mode)
				}
				break
			}
			case 'gt': {
				const column = LC.viewCol(comp.column, ctx)
				condition = E.gt(column, dbVal(comp.value))!
				break
			}
			case 'lt': {
				const column = LC.viewCol(comp.column, ctx)
				condition = E.lt(column, dbVal(comp.value))!
				break
			}
			case 'inrange': {
				const column = LC.viewCol(comp.column, ctx)
				if (comp.range[0] === undefined) condition = E.lte(column, comp.range[1]!)
				else if (comp.range[1] === undefined) condition = E.gte(column, comp.range[0]!)
				else {
					const [min, max] = [...comp.range].sort((a, b) => a! - b!)
					condition = E.and(E.gte(column, min), E.lte(column, max))!
				}
				break
			}
			case 'is-true': {
				const column = LC.viewCol(comp.column, ctx)
				condition = E.eq(column, 1)!
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
		const entity = ctx.filters.get(node.filterId)
		if (!entity) {
			console.trace('unknown filter ', node.filterId, ctx.filters)
			return {
				code: 'err:unknown-filter',
				msg: `Filter ${node.filterId} doesn't exist`,
			}
		}
		const filter = F.FilterNodeSchema.parse(entity.filter)
		const res = getFilterNodeSQLConditions(ctx, filter, [
			...reentrantFilterIds,
			node.filterId,
		])
		if (res.code !== 'ok') return res
		condition = res.condition
	}

	if (F.isBlockNode(node)) {
		const childConditions: SQL<unknown>[] = []
		const childResults = node.children.map((node) => getFilterNodeSQLConditions(ctx, node, reentrantFilterIds))
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

function buildConstraintSqlCondition(
	ctx: CS.Log & CS.Filters & CS.LayerDb & CS.LayerItemsState,
	input: LQY.LayerQueryBaseInput,
) {
	const conditions: SQL<unknown>[] = []
	const selectProperties: any = {}
	const constraints = input.constraints ?? []

	const cursorIndex = LQY.resolveCursorIndex(ctx.layerItemsState, input)

	for (let i = 0; i < constraints.length; i++) {
		const constraint = constraints[i]
		const res = getConstraintSQLConditions(ctx, cursorIndex, constraint)
		if (res.code !== 'ok') {
			// TODO: pass error back instead
			throw new Error('error building constraint SQL condition: ' + JSON.stringify(res))
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
	}
	return { conditions, selectProperties }
}

export async function getLayerItemStatuses(args: {
	ctx: CS.LayerQuery
	input: LQY.LayerItemStatusesInput
}) {
	const ctx: CS.LayerQuery = { ...args.ctx, layerItemsState: LQY.applyItemStatePatches(args.ctx.layerItemsState, args.input) }
	const input = args.input
	const constraints = input.constraints ?? []
	const violationDescriptorsState = new Map<
		string,
		LQY.ViolationDescriptor[]
	>()
	const filterConditionResults: Map<string, SQL<unknown>> = new Map()
	const blockedState: OneToMany.OneToManyMap<string, string> = new Map()
	const layerItems = ctx.layerItemsState.layerItems ?? []
	let lookbackLeft = input.numHistoryEntriesToResolve ?? 15
	let maxLookbackIndex = 0
	for (let i = layerItems.length - 1; i >= 0; i--) {
		const item = layerItems[i]
		if (LQY.isParentVoteItem(item)) continue
		if (item.type !== 'match-history-entry') continue
		if (lookbackLeft <= 0) break
		lookbackLeft--
		maxLookbackIndex = i
	}

	const selectExpr: any = { _id: LC.viewCol('id', ctx) }
	for (let i = maxLookbackIndex; i < layerItems.length; i++) {
		for (const item of LQY.coalesceLayerItems(layerItems[i])) {
			const violationDescriptors: LQY.ViolationDescriptor[] = []
			const itemId = LQY.toLayerItemId(item)
			for (const constraint of constraints) {
				if (constraint.type === 'do-not-repeat') {
					const descriptors = getisBlockedByRepeatRuleDirect(
						ctx,
						i,
						constraint.id,
						constraint.rule,
						item.layerId,
					)
					if (descriptors) {
						OneToMany.set(blockedState, itemId, constraint.id)
						violationDescriptors.push(...descriptors)
					}
					continue
				}
				if (constraint.type === 'filter-anon') {
					const res = getFilterNodeSQLConditions(ctx, constraint.filter, [])
					if (res.code !== 'ok') return res
					selectExpr[constraint.id] = res.condition
					continue
				}
				if (constraint.type === 'filter-entity') {
					const res = getFilterNodeSQLConditions(ctx, FB.applyFilter(constraint.filterEntityId), [])
					if (res.code !== 'ok') return res
					filterConditionResults.set(constraint.id, res.condition)
					selectExpr[constraint.id] = res.condition
					continue
				}
				assertNever(constraint)
			}
			violationDescriptorsState.set(LQY.toLayerItemId(item), violationDescriptors)
		}
	}

	const rows = await ctx
		.layerDb()
		.select(selectExpr)
		.from(LC.layersView(ctx))
		.where(E.inArray(LC.viewCol('id', ctx), LC.packLayers(LQY.getAllLayerIds(layerItems.slice(maxLookbackIndex)))))

	const present = new Set<L.LayerId>()
	for (const row of rows) {
		const layerId = LC.fromDbValue('id', row._id, ctx) as L.LayerId
		present.add(layerId)
		for (const item of LQY.iterLayerItems(layerItems)) {
			for (const [constraintId, isConstraintBlocked] of Object.entries(row)) {
				if (constraintId === '_id') continue
				if (Number(isConstraintBlocked) === 0) {
					OneToMany.set(blockedState, LQY.toLayerItemId(item), constraintId)
				}
			}
		}
	}

	const statuses: LQY.LayerItemStatuses = {
		blocked: blockedState,
		present,
		violationDescriptors: violationDescriptorsState,
	}
	const res = {
		code: 'ok' as const,
		statuses,
	}
	return res
}

function getisBlockedByRepeatRuleDirect(
	ctx: CS.Log & CS.LayerItemsState,
	cursorIndex: number,
	constraintId: string,
	rule: LQY.RepeatRule,
	targetLayerId: L.LayerId,
) {
	const targetLayer = L.toLayer(targetLayerId)
	const previousLayers = ctx.layerItemsState.layerItems
	const targetLayerTeamParity = MH.getTeamParityForOffset({ ordinal: ctx.layerItemsState.firstLayerItemParity }, cursorIndex)

	const descriptors: LQY.ViolationDescriptor[] = []
	for (let i = cursorIndex - 1; i >= Math.max(cursorIndex - rule.within, 0); i--) {
		if (LQY.isLookbackTerminatingLayerItem(previousLayers[i])) break
		const layerTeamParity = MH.getTeamParityForOffset({ ordinal: ctx.layerItemsState.firstLayerItemParity }, i)
		for (const layerItem of LQY.coalesceLayerItems(previousLayers[i])) {
			const layer = L.toLayer(layerItem.layerId)
			const getViolationDescriptor = (field: LQY.ViolationDescriptor['field']): LQY.ViolationDescriptor => ({
				constraintId,
				type: 'repeat-rule',
				field: field,
				reasonItem: layerItem,
			})

			switch (rule.field) {
				case 'Map':
				case 'Gamemode':
				case 'Layer':
				case 'Size':
					if (
						layer[rule.field]
						&& targetLayer[rule.field] === layer[rule.field]
						&& (!LQY.valueFilteredByTargetValues(rule, layer[rule.field]))
					) {
						descriptors.push(getViolationDescriptor(rule.field))
					}
					break
				case 'Faction': {
					const checkFaction = (team: 'A' | 'B') => {
						// TODO: getTeamNormalizedFactionProp is in match-history.models.ts, needs proper import
						const targetFaction = targetLayer[MH.getTeamNormalizedFactionProp(targetLayerTeamParity, team)]!
						const previousFaction = layer[MH.getTeamNormalizedFactionProp(layerTeamParity, team)]
						if (
							targetFaction
							&& previousFaction === targetFaction
							&& (!LQY.valueFilteredByTargetValues(rule, previousFaction))
						) {
							descriptors.push(getViolationDescriptor(`Faction_${team}`))
						}
					}
					checkFaction('A')
					checkFaction('B')
					break
				}
				case 'Alliance': {
					const checkAlliance = (team: 'A' | 'B') => {
						// TODO: getTeamNormalizedFactionProp is in match-history.models.ts, needs proper import
						const targetAlliance = targetLayer[MH.getTeamNormalizedAllianceProp(targetLayerTeamParity, team)]
						const previousAlliance = layer[MH.getTeamNormalizedAllianceProp(layerTeamParity, team)]

						if (targetAlliance && targetAlliance === previousAlliance && (!LQY.valueFilteredByTargetValues(rule, previousAlliance))) {
							descriptors.push(getViolationDescriptor(`Alliance_${team}`))
						}
					}

					checkAlliance('A')
					checkAlliance('B')
					break
				}
				default:
					assertNever(rule.field)
			}
		}
	}
	return descriptors.length > 0 ? descriptors : undefined
}

function getRepeatSQLConditions(
	ctx: CS.EffectiveColumnConfig & CS.LayerItemsState,
	cursorIndex: number,
	rule: LQY.RepeatRule,
) {
	const values = new Set<number>()
	const valuesA = new Set<number>()
	const valuesB = new Set<number>()
	if (rule.within <= 0) return { code: 'ok' as const, condition: sql`1=1` }

	const previousLayers = ctx.layerItemsState.layerItems

	for (let i = cursorIndex - 1; i >= Math.max(cursorIndex - rule.within, 0); i--) {
		const teamParity = MH.getTeamParityForOffset({ ordinal: ctx.layerItemsState.firstLayerItemParity }, i)
		for (const layerItem of LQY.coalesceLayerItems(previousLayers[i])) {
			const layer = L.toLayer(layerItem.layerId)
			switch (rule.field) {
				case 'Map':
				case 'Gamemode':
				case 'Size':
				case 'Layer':
					if (
						layer[rule.field]
						&& (rule.targetValues?.includes(layer[rule.field]!) ?? true)
					) {
						values.add(LC.dbValue(rule.field, layer[rule.field]!, ctx))
					}
					break
				case 'Faction': {
					const addApplicable = (team: 'A' | 'B') => {
						// TODO: getTeamNormalizedFactionProp is in match-history.models.ts, needs proper import
						const column = MH.getTeamNormalizedFactionProp(teamParity, team)
						const value = layer[column]
						const values = team === 'A' ? valuesA : valuesB
						if (value && (!LQY.valueFilteredByTargetValues(rule, value))) {
							values.add(LC.dbValue(column, value, ctx))
						}
					}
					addApplicable('A')
					addApplicable('B')
					break
				}
				case 'Alliance': {
					const addApplicable = (team: 'A' | 'B') => {
						const column = MH.getTeamNormalizedAllianceProp(teamParity, team)
						const alliance = layer[column]
						const values = team === 'A' ? valuesA : valuesB
						if (!LQY.valueFilteredByTargetValues(rule, alliance)) {
							values.add(LC.dbValue(column, alliance, ctx))
						}
					}
					addApplicable('A')
					addApplicable('B')
					break
				}
				default:
					assertNever(rule.field)
			}
		}
	}

	if ((Array.from(values)).length === 0) {
		return { code: 'ok' as const, condition: sql`1=1` }
	}

	const targetLayerTeamParity = MH.getTeamParityForOffset({ ordinal: ctx.layerItemsState.firstLayerItemParity }, cursorIndex)
	let resultSql: SQL
	switch (rule.field) {
		case 'Map':
		case 'Gamemode':
		case 'Size':
		case 'Layer':
			resultSql = E.notInArray(LC.viewCol(rule.field, ctx), Array.from(values))
			break
		case 'Faction': {
			const teamACol = MH.getTeamNormalizedFactionProp(targetLayerTeamParity, 'A')
			const teamBCol = MH.getTeamNormalizedFactionProp(targetLayerTeamParity, 'B')
			resultSql = E.and(
				E.notInArray(LC.viewCol(teamACol, ctx), Array.from(valuesA)),
				E.notInArray(LC.viewCol(teamBCol, ctx), Array.from(valuesB)),
			)!
			break
		}
		case 'Alliance': {
			const allianceACol = MH.getTeamNormalizedAllianceProp(targetLayerTeamParity, 'A')
			const allianceBCol = MH.getTeamNormalizedAllianceProp(targetLayerTeamParity, 'B')
			resultSql = E.and(
				E.notInArray(LC.viewCol(allianceACol, ctx), Array.from(valuesA)),
				E.notInArray(LC.viewCol(allianceBCol, ctx), Array.from(valuesB)),
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

type GenLayerOutput<ReturnLayers extends boolean> = ReturnLayers extends true ? { layers: PostProcessedLayer[]; totalCount: number }
	: { ids: L.LayerId[]; totalCount: number }
export async function getRandomGeneratedLayers<ReturnLayers extends boolean>(
	ctx: CS.LayerQuery,
	numLayers: number,
	input: LQY.LayerQueryBaseInput,
	returnLayers: ReturnLayers,
): Promise<GenLayerOutput<ReturnLayers>> {
	const { conditions, selectProperties } = buildConstraintSqlCondition(ctx, input)
	const p_condition = conditions.length > 0 ? E.and(...conditions) as SQL<unknown> : sql`1=1`

	const totalCount = await ctx.layerDb().$count(LC.layersView(ctx), p_condition)

	if (totalCount === 0) {
		// @ts-expect-error idgaf
		if (returnLayers) return { layers: [], totalCount } as { layers: PostProcessedLayer[]; totalCount: number }
		// @ts-expect-error idgaf
		return { ids: [], totalCount: 0 } as { ids: string[]; totalCount: number }
	}
	let baseLayersQuery = ctx.layerDb()
		.select(LC.selectViewCols([...LC.GROUP_BY_COLUMNS, 'id'], ctx))
		.from(LC.layersView(ctx)).where(p_condition).orderBy(sql`RANDOM()`)
	if (totalCount > 5000) {
		// @ts-expect-error close enough
		baseLayersQuery = baseLayersQuery.orderBy(sql`RANDOM()`).limit(Math.min(numLayers * 500, 5000))
	}
	const baseLayers = await baseLayersQuery
	const indexedBaseLayers = baseLayers.map((layer, index): Record<string, number | null> & { index: number } => ({ ...layer, index }))
	const selectedIndexes: number[] = []

	for (let i = 0; i < numLayers; i++) {
		const filtered = new Set<number>(selectedIndexes)
		function pickLayerIndex() {
			if (filtered.size === indexedBaseLayers.length) return
			for (const layer of shuffled(indexedBaseLayers)) {
				if (!filtered.has(layer.index)) {
					return layer.index
				}
			}
		}
		let currentSelectedIndex = pickLayerIndex()
		for (let j = 0; j < ctx.effectiveColsConfig.generation.columnOrder.length; j++) {
			if (filtered.size === indexedBaseLayers.length) break
			const columnName = ctx.effectiveColsConfig.generation.columnOrder[j]
			const valuesMap: OneToMany.OneToManyMap<number | null, number> = new Map()
			const weightsMap = new Map<number | null, number>()
			const weightsForCol = ctx.effectiveColsConfig.generation.weights[columnName as LC.WeightColumn]
				?.map(w => ({
					value: LC.dbValue(columnName, w.value),
					weight: w.weight,
				})) ?? []
			for (const layer of indexedBaseLayers) {
				if (filtered.has(layer.index)) continue
				const value = layer[columnName] as number | null
				OneToMany.set(valuesMap, value, layer.index)
				weightsMap.set(
					value,
					weightsForCol.find(w => w.value === (value ?? null))?.weight ?? .1,
				)
			}
			if (valuesMap.size === 0) break
			const values = Array.from(valuesMap.keys())
			const weights = values.map(value => weightsMap.get(value)!)
			const selected = weightedRandomSelection(values, weights)
			for (const [value, indexes] of valuesMap.entries()) {
				if (value === selected) continue
				for (const index of indexes) {
					filtered.add(index)
				}
			}
			currentSelectedIndex = pickLayerIndex()
		}
		if (currentSelectedIndex !== undefined) {
			selectedIndexes.push(currentSelectedIndex)
			filtered.add(currentSelectedIndex)
		}
	}

	const selectedIds = selectedIndexes.map(index => baseLayers[index].id as number)
	return await getResultLayers(selectedIds, returnLayers)

	async function getResultLayers<ReturnLayers extends boolean>(
		selectedIds: number[],
		returnLayers: ReturnLayers,
	): Promise<GenLayerOutput<ReturnLayers>> {
		if (returnLayers) {
			const rows = await ctx.layerDb().select({ ...LC.selectAllViewCols(ctx), ...selectProperties }).from(LC.layersView(ctx)).where(
				E.inArray(LC.viewCol('id', ctx), selectedIds),
			)
			const res = { layers: postProcessLayers(ctx, rows as any[], input), totalCount }
			// @ts-expect-error idgaf
			return res
		} else {
			// @ts-expect-error idgaf
			return { ids: selectedIds.map(id => LC.unpackId(id)), totalCount }
		}
	}
}

export type PostProcessedLayer = Awaited<
	ReturnType<typeof postProcessLayers>
>[number]
function postProcessLayers(
	ctx: CS.Log & CS.EffectiveColumnConfig & CS.LayerItemsState,
	layers: ({ id: number } & Record<string, string | number | boolean> & Record<string, boolean>)[],
	baseInput: LQY.LayerQueryBaseInput,
) {
	const cursorIndex = LQY.resolveCursorIndex(ctx.layerItemsState, baseInput)
	const constraints = baseInput.constraints ?? []
	return layers.map((layer) => {
		// default to true because missing means the constraint is applied via a where condition
		const constraintResults: boolean[] = new Array(constraints.length).fill(true)
		const violationDescriptors: LQY.ViolationDescriptor[] = []
		const strId = LC.unpackId(layer.id)
		const layersConverted: Record<string, string | number | boolean> = {}
		for (const key of Object.keys(layer)) {
			if (key in ctx.effectiveColsConfig.defs) {
				layersConverted[key] = LC.fromDbValue(key, layer[key], ctx)!
				continue
			}
			const groups = key.match(/^constraint_(\d+)$/)
			if (!groups) continue
			const idx = Number(groups[1])
			constraintResults[idx] = Number(layer[key as keyof L.KnownLayer]) === 1
			const constraint = constraints[idx]
			if (constraint.type === 'do-not-repeat') {
				// TODO being able to do this makes the SQL conditions we made for the dnr rules redundant, we should remove them
				const descriptors = getisBlockedByRepeatRuleDirect(
					ctx,
					cursorIndex,
					constraint.id,
					constraint.rule,
					strId,
				)
				if (descriptors) constraintResults[idx] = false
				if (descriptors && descriptors.length > 0) {
					violationDescriptors.push(...descriptors)
				}
			}
		}
		return {
			...layersConverted as L.KnownLayer & Record<string, number | boolean | string | null>,
			constraints: constraintResults,
			violationDescriptors,
		}
	})
}

export const queries = {
	queryLayers,
	layerExists,
	queryLayerComponent: queryLayerComponent,
	searchIds,
	getLayerItemStatuses,
}

function factionMaskToSqlCondition(mask: F.FactionMask, team: 1 | 2, ctx: CS.EffectiveColumnConfig) {
	const conditions: (SQL<unknown> | undefined)[] = []
	if (mask.alliance && mask.alliance.length > 0) {
		const colName = `Alliance_${team}`
		conditions.push(E.inArray(LC.viewCol(colName, ctx), LC.dbValues(colName, mask.alliance, ctx)))
	}
	if (mask.faction && mask.faction.length > 0) {
		const colName = `Faction_${team}`
		conditions.push(E.inArray(LC.viewCol(colName, ctx), LC.dbValues(colName, mask.faction, ctx)))
	}
	if (mask.unit && mask.unit.length > 0) {
		const colName = `Unit_${team}`
		conditions.push(E.inArray(LC.viewCol(colName, ctx), LC.dbValues(colName, mask.unit, ctx)))
	}

	return conditions.length > 0 ? E.and(...conditions) : sql`1=1`
}
