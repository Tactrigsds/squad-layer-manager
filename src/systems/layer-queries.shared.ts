import { createId } from '@/lib/id'
import { LRUMap } from '@/lib/lru-map'
import * as MapUtils from '@/lib/map'
import * as Obj from '@/lib/object'
import * as OneToMany from '@/lib/one-to-many-map'
import { shuffled, weightedRandomSelection } from '@/lib/random'
import { assertNever } from '@/lib/type-guards'
import type * as CS from '@/models/context-shared'
import * as FB from '@/models/filter-builders'
import * as F from '@/models/filter.models'
import * as L from '@/models/layer'
import * as LC from '@/models/layer-columns'
import * as LQY from '@/models/layer-queries.models'
import * as MH from '@/models/match-history.models'
import type { SQL } from 'drizzle-orm'
import { sql } from 'drizzle-orm'
import * as E from 'drizzle-orm'
import seedrandom from 'seedrandom'

// snapshot of the filter entities a query depends on, taken when its result is cached. null means the
// filter didn't exist at cache time. compared entity-by-entity (not by map identity) to detect staleness
type FilterEntitySnapshot = Map<string, F.FilterEntity | null>

const MAX_PAGES_PER_QUERY = 1000 // Store up to 1000 pages per unique query
const MAX_CACHED_QUERIES = 512 // Store up to 512 unique query hashes
const MAX_CACHED_QUERY_RESULTS = 256

// Cache for randomized layer query results
// Two-tier structure: LRUMap<queryHash, pages: Map<pageIndex, layerIds[]>>
const randomLayerCache = new LRUMap<string, { pages: Map<number, number[]>; filterEntities: FilterEntitySnapshot }>(MAX_CACHED_QUERIES)
let cachedSeed: string | null = null

// Cache for non-random query results, invalidated when any filter entity the query depends on changes
const queryResultCache = new LRUMap<string, { value: unknown; filterEntities: FilterEntitySnapshot }>(MAX_CACHED_QUERY_RESULTS)

// Per-(filter entity, packed layer id) match results and per-layer existence for getLayerItemStatuses,
// keyed by colsConfig identity so they reset with the layer DB. A filter's entry is dropped when the
// filter entity chain it depends on changes; layer ids accumulate as they're queried, which stays small
// in practice (only ids that appear in layer lists)
type FilterMatchCacheEntry = { filterEntities: FilterEntitySnapshot; matches: Map<number, boolean> }
const filterMatchCaches = new WeakMap<object, Map<F.FilterEntityId, FilterMatchCacheEntry>>()
const layerExistenceCaches = new WeakMap<object, Map<number, boolean>>()

function collectFilterNodeFilterIds(node: F.FilterNode, ids: Set<string>) {
	if (node.type === 'apply-filter') ids.add(node.filterId)
	if (F.isBlockNode(node)) {
		for (const child of node.children) collectFilterNodeFilterIds(child, ids)
	}
}

function snapshotRelevantFilterEntities(ctx: CS.Filters, constraints: LQY.Constraint[] | undefined): FilterEntitySnapshot {
	const ids = new Set<string>()
	for (const constraint of constraints ?? []) {
		switch (constraint.type) {
			case 'filter-anon':
				collectFilterNodeFilterIds(constraint.filter, ids)
				break
			case 'filter-entity':
				ids.add(constraint.filterId)
				break
			case 'filter-menu-items':
				for (const item of constraint.items) {
					if (item.node) collectFilterNodeFilterIds(item.node, ids)
				}
				break
			case 'do-not-repeat':
				break
			default:
				assertNever(constraint)
		}
	}
	const snapshot: FilterEntitySnapshot = new Map()
	const pending = [...ids]
	while (pending.length > 0) {
		const id = pending.pop()!
		if (snapshot.has(id)) continue
		const entity = ctx.filters.get(id) ?? null
		snapshot.set(id, entity)
		if (entity) {
			const referenced = new Set<string>()
			collectFilterNodeFilterIds(entity.filter as F.FilterNode, referenced)
			pending.push(...referenced)
		}
	}
	return snapshot
}

function relevantFilterEntitiesChanged(ctx: CS.Filters, snapshot: FilterEntitySnapshot): boolean {
	for (const [id, entity] of snapshot) {
		const current = ctx.filters.get(id) ?? null
		if (entity === null || current === null) {
			if (entity !== current) return true
		} else if (!Obj.shallowEquals(entity, current)) return true
	}
	return false
}

// effectiveColsConfig is large but referentially stable, so memoize its hash by identity
const colsConfigHashes = new WeakMap<object, string>()
function queryCacheKey(name: string, ctx: CS.LayerQuery, input: object) {
	let colsCfg = colsConfigHashes.get(ctx.effectiveColsConfig)
	if (colsCfg === undefined) {
		colsCfg = simpleHash(JSON.stringify(ctx.effectiveColsConfig))
		colsConfigHashes.set(ctx.effectiveColsConfig, colsCfg)
	}
	const str = JSON.stringify({ name, input, colsCfg })
	// include the length to make hash collisions between differently-shaped inputs less likely
	return `${simpleHash(str)}:${str.length}`
}

function getCachedQueryResult(ctx: CS.Filters, key: string): unknown {
	const entry = queryResultCache.get(key)
	if (!entry) return undefined
	if (relevantFilterEntitiesChanged(ctx, entry.filterEntities)) {
		queryResultCache.delete(key)
		return undefined
	}
	return entry.value as unknown
}

