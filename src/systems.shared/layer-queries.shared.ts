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
import seedrandom from 'seedrandom'

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

	const conditionsRes = buildConstraintSqlCondition(ctx, input)
	if (conditionsRes.code !== 'ok') return conditionsRes
	const { conditions: whereConditions, selectProperties } = conditionsRes

	if (input.sort && input.sort.type === 'random') {
		const { layers, totalCount } = await getRandomGeneratedLayers(
			args.ctx,
			E.and(...whereConditions),
			selectProperties,
			input.pageSize,
			input,
			true,
			input.sort.seed ?? LQY.getSeed(),
		)
		return { code: 'ok' as const, layers, totalCount, pageCount: 1 }
	}

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
		const isNumericSortCol = LC.isNumericColumn(input.sort.sortBy, ctx)
		const direction = input.sort.sortDirection
		if (direction === 'ASC' || direction === 'ASC:ABS' && !isNumericSortCol) {
			query = query.orderBy(E.asc(LC.viewCol(input.sort.sortBy, ctx)))
		} else if (direction === 'DESC' || direction === 'DESC:ABS' && !isNumericSortCol) {
			query = query.orderBy(E.desc(LC.viewCol(input.sort.sortBy, ctx)))
		} else if (direction === 'ASC:ABS') {
			query = query.orderBy(E.asc(sql`abs(${LC.viewCol(input.sort.sortBy, ctx)})`))
		} else if (direction === 'DESC:ABS') {
			query = query.orderBy(E.desc(sql`abs(${LC.viewCol(input.sort.sortBy, ctx)})`))
		} else {
			assertNever(direction)
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
	const packedIds = LC.packValidLayers(input)
	const results = await ctx
		.layerDb()
		.select(LC.selectViewCols(['id'], ctx))
		.from(LC.layersView(ctx))
		.where(E.inArray(LC.viewCol('id', ctx), packedIds))
	const existsMap = new Set(results.map((result) => LC.unpackId(result.id as number)))

	return {
		code: 'ok' as const,
		results: input.map((id) => ({
			id: id,
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
	const conditionsRes = buildConstraintSqlCondition(ctx, input)
	if (conditionsRes.code !== 'ok') return conditionsRes
	const { conditions: whereConditions } = conditionsRes
	const colDef = LC.getColumnDef(input.column, ctx.effectiveColsConfig)
	if (!colDef) return { code: 'err:unknown-column' as const }

	const res = (await ctx.layerDb().selectDistinct({ [input.column]: LC.viewCol(input.column, ctx) })
		.from(LC.layersView(ctx))
		.where(E.and(...whereConditions)))
		.map((row: any) => LC.fromDbValue(input.column, row[input.column], ctx))
	return res as string[]
}

// reentrantFilterIds are IDs that cannot be present in this node,
// as their presence would cause infinite recursion
export function getFilterNodeSQLConditions(
	ctx: CS.Log & CS.Filters & CS.LayerDb,
	node: F.FilterNode,
	path: string[],
	reentrantFilterIds: string[],
): F.SQLConditionsResult {
	const errors: F.NodeValidationError[] = []
	let condition: SQL | undefined
	if (node.type === 'comp') {
		path = [...path, 'comp']
		const comp = node.comp!
		const dbVal = (v: LC.InputValue) => {
			let dbValue = LC.dbValue(comp.column, v, ctx)
			if (LC.isUnmappedDbValue(dbValue)) {
				errors.push({
					type: 'unmapped-value',
					path,
					column: comp.column,
					value: v,
					msg: `Value ${v} is not mapped for column ${comp.column}`,
				})
				dbValue = null
			}
			return dbValue as LC.DbValue
		}
		const dbVals = (vs: (string | number | boolean | null)[]) => {
			const dbValues: LC.DbValueResult[] = []
			for (const v of vs) {
				const res = LC.dbValue(comp.column, v, ctx)
				if (LC.isUnmappedDbValue(res)) {
					errors.push({
						type: 'unmapped-value',
						path,
						column: comp.column,
						value: v,
						msg: `Value ${v} is not mapped for column ${comp.column}`,
					})
				} else {
					dbValues.push(res)
				}
			}
			return dbValues
		}
		const colDef = LC.getColumnDef(comp.column, ctx.effectiveColsConfig)
		if (!colDef) {
			errors.push({ type: 'unmapped-column', column: comp.column, path, msg: `Column ${comp.column} is not mapped` })
			return {
				code: 'err:invalid-node',
				errors,
			}
		}
		const column = LC.viewCol(comp.column, ctx)
		switch (comp.code) {
			case 'eq': {
				condition = E.eq(column, dbVal(comp.value))!
				break
			}
			case 'neq': {
				condition = E.ne(column, dbVal(comp.value))!
				break
			}
			case 'in': {
				condition = E.inArray(column, dbVals(comp.values))!
				break
			}
			case 'notin': {
				condition = E.notInArray(column, dbVals(comp.values))!
				break
			}
			case 'gt': {
				condition = E.gt(column, dbVal(comp.value))!
				break
			}
			case 'lt': {
				condition = E.lt(column, dbVal(comp.value))!
				break
			}
			case 'inrange': {
				if (comp.range[0] === undefined) condition = E.lte(column, comp.range[1]!)
				else if (comp.range[1] === undefined) condition = E.gte(column, comp.range[0]!)
				else {
					const [min, max] = [...comp.range].sort((a, b) => a! - b!)
					condition = E.and(E.gte(column, min), E.lte(column, max))!
				}
				break
			}
			case 'is-true': {
				condition = E.eq(column, 1)!
				break
			}
			case 'isnull': {
				condition = E.isNull(column)!
				break
			}
			case 'notnull': {
				condition = E.isNotNull(column)!
				break
			}
			default:
				assertNever(comp)
		}
	}
	if (node.type === 'allow-matchups') {
		const config = node.allowMatchups
		path = [...path, 'allowMatchups']
		const mode = config.mode ?? 'either' as const
		switch (mode) {
			case 'both': {
				if (config.allMasks[0].length > 0) {
					condition = E.or(
						...config.allMasks[0].map(mask =>
							E.and(
								factionMaskToSqlCondition(mask, 1, path, errors, ctx),
								factionMaskToSqlCondition(mask, 2, path, errors, ctx),
							)
						),
					)
				} else {
					condition = sql`1 = 1`
				}
				break
			}
			case 'either': {
				if (config.allMasks[0].length > 0) {
					condition = E.or(
						...config.allMasks[0].map(mask =>
							E.or(
								factionMaskToSqlCondition(mask, 1, path, errors, ctx),
								factionMaskToSqlCondition(mask, 2, path, errors, ctx),
							)
						),
					)
				} else {
					condition = sql`1 = 1`
				}
				break
			}
			case 'split': {
				if (config.allMasks[0].length > 0 && config.allMasks[1].length > 0) {
					condition = E.or(
						E.and(
							E.or(...config.allMasks[0].map(mask => factionMaskToSqlCondition(mask, 1, path, errors, ctx))),
							E.or(...config.allMasks[1].map(mask => factionMaskToSqlCondition(mask, 2, path, errors, ctx))),
						),
						E.and(
							E.or(...config.allMasks[1].map(mask => factionMaskToSqlCondition(mask, 1, path, errors, ctx))),
							E.or(...config.allMasks[0].map(mask => factionMaskToSqlCondition(mask, 2, path, errors, ctx))),
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
	}

	if (node.type === 'apply-filter') {
		path = [...path, 'filterId']
		if (reentrantFilterIds.includes(node.filterId)) {
			errors.push({
				path,
				filterId: node.filterId,
				type: 'recursive-filter',
				msg: 'Filter is mutually recursive via filter: ' + node.filterId,
			})
		} else {
			const entity = ctx.filters.get(node.filterId)
			if (!entity) {
				errors.push({
					path,
					filterId: node.filterId,
					type: 'unknown-filter',
					msg: `Filter ${node.filterId} doesn't exist`,
				})
			} else {
				const filter = F.FilterNodeSchema.parse(entity.filter)
				const res = getFilterNodeSQLConditions(ctx, filter, path, [...reentrantFilterIds, node.filterId])
				if (res.code !== 'ok') return res
				condition = res.condition
			}
		}
	}

	if (F.isBlockNode(node)) {
		const childConditions: SQL<unknown>[] = []
		path = [...path, 'children']
		const childResults = node.children.map((node, i) => getFilterNodeSQLConditions(ctx, node, [...path, i.toString()], reentrantFilterIds))
		for (const childResult of childResults) {
			if (childResult.code !== 'ok') {
				errors.push(...childResult.errors)
			} else {
				childConditions.push(childResult.condition)
			}
		}
		if (node.type === 'and') {
			condition = E.and(...childConditions)!
		} else if (node.type === 'or') {
			condition = E.or(...childConditions)!
		}
	}

	if (errors.length > 0) {
		return {
			code: 'err:invalid-node' as const,
			errors,
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
		let res: F.SQLConditionsResult
		switch (constraint.type) {
			case 'filter-anon':
				res = getFilterNodeSQLConditions(ctx, constraint.filter, [i.toString()], [])
				break
			case 'filter-entity':
				res = getFilterNodeSQLConditions(
					ctx,
					FB.applyFilter(constraint.filterEntityId),
					[i.toString()],
					[],
				)
				break
			case 'do-not-repeat':
				res = getRepeatSQLConditions(ctx, cursorIndex, constraint.rule)
				break
			default:
				assertNever(constraint)
		}
		if (res.code !== 'ok') {
			// TODO: pass error back instead
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
	}
	return { code: 'ok' as const, conditions, selectProperties }
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
					const res = getFilterNodeSQLConditions(ctx, constraint.filter, [constraint.id], [])
					if (res.code !== 'ok') return res
					selectExpr[constraint.id] = res.condition
					continue
				}
				if (constraint.type === 'filter-entity') {
					const res = getFilterNodeSQLConditions(ctx, FB.applyFilter(constraint.filterEntityId), [constraint.id], [])
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
		.where(E.inArray(LC.viewCol('id', ctx), LC.packValidLayers(LQY.getAllLayerIds(layerItems.slice(maxLookbackIndex)))))

	const present = new Set<L.LayerId>()
	for (const row of rows) {
		const layerId = LC.fromDbValue('id', row._id, ctx) as L.LayerId
		present.add(layerId)
		for (const item of LQY.iterLayerItems(layerItems.slice(maxLookbackIndex))) {
			if (item.layerId !== layerId) continue
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
): F.SQLConditionsResult {
	const values = new Set<number>()
	const valuesA = new Set<number>()
	const valuesB = new Set<number>()
	if (rule.within <= 0) return { code: 'ok' as const, condition: sql`1=1` }

	const previousLayers = ctx.layerItemsState.layerItems

	for (let i = cursorIndex - 1; i >= Math.max(cursorIndex - rule.within, 0); i--) {
		const teamParity = MH.getTeamParityForOffset({ ordinal: ctx.layerItemsState.firstLayerItemParity }, i)
		if (LQY.isLookbackTerminatingLayerItem(previousLayers[i])) break
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
						const value = LC.dbValue(rule.field, layer[rule.field]!, ctx)
						if (LC.isUnmappedDbValue(value)) break
						values.add(value as number)
					}
					break
				case 'Faction': {
					const addApplicable = (team: 'A' | 'B') => {
						// TODO: getTeamNormalizedFactionProp is in match-history.models.ts, needs proper import
						const column = MH.getTeamNormalizedFactionProp(teamParity, team)
						const value = layer[column]
						const values = team === 'A' ? valuesA : valuesB
						if (value && (!LQY.valueFilteredByTargetValues(rule, value))) {
							const dbValue = LC.dbValue(column, value, ctx)
							if (LC.isUnmappedDbValue(dbValue)) return
							values.add(dbValue as number)
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
							const dbValue = LC.dbValue(column, alliance, ctx)
							if (LC.isUnmappedDbValue(dbValue)) return
							values.add(dbValue as number)
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

	const targetLayerTeamParity = MH.getTeamParityForOffset({ ordinal: ctx.layerItemsState.firstLayerItemParity }, cursorIndex)
	let resultSql: SQL
	switch (rule.field) {
		case 'Map':
		case 'Gamemode':
		case 'Size':
		case 'Layer': {
			if (values.size === 0) {
				return { code: 'ok' as const, condition: sql`1=1` }
			}
			resultSql = E.notInArray(LC.viewCol(rule.field, ctx), Array.from(values))
			break
		}
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
async function getRandomGeneratedLayers<ReturnLayers extends boolean>(
	ctx: CS.LayerQuery,
	p_condition: SQL<unknown> | undefined,
	selectProperties: any,
	numLayers: number,
	input: LQY.LayerQueryBaseInput,
	returnLayers: ReturnLayers,
	seed: string,
): Promise<GenLayerOutput<ReturnLayers>> {
	const totalCount = await ctx.layerDb().$count(LC.layersView(ctx), p_condition)

	if (totalCount === 0) {
		// @ts-expect-error idgaf
		if (returnLayers) return { layers: [], totalCount } as { layers: PostProcessedLayer[]; totalCount: number }
		// @ts-expect-error idgaf
		return { ids: [], totalCount: 0 } as { ids: string[]; totalCount: number }
	}

	const rng = seedrandom(seed.toString())

	const baseLayersQuery = ctx.layerDb()
		.select(LC.selectViewCols([...LC.GROUP_BY_COLUMNS, 'id'], ctx))
		.from(LC.layersView(ctx))
		.where(p_condition)
		.orderBy(sql`((id * 2654435761) + ${rng.int32()}) & 0x7FFFFFFF`)
		.limit(Math.min(numLayers * 500, 5000))

	const baseLayers = await baseLayersQuery
	const indexedBaseLayers = baseLayers.map((layer, index): Record<string, number | null> & { index: number } => ({ ...layer, index }))
	const selectedIndexes: number[] = []

	for (let i = 0; i < numLayers; i++) {
		const filtered = new Set<number>(selectedIndexes)
		function pickLayerIndex() {
			if (filtered.size === indexedBaseLayers.length) return
			for (const layer of shuffled(indexedBaseLayers, rng)) {
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
			const selected = weightedRandomSelection(values, weights, rng)
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
	getLayerItemStatuses,
	getLayerInfo,
}

function factionMaskToSqlCondition(
	mask: F.FactionMask,
	team: 1 | 2,
	path: string[],
	errors: F.NodeValidationError[],
	ctx: CS.EffectiveColumnConfig,
) {
	const getVals = (column: string, values: string[]) => {
		const dbValues = LC.dbValues(column, values, ctx)
		for (let i = 0; i < values.length; i++) {
			if (LC.isUnmappedDbValue(dbValues[i])) {
				errors.push({
					column,
					type: 'unmapped-value',
					msg: `Invalid value for ${column}: ${values[i]}`,
					value: values[i],
					path,
				})
				dbValues[i] = -1
			}
		}
		return dbValues as number[]
	}
	const conditions: (SQL<unknown> | undefined)[] = []
	if (mask.alliance && mask.alliance.length > 0) {
		const colName = `Alliance_${team}`
		conditions.push(E.inArray(LC.viewCol(colName, ctx), getVals(colName, mask.alliance)))
	}
	if (mask.faction && mask.faction.length > 0) {
		const colName = `Faction_${team}`
		conditions.push(E.inArray(LC.viewCol(colName, ctx), getVals(colName, mask.faction)))
	}
	if (mask.unit && mask.unit.length > 0) {
		const colName = `Unit_${team}`
		conditions.push(E.inArray(LC.viewCol(colName, ctx), getVals(colName, mask.unit)))
	}

	return conditions.length > 0 ? E.and(...conditions) : sql`1=1`
}

export async function getLayerInfo({ ctx, input }: { ctx: CS.LayerDb; input: { layerId: L.LayerId } }) {
	if (!L.isKnownLayer(input.layerId)) return null
	const [row] = await ctx.layerDb().select(LC.selectAllViewCols(ctx)).from(LC.layersView(ctx)).where(
		E.eq(LC.viewCol('id', ctx), LC.packId(input.layerId)),
	)
	// @ts-expect-error idgaf
	if (row) return LC.fromDbValues([row], ctx)[0]
	return null
}

export async function getScoreRanges({ ctx }: { ctx: CS.LayerDb }) {
	const ops: Promise<{
		min: number
		max: number
		field: string
	}>[] = []
	for (const col of Object.values(ctx.effectiveColsConfig.defs)) {
		if (col.type !== 'float' || col.table !== 'extra-cols') continue
		ops.push(getRangeForExtraCol({ input: { colDef: col }, ctx }).then(range => ({ ...range, field: col.name })))
	}
	return await Promise.all(ops)
}

async function getRangeForExtraCol({ input, ctx }: { input: { colDef: LC.CombinedColumnDef }; ctx: CS.LayerDb }) {
	const result = await ctx
		.layerDb()
		.select({
			min: sql<number>`MIN(${LC.viewCol(input.colDef.name, ctx)})`,
			max: sql<number>`MAX(${LC.viewCol(input.colDef.name, ctx)})`,
		})
		.from(LC.layersView(ctx))
		.where(E.isNotNull(LC.viewCol(input.colDef.name, ctx)))

	const [{ min, max }] = await result
	return { min, max }
}