function setCachedQueryResult(ctx: CS.Filters, key: string, value: unknown, constraints: LQY.Constraint[] | undefined) {
	queryResultCache.set(key, { value, filterEntities: snapshotRelevantFilterEntities(ctx, constraints) })
}

export type QueriedLayer = {
	layers: L.KnownLayer & { constraints: boolean[] }
	totalCount: number
}

export type QueryLayersResponsePart = {
	code: 'layers-page'
	layers: PostProcessedLayer[]
	totalCount: number
	pageCount: number
} | {
	code: 'menu-item-possible-values'
	values: Record<string, string[]>
} | F.InvalidFilterNodeResult

export async function* queryLayersStreamed(args: {
	input: LQY.LayersQueryInput
	ctx: CS.LayerQuery
}): AsyncGenerator<QueryLayersResponsePart> {
	const ctx: CS.LayerQuery = {
		...args.ctx,
		log: args.ctx.log.child({ query: 'query-layers' }),
	}
	const input = { ...args.input }
	input.pageSize ??= 100
	input.pageIndex ??= 0

	ctx.log = ctx.log.child({ query: 'queryLayers-' + createId(4) })
	ctx.log.debug(input, 'running queryLayers')

	// the random-sort path has its own cache (randomLayerCache)
	const cacheKey = input.sort?.type === 'random' ? undefined : queryCacheKey('queryLayers', ctx, input)
	if (cacheKey) {
		const cached = getCachedQueryResult<QueryLayersResponsePart[]>(ctx, cacheKey)
		if (cached) return yield* cached
	}

	const conditionsRes = buildQueryInputSqlCondition(ctx, input)
	if (conditionsRes.code !== 'ok') return yield conditionsRes
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
			input.pageIndex!,
		)
		yield { code: 'layers-page' as const, layers, totalCount, pageCount: Math.ceil(totalCount / input.pageSize!) }
		if (conditionsRes.filterMenuItemPossibleValueConditions) {
			yield {
				code: 'menu-item-possible-values',
				values: await queryFilterMenuPossibleValues(ctx, conditionsRes.filterMenuItemPossibleValueConditions),
			}
		}
		return
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
		let direction = input.sort.direction
		if (!isNumericSortCol && direction.endsWith('ABS')) {
			direction = direction.split(':')[0] as 'ASC' | 'DESC'
		}

		if (direction === 'ASC') {
			query = query.orderBy(E.asc(LC.viewCol(input.sort.sortBy, ctx)))
		} else if (direction === 'DESC') {
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
	const parts: QueryLayersResponsePart[] = [{
		code: 'layers-page' as const,
		layers: layers,
		totalCount,
		pageCount: Math.ceil(totalCount / input.pageSize!),
	}]

	if (conditionsRes.filterMenuItemPossibleValueConditions) {
		parts.push({
			code: 'menu-item-possible-values',
			values: await queryFilterMenuPossibleValues(ctx, conditionsRes.filterMenuItemPossibleValueConditions),
		})
	}
	setCachedQueryResult(ctx, cacheKey!, parts, input.constraints)
	yield* parts
}

export async function genVote(args: { ctx: CS.LayerQuery; input: LQY.GenVote.Input }) {
	const { input, ctx } = args
	const base = buildQueryInputSqlCondition(ctx, input)
	if (base.code !== 'ok') return base

	const choices = Obj.deepClone(input.choices)
	const chosenLayers: (PostProcessedLayer | undefined)[] = new Array<PostProcessedLayer>(choices.length)

	for (let i = 0; i < choices.length; i++) {
		const choice = choices[i]
		const conditions = [...base.conditions]
		if (choice.layerId || input.onlyIndex !== undefined && input.onlyIndex !== i) continue
		const filterNode = LQY.GenVote.getChoiceFilterNode(choices, input.uniqueConstraints, i)!
		const filterNodeRes = getFilterNodeSQLConditions(ctx, filterNode, [], [])
		if (filterNodeRes.code !== 'ok') return filterNodeRes
		conditions.push(filterNodeRes.condition)
		const condition = E.and(...conditions)
		const res = await getRandomGeneratedLayers(ctx, condition, base.selectProperties, 1, input, true, LQY.getSeed(), 0)
		if (res.layers[0]) {
			choice.layerId = res.layers[0].id
			chosenLayers[i] = res.layers[0]
		}
	}

	const choiceErrors: (string | undefined)[] = new Array(choices.length)
	for (let i = 0; i < choices.length; i++) {
		if (!chosenLayers[i] && !choices[i].layerId && input.onlyIndex === undefined || input.onlyIndex === i) {
			choiceErrors[i] = 'No suitable layer found'
		}
	}

	return {
		code: 'ok' as const,
		chosenLayers,
		choiceErrors,
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

async function queryFilterMenuPossibleValues(ctx: CS.LayerQuery, conditionsMap: Record<string, SQL<unknown>[]>) {
	const values: Record<string, string[]> = {}
	for (const [field, conditions] of Object.entries(conditionsMap)) {
		const res = (await ctx.layerDb().selectDistinct({ [field]: LC.viewCol(field, ctx) })
			.from(LC.layersView(ctx))
			.where(E.and(...conditions)))
			.map((row: any) => LC.fromDbValue(field, row[field], ctx))

		values[field] = res as string[]
	}
	return values
}

export async function queryLayerComponent(args: {
	ctx: CS.LayerQuery
	input: LQY.LayerComponentInput
}) {
	const ctx: CS.LayerQuery = args.ctx
	const input = args.input
	const cacheKey = queryCacheKey('queryLayerComponent', ctx, input)
	const cached = getCachedQueryResult<string[]>(ctx, cacheKey)
	if (cached) return cached
	const conditionsRes = buildQueryInputSqlCondition(ctx, input)
	if (conditionsRes.code !== 'ok') return conditionsRes
	const { conditions: whereConditions } = conditionsRes
	const colDef = LC.getColumnDef(input.column, ctx.effectiveColsConfig)
	if (!colDef) return { code: 'err:unknown-column' as const }

	const res = (await ctx.layerDb().selectDistinct({ [input.column]: LC.viewCol(input.column, ctx) })
		.from(LC.layersView(ctx))
		.where(E.and(...whereConditions)))
		.map((row: any) => LC.fromDbValue(input.column, row[input.column], ctx))
	setCachedQueryResult(ctx, cacheKey, res, input.constraints)
	return res as string[]
}

// reentrantFilterIds are IDs that cannot be present in this node, as their presence would cause
// infinite recursion. Team-generic column args expand within their own comparison (see compileCompNode).
export function getFilterNodeSQLConditions(
	ctx: CS.Log & CS.Filters & CS.LayerDb,
	node: F.FilterNode,
	path: string[],
	reentrantFilterIds: string[],
): F.SQLConditionsResult {
	const errors: F.NodeValidationError[] = []
	let condition: SQL | undefined

	if (F.isCompNode(node)) {
		condition = compileCompNode(ctx, node, path, errors)
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
		const childrenPath = [...path, 'children']
		const childConditions: SQL<unknown>[] = []
		for (let i = 0; i < node.children.length; i++) {
			const res = getFilterNodeSQLConditions(ctx, node.children[i], [...childrenPath, i.toString()], reentrantFilterIds)
			if (res.code !== 'ok') errors.push(...res.errors)
			else childConditions.push(res.condition)
		}
		if (node.type === 'and') {
			condition = childConditions.length > 0 ? E.and(...childConditions) : sql`1 = 1`
		} else {
			condition = childConditions.length > 0 ? E.or(...childConditions) : sql`0 = 1`
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

// resolves a scalar arg to either a drizzle column expression or a raw db value.
// anchorColumn (if provided) supplies the enum mapping used to convert value args.
type ResolvedScalar =
	| { kind: 'column'; expr: any; column: string; domain: F.ValueDomain | undefined }
	| { kind: 'value'; value: LC.DbValue }
	| { kind: 'null' }

// If `column` is a string-enum column whose mapping contains null (so a null value is stored as a
// concrete enum index rather than SQL NULL), returns that index; otherwise undefined (meaning null
// should be treated as SQL NULL).
function enumNullDbValue(ctx: CS.EffectiveColumnConfig, column: string | undefined): LC.DbValue | undefined {
	if (column === undefined) return undefined
	const def = LC.getColumnDef(column, ctx.effectiveColsConfig)
	if (def?.type !== 'string' || !def.enumMapping) return undefined
	const mapped = LC.dbValue(column, null, ctx)
	return LC.isUnmappedDbValue(mapped) ? undefined : mapped
}

function resolveScalarArg(
	ctx: CS.EffectiveColumnConfig,
	arg: F.ScalarArg,
	anchorColumn: string | undefined,
	team: 1 | 2 | undefined,
	path: string[],
	errors: F.NodeValidationError[],
): ResolvedScalar | undefined {
	switch (arg.type) {
		case 'column':
		case 'team-column': {
			let column: string
			if (arg.type === 'team-column') {
				if (team === undefined) {
					errors.push({ type: 'invalid-node', path, msg: `Team column "${arg.column}" could not be resolved to a team` })
					return undefined
				}
				column = F.resolveTeamColumn(arg.column, team)
			} else {
				column = arg.column
			}
			const colDef = LC.getColumnDef(column, ctx.effectiveColsConfig)
			if (!colDef) {
				errors.push({ type: 'unmapped-column', column, path, msg: `Column ${column} is not mapped` })
				return undefined
			}
			return { kind: 'column', expr: LC.viewCol(column, ctx), column, domain: F.columnValueDomain(column, ctx.effectiveColsConfig) }
		}
		case 'value': {
			if (arg.value === null) {
				// for an enum column that includes null as a mapped value (e.g. LayerVersion's "no version"),
				// a null value is a concrete enum index in the stored data, not SQL NULL
				const idx = enumNullDbValue(ctx, anchorColumn)
				if (idx !== undefined) return { kind: 'value', value: idx }
				return { kind: 'null' }
			}
			if (anchorColumn === undefined) {
				errors.push({ type: 'invalid-node', path, msg: 'Comparison requires at least one column operand' })
				return undefined
			}
			const dbValue = LC.dbValue(anchorColumn, arg.value, ctx)
			if (LC.isUnmappedDbValue(dbValue)) {
				errors.push({
					type: 'unmapped-value',
					path,
					column: anchorColumn,
					value: arg.value,
					msg: `Value ${arg.value} is not mapped for column ${anchorColumn}`,
				})
				return { kind: 'value', value: null }
			}
			return { kind: 'value', value: dbValue }
		}
		default:
			assertNever(arg)
	}
}

// A comparison that references any team-generic column expands over both teams, combining the two
// per-team conditions with OR ('either') or AND ('both') per the team column's quantifier.
function compileCompNode(
	ctx: CS.EffectiveColumnConfig,
	node: F.CompNode,
	path: string[],
	errors: F.NodeValidationError[],
): SQL | undefined {
	// the subject (arg[0]) must be a column: value-first / all-constant comparisons aren't representable in
	// the builder (see SubjectArgSchema). Flag it here so text-editor-authored nodes get a clear message.
	const subject = node.args[0] as F.Arg | undefined
	if (subject?.type !== 'column' && subject?.type !== 'team-column') {
		errors.push({ type: 'invalid-node', path, msg: "A comparison's first operand must be a column" })
		return undefined
	}
	const teamArg = (node.args as F.Arg[]).find((a) => a.type === 'team-column') as F.TeamColumnArg | undefined
	if (!teamArg) return compileCompForTeam(ctx, node, path, undefined, errors)
	const c1 = compileCompForTeam(ctx, node, path, 1, errors)
	// team 1 and team 2 resolve to columns of the same enum mapping, so they produce identical
	// validation errors; discard team 2's to avoid duplicating them in the error list
	const c2 = compileCompForTeam(ctx, node, path, 2, [])
	return teamArg.quantifier === 'both' ? E.and(c1, c2) : E.or(c1, c2)
}

function compileCompForTeam(
	ctx: CS.EffectiveColumnConfig,
	node: F.CompNode,
	path: string[],
	team: 1 | 2 | undefined,
	errors: F.NodeValidationError[],
): SQL | undefined {
	const anchor = F.compAnchorArg(node)
	const anchorColumn = anchor
		? (anchor.type === 'column'
			? (anchor.column as string | undefined)
			: (anchor.type === 'team-column' && team !== undefined && anchor.column
				? F.resolveTeamColumn(anchor.column as F.TeamColumn, team)
				: undefined))
		: undefined

	// bail on an unmapped anchor column before resolving value operands: value conversion goes through
	// LC.dbValue(anchorColumn, ...), which throws on a column that isn't in the effective config
	if (anchorColumn !== undefined && !LC.getColumnDef(anchorColumn, ctx.effectiveColsConfig)) {
		errors.push({ type: 'unmapped-column', column: anchorColumn, path, msg: `Column ${anchorColumn} is not mapped` })
		return undefined
	}

	const resolveScalar = (arg: F.ScalarArg) => resolveScalarArg(ctx, arg, anchorColumn, team, path, errors)
	// operand expression for a resolved scalar (a drizzle column, a raw value, or SQL NULL)
	const operand = (r: ResolvedScalar | undefined): any => {
		if (!r) return null
		if (r.kind === 'column') return r.expr
		if (r.kind === 'null') return null
		return r.value
	}

	switch (node.type) {
		case 'eq': {
			const a = resolveScalar(node.args[0])
			const b = resolveScalar(node.args[1])
			// null on either side becomes an IS NULL test on the other operand
			if (a?.kind === 'null' && b && b.kind !== 'null') return E.isNull(operand(b))
			if (b?.kind === 'null' && a && a.kind !== 'null') return E.isNull(operand(a))
			if (a?.kind === 'null' && b?.kind === 'null') return sql`1 = 1`
			checkColumnColumnDomains(a, b, path, errors)
			return E.eq(operand(a), operand(b))
		}
		case 'in': {
			// the list may mix constant values and column references; each column becomes a `subject = column`
			// disjunct alongside the `subject IN (constants)` term
			const subject = resolveScalar(node.args[0])
			const subjectExpr = operand(subject)
			const constants: LC.DbValue[] = []
			const parts: SQL[] = []
			let hasNull = false
			for (const item of node.args[1].values) {
				if (item === null) {
					// on an enum column that maps null to an index, a null list item is that concrete index
					const idx = enumNullDbValue(ctx, anchorColumn)
					if (idx !== undefined) constants.push(idx)
					else hasNull = true
					continue
				}
				if (F.isColumnListItem(item)) {
					const colDef = LC.getColumnDef(item.column, ctx.effectiveColsConfig)
					if (!colDef) {
						errors.push({ type: 'unmapped-column', column: item.column, path, msg: `Column ${item.column} is not mapped` })
						continue
					}
					const itemDomain = F.columnValueDomain(item.column, ctx.effectiveColsConfig)
					if (subject?.kind === 'column' && subject.domain && itemDomain && !F.domainsCompatible(subject.domain, itemDomain)) {
						errors.push({
							type: 'invalid-node',
							path,
							msg: `Columns ${subject.column} and ${item.column} are not comparable (different data types)`,
						})
						continue
					}
					parts.push(E.eq(subjectExpr, LC.viewCol(item.column, ctx))!)
					continue
				}
				const dbValue = LC.dbValue(anchorColumn ?? '', item, ctx)
				if (LC.isUnmappedDbValue(dbValue)) {
					errors.push({
						type: 'unmapped-value',
						path,
						column: anchorColumn ?? '',
						value: item,
						msg: `Value ${item} is not mapped for column ${anchorColumn}`,
					})
					continue
				}
				constants.push(dbValue)
			}
			if (constants.length > 0) parts.unshift(E.inArray(subjectExpr, constants)!)
			if (hasNull) parts.push(E.isNull(subjectExpr)!)
			if (parts.length === 0) return sql`0 = 1`
			return E.or(...parts)!
		}
		case 'lt':
		case 'gt': {
			const a = resolveScalar(node.args[0])
			const b = resolveScalar(node.args[1])
			if (a?.kind === 'null' || b?.kind === 'null') {
				errors.push({ type: 'invalid-node', path, msg: 'Ordered comparison cannot use null' })
				return sql`0 = 1`
			}
			checkColumnColumnDomains(a, b, path, errors)
			return node.type === 'lt' ? E.lt(operand(a), operand(b)) : E.gt(operand(a), operand(b))
		}
		case 'inrange': {
			const subject = resolveScalar(node.args[0])
			const lo = resolveScalar(node.args[1])
			const hi = resolveScalar(node.args[2])
			if (subject?.kind === 'null' || lo?.kind === 'null' || hi?.kind === 'null') {
				errors.push({ type: 'invalid-node', path, msg: 'Range comparison cannot use null' })
				return sql`0 = 1`
			}
			// forgive reversed constant bounds, matching the legacy inrange behavior
			let loOp = operand(lo)
			let hiOp = operand(hi)
			if (
				lo?.kind === 'value' && hi?.kind === 'value' && typeof lo.value === 'number' && typeof hi.value === 'number' && lo.value > hi.value
			) {
				;[loOp, hiOp] = [hiOp, loOp]
			}
			return E.and(E.gte(operand(subject), loOp), E.lte(operand(subject), hiOp))
		}
		default:
			assertNever(node)
	}
}

function checkColumnColumnDomains(
	a: ResolvedScalar | undefined,
	b: ResolvedScalar | undefined,
	path: string[],
	errors: F.NodeValidationError[],
) {
	if (a?.kind === 'column' && b?.kind === 'column' && a.domain && b.domain && !F.domainsCompatible(a.domain, b.domain)) {
		errors.push({ type: 'invalid-node', path, msg: `Columns ${a.column} and ${b.column} are not comparable (different data types)` })
	}
}

function buildQueryInputSqlCondition(
	ctx: CS.Log & CS.Filters & CS.LayerDb,
	input: LQY.BaseQueryInput,
) {
	const baseConditions: SQL<unknown>[] = []
	const selectProperties: any = {}
	const constraints = [...(input.constraints ?? [])]
	const list = input.list ?? LQY.initLayerItemsState()

	let cursorIndex: LQY.ItemIndex | null = null
	if (input.cursor) {
		const cursor = LQY.fromLayerListCursor(list, input.cursor)
		cursorIndex = LQY.resolveCursorIndex(list, cursor)
	}

	for (let i = 0; i < constraints.length; i++) {
		const constraint = constraints[i]
		if (constraint.type === 'filter-menu-items') continue
		if (constraint.showIndicator === 'disabled' && constraint.filterApplState === 'disabled') continue
		let res: F.SQLConditionsResult | undefined
		switch (constraint.type) {
			case 'filter-anon':
				res = getFilterNodeSQLConditions(ctx, constraint.filter, [i.toString()], [])
				break
			case 'filter-entity':
				res = getFilterNodeSQLConditions(
					ctx,
					FB.applyFilter(constraint.filterId),
					[i.toString()],
					[],
				)
				break
			case 'do-not-repeat':
				{
					res = getRepeatSQLConditions(ctx, list, cursorIndex?.outerIndex ?? 0, constraint.rule)
				}
				break
			default:
				assertNever(constraint)
		}
		if (res.code !== 'ok') {
			// TODO: pass error back instead
			return res
		}

		switch (constraint.filterApplState) {
			case 'regular': {
				baseConditions.push(res.condition)
				break
			}

			case 'inverted': {
				baseConditions.push(E.not(res.condition))
				break
			}

			case 'disabled': {
				break
			}

			default:
				assertNever(constraint)
		}

		if (constraint.showIndicator) {
			// repeat rules are handled separately so just use 1=1 for do-not-repeat constraints for now
			selectProperties[`constraint_${i}`] = constraint.type === 'do-not-repeat' ? sql`1=1` : res.condition
		}
	}

	const conditions: SQL<unknown>[] = [...baseConditions]
	// the conditions to retrieve possible values for menu items
	let filterMenuItemPossibleValueConditions: Record<string, SQL<unknown>[]> | undefined
	// get menu item conditions
	//
	const itemConstraint = constraints.find(c => c.type === 'filter-menu-items')
	if (itemConstraint) {
		filterMenuItemPossibleValueConditions = {}
		const itemConditions: Record<string, SQL<unknown>> = {}
		for (const { field, node } of itemConstraint.items) {
			if (!node) continue
			const res = getFilterNodeSQLConditions(ctx, node, [], [])
			if (res.code !== 'ok') {
				return res
			}
			itemConditions[field] = res.condition
		}
		conditions.push(...Object.values(itemConditions))

		for (const currentItem of itemConstraint.items) {
			if (!currentItem.returnPossibleValues) continue
			filterMenuItemPossibleValueConditions[currentItem.field] = [...baseConditions]
			for (const [field, condition] of Object.entries(itemConditions)) {
				if (currentItem.field === field || currentItem.excludedSiblings?.includes(field)) continue
				filterMenuItemPossibleValueConditions[currentItem.field].push(condition)
			}
		}
	}

	return { code: 'ok' as const, conditions, selectProperties, filterMenuItemPossibleValueConditions }
}

export async function getLayerItemStatuses(args: {
	ctx: CS.LayerQuery
	input: LQY.LayerItemStatusesInput
}) {
	const ctx: CS.LayerQuery = { ...args.ctx }
	const input = args.input
	const constraints = input.constraints ?? []
	const list = input.list ?? LQY.initLayerItemsState()
	const layerItems = list.layerItems

	let matchCache = filterMatchCaches.get(ctx.effectiveColsConfig)
	if (!matchCache) {
		matchCache = new Map()
		filterMatchCaches.set(ctx.effectiveColsConfig, matchCache)
	}
	let existence = layerExistenceCaches.get(ctx.effectiveColsConfig)
	if (!existence) {
		existence = new Map()
		layerExistenceCaches.set(ctx.effectiveColsConfig, existence)
	}

	const filterConstraints = constraints.filter((c): c is Extract<LQY.Constraint, { type: 'filter-entity' }> =>
		c.type === 'filter-entity' && c.showIndicator !== 'disabled'
	)
	const filterEntries = new Map<F.FilterEntityId, FilterMatchCacheEntry>()
	for (const constraint of filterConstraints) {
		let entry = matchCache.get(constraint.filterId)
		if (entry && relevantFilterEntitiesChanged(ctx, entry.filterEntities)) {
			matchCache.delete(constraint.filterId)
			entry = undefined
		}
		if (!entry) {
			entry = { filterEntities: snapshotRelevantFilterEntities(ctx, [constraint]), matches: new Map() }
			matchCache.set(constraint.filterId, entry)
		}
		filterEntries.set(constraint.filterId, entry)
	}

	const packedIds = new Map<L.LayerId, number>()
	for (const layerId of LQY.getAllLayerIds(layerItems)) {
		if (!packedIds.has(layerId) && L.isKnownLayer(layerId)) packedIds.set(layerId, LC.packId(layerId))
	}

	// query only the existence checks and (filter, layer) pairs we don't have cached
	const idsToQuery = new Set<number>()
	const filterIdsToQuery = new Set<F.FilterEntityId>()
	for (const packed of packedIds.values()) {
		if (!existence.has(packed)) idsToQuery.add(packed)
	}
	for (const [filterId, entry] of filterEntries) {
		for (const packed of packedIds.values()) {
			if (!entry.matches.has(packed)) {
				idsToQuery.add(packed)
				filterIdsToQuery.add(filterId)
			}
		}
	}

	if (idsToQuery.size > 0) {
		const queriedFilterIds = Array.from(filterIdsToQuery)
		const selectExpr: any = { _id: LC.viewCol('id', ctx) }
		for (let i = 0; i < queriedFilterIds.length; i++) {
			const res = getFilterNodeSQLConditions(ctx, FB.applyFilter(queriedFilterIds[i]), [queriedFilterIds[i]], [])
			if (res.code !== 'ok') return res
			selectExpr[`f_${i}`] = res.condition
		}
		const rows = await ctx
			.layerDb()
			.select(selectExpr)
			.from(LC.layersView(ctx))
			.where(E.inArray(LC.viewCol('id', ctx), Array.from(idsToQuery)))

		const returned = new Set<number>()
		for (const row of rows) {
			const packed = Number(row._id)
			returned.add(packed)
			existence.set(packed, true)
			for (let i = 0; i < queriedFilterIds.length; i++) {
				filterEntries.get(queriedFilterIds[i])!.matches.set(packed, Number(row[`f_${i}`]) === 1)
			}
		}
		// ids missing from the view don't exist and can't match anything; record that so they
		// aren't requeried on every call
		for (const packed of idsToQuery) {
			if (returned.has(packed)) continue
			existence.set(packed, false)
			for (const filterId of queriedFilterIds) filterEntries.get(filterId)!.matches.set(packed, false)
		}
	}

	const present = new Set<L.LayerId>()
	for (const [layerId, packed] of packedIds) {
		if (existence.get(packed)) present.add(layerId)
	}

	const matchDescriptors: Map<LQY.ItemId, LQY.MatchDescriptor[]> = new Map()
	for (let i = 0; i < layerItems.length; i++) {
		for (const item of LQY.coalesceLayerItems(layerItems[i])) {
			const itemDescriptors = MapUtils.defaultInsGet(matchDescriptors, item.itemId, [])
			for (const constraint of constraints) {
				if (constraint.showIndicator === 'disabled') continue
				switch (constraint.type) {
					case 'do-not-repeat': {
						const descriptors = getisMatchedByRepeatRuleDirect(
							list,
							i,
							constraint.id,
							constraint.rule,
							item.layerId,
							item.itemId,
						)
						if (descriptors) itemDescriptors.push(...descriptors)
						break
					}

					case 'filter-entity': {
						const packed = packedIds.get(item.layerId)
						if (packed === undefined) break
						if (filterEntries.get(constraint.filterId)!.matches.get(packed)) {
							itemDescriptors.push({ type: 'filter-entity', constraintId: constraint.id, layerId: item.layerId, itemId: item.itemId })
						}
						break
					}

					default: {
						assertNever(constraint)
					}
				}
			}
		}
	}

	const warns: LQY.QueueWarning[] = []
	for (const { item } of LQY.iterItems(layerItems)) {
		if (!LQY.isLayerListItem(item)) continue
		if (!present.has(item.layerId)) continue
		for (const constraint of constraints) {
			const descriptors = matchDescriptors.get(item.itemId)?.filter(d => d.constraintId === constraint.id)
			const matched = descriptors?.length !== undefined && descriptors.length > 0
			if (constraint.type === 'filter-entity') {
				if (constraint.warn === 'regular' && matched || constraint.warn === 'inverted' && !matched) {
					warns.push({ itemId: item.itemId, type: 'filter-entity-warning', matched, constraintId: constraint.id })
				}
			} else if (constraint.type === 'do-not-repeat' && constraint.warn) {
				if (matched) {
					warns.push({
						itemId: item.itemId,
						type: 'repeat-rule-violation-warning',
						descriptors: descriptors as LQY.RepeatMatchDescriptor[],
					})
				}
			}
		}
	}

	const statuses: LQY.LayerItemStatuses = {
		present,
		matchDescriptors: matchDescriptors,
		warns,
	}

	return {
		code: 'ok' as const,
		statuses,
	}
}

function getisMatchedByRepeatRuleDirect(
	list: LQY.LayerItemsState,
	cursorIndex: number,
	constraintId: string,
	rule: LQY.RepeatRule,
	targetLayerId: L.LayerId,
	targetItemId?: LQY.ItemId,
) {
	const targetLayer = L.toLayer(targetLayerId)
	const previousLayers = list.layerItems
	const targetLayerTeamParity = MH.getTeamParityForOffset({ ordinal: list.firstLayerItemParity }, cursorIndex)

	const descriptors: LQY.MatchDescriptor[] = []
	for (let i = cursorIndex - 1; i >= Math.max(cursorIndex - rule.within, 0); i--) {
		if (LQY.isLookbackTerminatingLayerItem(previousLayers[i])) break
		const layerTeamParity = MH.getTeamParityForOffset({ ordinal: list.firstLayerItemParity }, i)
		const layerItem = previousLayers[i]
		const layer = L.toLayer(layerItem.layerId)
		const getViolationDescriptor = (field: LQY.RepeatMatchDescriptor['field']): LQY.RepeatMatchDescriptor => ({
			type: 'repeat-rule',
			itemId: targetItemId,
			layerId: targetLayerId,
			constraintId,
			field: field,
			repeatOffset: Math.abs(cursorIndex - i),
			sourceItemId: layerItem.itemId,
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
				const checkFaction = (team: MH.NormedTeamId) => {
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
				const checkAlliance = (team: MH.NormedTeamId) => {
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
	return descriptors.length > 0 ? descriptors : undefined
}

function getRepeatSQLConditions(
	ctx: CS.EffectiveColumnConfig,
	list: LQY.LayerItemsState,
	cursorIndex: number,
	rule: LQY.RepeatRule,
): F.SQLConditionsResult {
	const values = new Set<number>()
	const valuesA = new Set<number>()
	const valuesB = new Set<number>()
	if (rule.within <= 0) return { code: 'ok' as const, condition: sql`false` }

	const previousLayers = list.layerItems

	for (let i = cursorIndex - 1; i >= Math.max(cursorIndex - rule.within, 0); i--) {
		const teamParity = MH.getTeamParityForOffset({ ordinal: list.firstLayerItemParity }, i)
		if (LQY.isLookbackTerminatingLayerItem(previousLayers[i])) break
		const layerItem = previousLayers[i]
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
				const addApplicable = (team: MH.NormedTeamId) => {
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
				const addApplicable = (team: MH.NormedTeamId) => {
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

	const targetLayerTeamParity = MH.getTeamParityForOffset({ ordinal: list.firstLayerItemParity }, cursorIndex)
	let resultSql: SQL
	switch (rule.field) {
		case 'Map':
		case 'Gamemode':
		case 'Size':
		case 'Layer': {
			if (values.size === 0) {
				return { code: 'ok' as const, condition: sql`false` }
			}
			resultSql = E.inArray(LC.viewCol(rule.field, ctx), Array.from(values))
			break
		}
		case 'Faction': {
			const teamACol = MH.getTeamNormalizedFactionProp(targetLayerTeamParity, 'A')
			const teamBCol = MH.getTeamNormalizedFactionProp(targetLayerTeamParity, 'B')
			resultSql = E.or(
				E.inArray(LC.viewCol(teamACol, ctx), Array.from(valuesA)),
				E.inArray(LC.viewCol(teamBCol, ctx), Array.from(valuesB)),
			)!
			break
		}
		case 'Alliance': {
			const allianceACol = MH.getTeamNormalizedAllianceProp(targetLayerTeamParity, 'A')
			const allianceBCol = MH.getTeamNormalizedAllianceProp(targetLayerTeamParity, 'B')
			resultSql = E.or(
				E.inArray(LC.viewCol(allianceACol, ctx), Array.from(valuesA)),
				E.inArray(LC.viewCol(allianceBCol, ctx), Array.from(valuesB)),
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
	input: LQY.BaseQueryInput,
	returnLayers: ReturnLayers,
	seed: string,
	pageIndex: number,
): Promise<GenLayerOutput<ReturnLayers>> {
	const totalCount = await ctx.layerDb().$count(LC.layersView(ctx), p_condition)

	if (totalCount === 0) {
		// @ts-expect-error idgaf
		if (returnLayers) return { layers: [], totalCount } as { layers: PostProcessedLayer[]; totalCount: number }
		// @ts-expect-error idgaf
		return { ids: [], totalCount: 0 } as { ids: string[]; totalCount: number }
	}

	// Clear cache if seed has changed
	if (cachedSeed !== seed) {
		randomLayerCache.clear()
		cachedSeed = seed
	}

	// Create cache key from query inputs
	// Note: p_condition is derived from constraints, so we don't need to include it separately
	const cacheKeyInput = JSON.stringify({
		constraints: input.constraints,
		cursor: input.cursor,
		list: input.list,
		weights: ctx.effectiveColsConfig.generation.weights,
		columnOrder: ctx.effectiveColsConfig.generation.columnOrder,
	})
	const cacheKey = simpleHash(cacheKeyInput)

	// Check cache first (LRUMap.get moves the entry to the end)
	let cacheEntry = randomLayerCache.get(cacheKey)
	if (cacheEntry && relevantFilterEntitiesChanged(ctx, cacheEntry.filterEntities)) {
		randomLayerCache.delete(cacheKey)
		cacheEntry = undefined
	}
	if (!cacheEntry) {
		cacheEntry = { pages: new Map<number, number[]>(), filterEntities: snapshotRelevantFilterEntities(ctx, input.constraints) }
		randomLayerCache.set(cacheKey, cacheEntry)
	}
	const queryCacheForSeed = cacheEntry.pages

	const cachedIds = queryCacheForSeed.get(pageIndex)
	if (cachedIds) {
		return await getResultLayers(cachedIds, returnLayers)
	}

	// Collect all previously seen IDs from other pages to exclude them
	const excludedIds = new Set<number>()
	for (const [cachedPageIndex, ids] of queryCacheForSeed.entries()) {
		if (cachedPageIndex !== pageIndex) {
			for (const id of ids) {
				excludedIds.add(id)
			}
		}
	}

	// Include page index in the seed for different results per page
	const rng = seedrandom(seed + pageIndex.toString())

	const baseLayersQuery = ctx.layerDb()
		.select(LC.selectViewCols([...LC.GROUP_BY_COLUMNS, 'id'], ctx))
		.from(LC.layersView(ctx))
		.where(E.and(p_condition, E.notInArray(LC.viewCol('id', ctx), Array.from(excludedIds))))
		// Hash function using prime multiplication and modulo for pseudo-random distribution
		// Multiplies ID by large prime (2654435761) and adds random seed
		// Modulo 2147483647 (2^31 - 1, also prime) ensures bounded output
		// Deterministic for a given seed, ensuring reproducible results
		.orderBy(sql`
			((id * 2654435761) + ${Math.abs(rng.int32())}) % 2147483647
		`)
		.limit(Math.min(numLayers * 500, 5000))

	const baseLayers = await baseLayersQuery
	const indexedBaseLayers = baseLayers.map((layer, index): Record<string, number | null> & { index: number } => ({
		...layer,
		index,
	}))
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

	// Store in cache, limiting the number of pages stored per query
	if (queryCacheForSeed!.size < MAX_PAGES_PER_QUERY) {
		queryCacheForSeed!.set(pageIndex, selectedIds)
	}

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
	ctx: CS.Log & CS.EffectiveColumnConfig,
	layers: ({ id: number } & Record<string, string | number | boolean> & Record<string, boolean>)[],
	baseInput: LQY.BaseQueryInput,
) {
	const list = baseInput.list ?? LQY.initLayerItemsState()
	let cursorIndex: LQY.ItemIndex | null = null
	if (baseInput.cursor) {
		const cursor = LQY.fromLayerListCursor(list, baseInput.cursor)
		cursorIndex = LQY.resolveCursorIndex(list, cursor)
	}
	const constraints = baseInput.constraints ?? []
	return layers.map((layer) => {
		// default to true because missing means the constraint is applied via a where condition
		const constraintResults: boolean[] = new Array(constraints.length).fill(false)
		const matchDescriptors: LQY.MatchDescriptor[] = []
		const strId = LC.unpackId(layer.id)
		const layersConverted: Record<string, string | number | boolean> = {}
		for (const key of Object.keys(layer)) {
			if (key in ctx.effectiveColsConfig.defs) {
				layersConverted[key] = LC.fromDbValue(key, layer[key], ctx)!
				continue
			}
			const constraintResultMatch = key.match(/^constraint_(\d+)$/)
			if (!constraintResultMatch) continue
			const constraintIdx = Number(constraintResultMatch[1])
			const constraint = constraints[constraintIdx]
			switch (constraint.type) {
				case 'do-not-repeat': {
					if (!cursorIndex) break
					// TODO being able to do this makes the SQL conditions we made for the dnr rules redundant, we should remove them
					const descriptors = getisMatchedByRepeatRuleDirect(
						list,
						cursorIndex.outerIndex,
						constraint.id,
						constraint.rule,
						strId,
					)
					if (descriptors) {
						constraintResults[constraintIdx] = true
						matchDescriptors.push(...descriptors)
					}
					break
				}

				case 'filter-entity': {
					const matched = Number(layer[key as keyof L.KnownLayer]) === 1
					constraintResults[constraintIdx] = matched
					if (matched) {
						matchDescriptors.push({ type: 'filter-entity', constraintId: constraint.id, layerId: strId })
					}
				}
			}
		}
		return {
			...layersConverted as L.KnownLayer & Record<string, number | boolean | string | null>,
			constraints: constraintResults,
			matchDescriptors,
		}
	})
}

export const queries = {
	layerExists,
	queryLayerComponent: queryLayerComponent,
	getLayerItemStatuses,
	getLayerInfo,
	genVote,
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

	const [{ min, max }] = result
	return { min, max }
}

// Simple FNV-1a hash function for creating cache keys
// Works in both Node.js and browsers, collisions are acceptable for this use case
function simpleHash(str: string): string {
	let hash = 2166136261 // FNV offset basis
	for (let i = 0; i < str.length; i++) {
		hash ^= str.charCodeAt(i)
		hash = Math.imul(hash, 16777619) // FNV prime
	}
	// Convert to positive number and base36 for compact representation
	return (hash >>> 0).toString(36)
}
