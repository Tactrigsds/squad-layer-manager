import { createId } from '@/lib/id'
import { LRUMap } from '@/lib/lru-map'
import * as MapUtils from '@/lib/map'
import * as Obj from '@/lib/object'
import { assertNever } from '@/lib/type-guards'
import type * as CS from '@/models/context-shared'
import * as FB from '@/models/filter-builders'
import type * as F from '@/models/filter.models'
import * as L from '@/models/layer'
import * as LC from '@/models/layer-columns'
import * as LE from '@/models/layer-engine'
import * as LQY from '@/models/layer-queries.models'
import * as MH from '@/models/match-history.models'

// The query layer, running against the columnar engine (layer-engine/) rather than SQLite.
//
// Division of labour: TypeScript owns everything that needs to know what a layer *means* (constraint semantics, repeat
// rules, cursors, match descriptors) and lowers filters into the engine's IR; the engine owns everything that has to
// touch all 732k rows. Values cross the boundary in their db encoding and are decoded here with the same
// LC.fromDbValue the SQLite path used, so nothing downstream of these functions changed.

// A random page is a draw, not a sort, so paging can't just re-slice an ordering: a page has to know which layers the
// other pages of the same query already took, and it has to hand back the same layers if it's revisited. That is what
// this cache is for.
const MAX_PAGES_PER_QUERY = 1000
const MAX_CACHED_QUERIES = 512
const randomLayerCache = new LRUMap<string, { pages: Map<number, number[]>; totalCount: number }>(MAX_CACHED_QUERIES)
let cachedSeed: string | null = null

export type QueryLayersResponsePart = {
	code: 'layers-page'
	layers: PostProcessedLayer[]
	totalCount: number
	pageCount: number
} | {
	code: 'menu-item-possible-values'
	values: Record<string, string[]>
} | F.InvalidFilterNodeResult

// the constraint-driven queries need the engine, the column config and the filter entities; only generation and the
// streamed query need the log and the generation config on top
type QueryCtx = CS.LayerEngine & CS.Filters

function lowerCtx(ctx: QueryCtx): LE.LowerCtx {
	return { ...ctx, colIndex: (name: string) => ctx.engine.columnIndex(name) }
}

// the app works in whole layers: every column of the effective config, in a stable order
function layerColumns(ctx: CS.EffectiveColumnConfig) {
	return Object.keys(ctx.effectiveColsConfig.defs)
}

function columnIndexes(ctx: CS.LayerEngine, names: readonly string[]) {
	return names.map((name) => ctx.engine.columnIndex(name))
}

// ---------------------------- constraints ----------------------------

type CompiledConstraints = {
	code: 'ok'
	// the pool: every constraint that filters, ANDed together
	where: LE.Ir
	// per constraint, the condition to report against each returned layer (null when it shows no indicator)
	indicators: (LE.Ir | null)[]
	// per filter-menu field that asked for them, the condition its possible values are computed under
	menuItemConditions?: Record<string, LE.Ir>
}

export function buildQueryConstraints(
	ctx: QueryCtx,
	input: LQY.BaseQueryInput,
): CompiledConstraints | F.InvalidFilterNodeResult {
	const lower = lowerCtx(ctx)
	const constraints = input.constraints ?? []
	const list = input.list ?? LQY.initLayerItemsState()

	let cursorIndex: LQY.ItemIndex | null = null
	if (input.cursor) {
		const cursor = LQY.fromLayerListCursor(list, input.cursor)
		cursorIndex = LQY.resolveCursorIndex(list, cursor)
	}

	const baseConditions: LE.Ir[] = []
	const indicators: (LE.Ir | null)[] = new Array(constraints.length).fill(null)

	for (let i = 0; i < constraints.length; i++) {
		const constraint = constraints[i]
		if (constraint.type === 'filter-menu-items') continue
		if (constraint.showIndicator === 'disabled' && constraint.filterApplState === 'disabled') continue

		let ir: LE.Ir
		switch (constraint.type) {
			case 'filter-anon': {
				const res = LE.lowerFilterNode(lower, constraint.filter, [i.toString()])
				if (res.code !== 'ok') return res
				ir = res.ir
				break
			}
			case 'filter-entity': {
				const res = LE.lowerFilterNode(lower, FB.includedIn(constraint.filterId), [i.toString()])
				if (res.code !== 'ok') return res
				ir = res.ir
				break
			}
			case 'do-not-repeat':
				ir = repeatRuleIr(ctx, list, cursorIndex?.outerIndex ?? 0, constraint.rule)
				break
			default:
				assertNever(constraint)
		}

		switch (constraint.filterApplState) {
			case 'regular':
				baseConditions.push(ir)
				break
			case 'inverted':
				baseConditions.push(LE.not(ir))
				break
			case 'disabled':
				break
			default:
				assertNever(constraint)
		}

		// a repeat rule's indicator is filled in per item during post-processing, because a violation carries which
		// earlier match it repeats, which is not something a condition over the table can say
		if (constraint.showIndicator && constraint.type !== 'do-not-repeat') indicators[i] = ir
	}

	// menu items: a field's possible values are computed under the *other* fields' conditions, minus the siblings it
	// excludes and minus its own (or it could only ever offer the value already chosen)
	let menuItemConditions: Record<string, LE.Ir> | undefined
	const itemConstraint = constraints.find((c) => c.type === 'filter-menu-items')
	const conditions = [...baseConditions]
	if (itemConstraint) {
		menuItemConditions = {}
		const itemConditions: Record<string, LE.Ir> = {}
		for (const { field, node } of itemConstraint.items) {
			if (!node) continue
			const res = LE.lowerFilterNode(lower, node)
			if (res.code !== 'ok') return res
			itemConditions[field] = res.ir
		}
		conditions.push(...Object.values(itemConditions))

		for (const item of itemConstraint.items) {
			if (!item.returnPossibleValues) continue
			const forField = [...baseConditions]
			for (const [field, condition] of Object.entries(itemConditions)) {
				if (item.field === field || item.excludedSiblings?.includes(field)) continue
				forField.push(condition)
			}
			menuItemConditions[item.field] = LE.and(forField)
		}
	}

	return { code: 'ok', where: LE.and(conditions), indicators, menuItemConditions }
}

// A do-not-repeat rule filters out the values the recent layers used, so it lowers to the same IR as everything else.
function repeatRuleIr(ctx: CS.LayerEngine, list: LQY.LayerItemsState, cursorIndex: number, rule: LQY.RepeatRule): LE.Ir {
	if (rule.within <= 0) return { op: 'false' }
	const col = (name: string) => ctx.engine.columnIndex(name)

	const values = new Set<number>()
	const valuesA = new Set<number>()
	const valuesB = new Set<number>()
	const previousLayers = list.layerItems

	for (let i = cursorIndex - 1; i >= Math.max(cursorIndex - rule.within, 0); i--) {
		if (LQY.isLookbackTerminatingLayerItem(previousLayers[i])) break
		const teamParity = MH.getTeamParityForOffset({ ordinal: list.firstLayerItemParity }, i)
		const layer = L.toLayer(previousLayers[i].layerId)

		switch (rule.field) {
			case 'Map':
			case 'Gamemode':
			case 'Size':
			case 'Layer': {
				const value = layer[rule.field]
				if (value && (rule.targetValues?.includes(value) ?? true)) {
					const dbValue = LC.dbValue(rule.field, value, ctx)
					if (!LC.isUnmappedDbValue(dbValue) && dbValue !== null) values.add(Number(dbValue))
				}
				break
			}
			case 'Faction': {
				for (const team of ['A', 'B'] as const) {
					const column = MH.getTeamNormalizedFactionProp(teamParity, team)
					const value = layer[column]
					if (!value || LQY.valueFilteredByTargetValues(rule, value)) continue
					const dbValue = LC.dbValue(column, value, ctx)
					if (LC.isUnmappedDbValue(dbValue) || dbValue === null) continue
					;(team === 'A' ? valuesA : valuesB).add(Number(dbValue))
				}
				break
			}
			case 'Alliance': {
				for (const team of ['A', 'B'] as const) {
					const column = MH.getTeamNormalizedAllianceProp(teamParity, team)
					const alliance = layer[column]
					if (LQY.valueFilteredByTargetValues(rule, alliance)) continue
					const dbValue = LC.dbValue(column, alliance, ctx)
					if (LC.isUnmappedDbValue(dbValue) || dbValue === null) continue
					;(team === 'A' ? valuesA : valuesB).add(Number(dbValue))
				}
				break
			}
			default:
				assertNever(rule.field)
		}
	}

	const targetParity = MH.getTeamParityForOffset({ ordinal: list.firstLayerItemParity }, cursorIndex)
	switch (rule.field) {
		case 'Map':
		case 'Gamemode':
		case 'Size':
		case 'Layer': {
			if (values.size === 0) return { op: 'false' }
			return { op: 'in_vals', col: col(rule.field), vals: [...values] }
		}
		case 'Faction':
		case 'Alliance': {
			const [colA, colB] = rule.field === 'Faction'
				? [MH.getTeamNormalizedFactionProp(targetParity, 'A'), MH.getTeamNormalizedFactionProp(targetParity, 'B')]
				: [MH.getTeamNormalizedAllianceProp(targetParity, 'A'), MH.getTeamNormalizedAllianceProp(targetParity, 'B')]
			return {
				op: 'or',
				children: [
					{ op: 'in_vals', col: col(colA), vals: [...valuesA] },
					{ op: 'in_vals', col: col(colB), vals: [...valuesB] },
				],
			}
		}
		default:
			assertNever(rule.field)
	}
}

// ---------------------------- queries ----------------------------

export async function* queryLayersStreamed(args: {
	input: LQY.LayersQueryInput
	ctx: CS.LayerQuery
}): AsyncGenerator<QueryLayersResponsePart> {
	const ctx: CS.LayerQuery = {
		...args.ctx,
		log: args.ctx.log.child({ query: 'queryLayers-' + createId(4) }),
	}
	const input = { ...args.input }
	input.pageSize ??= 100
	input.pageIndex ??= 0
	ctx.log.debug(input, 'running queryLayers')

	const compiled = buildQueryConstraints(ctx, input)
	if (compiled.code !== 'ok') {
		yield compiled
		return
	}

	const names = layerColumns(ctx)
	const columns = columnIndexes(ctx, names)
	const indicators = compiled.indicators.filter((ir): ir is LE.Ir => ir !== null)
	// which constraint each indicator belongs to, so the engine's answers land back in constraint order
	const indicatorConstraints: number[] = []
	compiled.indicators.forEach((ir, idx) => {
		if (ir !== null) indicatorConstraints.push(idx)
	})

	const res = input.sort?.type === 'random'
		? drawRandomPage(ctx, {
			where: compiled.where,
			input,
			seed: input.sort.seed ?? LQY.getSeed(),
			pageIndex: input.pageIndex!,
			pageSize: input.pageSize!,
			indicators,
			columns,
		})
		: ctx.engine.query<LE.SelectResponse>({
			kind: 'select',
			where: compiled.where,
			indicators,
			sort: columnSort(ctx, input.sort),
			pageIndex: input.pageIndex!,
			pageSize: input.pageSize!,
			columns,
		})

	const layers = postProcessLayers(
		ctx,
		{ rows: res.rows, names, indicatorResults: res.indicators, indicatorConstraints },
		input,
	)
	yield {
		code: 'layers-page' as const,
		layers,
		totalCount: res.totalCount,
		pageCount: Math.ceil(res.totalCount / input.pageSize!),
	}

	if (compiled.menuItemConditions) {
		const values: Record<string, string[]> = {}
		for (const [field, condition] of Object.entries(compiled.menuItemConditions)) {
			const raw = ctx.engine.query<(number | null)[]>({
				kind: 'distinct',
				where: condition,
				col: ctx.engine.columnIndex(field),
			})
			values[field] = raw.map((value) => LC.fromDbValue(field, value, ctx)) as string[]
		}
		yield { code: 'menu-item-possible-values', values }
	}
}

function columnSort(ctx: CS.LayerEngine, sort: LQY.LayersQuerySort | null | undefined): LE.Sort | null {
	if (sort?.type !== 'column') return null
	let direction = sort.direction
	// only a numeric column has a meaningful absolute value
	if (!LC.isNumericColumn(sort.sortBy, ctx) && direction.endsWith('ABS')) {
		direction = direction.split(':')[0] as 'ASC' | 'DESC'
	}
	return { column: { col: ctx.engine.columnIndex(sort.sortBy), dir: direction } }
}

// Weighted generation. The engine does the picking, since it holds the group universe; this is the bookkeeping around
// it: exclude what sibling pages already took, and replay a page that's revisited instead of re-drawing it.
function drawRandomPage(ctx: CS.LayerQuery, args: {
	where: LE.Ir
	input: LQY.BaseQueryInput
	seed: string
	pageIndex: number
	pageSize: number
	indicators: LE.Ir[]
	columns: number[]
}): LE.SelectResponse {
	const { where, input, seed, pageIndex, pageSize, indicators, columns } = args
	if (cachedSeed !== seed) {
		randomLayerCache.clear()
		cachedSeed = seed
	}
	const cacheKey = simpleHash(JSON.stringify({
		where,
		cursor: input.cursor,
		list: input.list,
		generation: ctx.generationConfig,
	}))
	let entry = randomLayerCache.get(cacheKey)
	if (!entry) {
		entry = { pages: new Map<number, number[]>(), totalCount: 0 }
		randomLayerCache.set(cacheKey, entry)
	}

	const idCol = ctx.engine.columnIndex('id')
	const cachedIds = entry.pages.get(pageIndex)
	if (cachedIds) {
		// the draw for this page already happened: fetch exactly those layers again rather than drawing new ones
		const res = ctx.engine.query<LE.SelectResponse>({
			kind: 'select',
			where: LE.and([where, { op: 'in_vals', col: idCol, vals: cachedIds }]),
			indicators,
			sort: null,
			pageIndex: 0,
			pageSize: cachedIds.length,
			columns,
		})
		return { ...res, totalCount: entry.totalCount }
	}

	const excludeIds: number[] = []
	for (const [index, ids] of entry.pages) {
		if (index !== pageIndex) excludeIds.push(...ids)
	}

	const res = ctx.engine.query<LE.SelectResponse>({
		kind: 'select',
		where,
		indicators,
		sort: { random: { ...generationSpec(ctx, seed, pageIndex, pageSize), excludeIds } },
		pageIndex: 0,
		pageSize,
		columns,
	})

	entry.totalCount = res.totalCount
	if (entry.pages.size < MAX_PAGES_PER_QUERY) {
		const idIndex = columns.indexOf(idCol)
		entry.pages.set(pageIndex, res.rows.map((row) => row[idIndex]!))
	}
	return res
}

// The pick order and its weights, packed into the engine's request. The radices travel with the request, so the
// engine's packing and LC.packStepKey cannot drift apart.
function generationSpec(ctx: CS.LayerQuery, seed: string, pageIndex: number, numLayers: number): LE.GenSpec {
	const config = ctx.generationConfig
	const steps: LE.StepSpec[] = config.pickOrder.map((key) => {
		const weights: { key: number; weight: number }[] = []
		if (LC.isMatchupKey(key)) {
			const [columns1, columns2] = LC.MATCHUP_COLUMNS[key]
			for (const entry of config.matchupWeights[key] as LC.MatchupWeightEntry[]) {
				const packed = packMatchupEntry(ctx, key, entry)
				// a pairing the layer set doesn't have (e.g. a faction dropped by a game update) can't match a group
				if (packed !== undefined) weights.push({ key: packed, weight: entry.weight })
			}
			return {
				cols1: columnIndexes(ctx, columns1),
				radices1: columns1.map((column) => LC.weightColumnRadix(column)),
				cols2: columnIndexes(ctx, columns2),
				radices2: columns2.map((column) => LC.weightColumnRadix(column)),
				weights,
			}
		}
		for (const entry of config.weights[key] ?? []) {
			const value = LC.dbValue(key, entry.value, ctx)
			if (LC.isUnmappedDbValue(value)) continue
			weights.push({ key: LC.packSideKey([key], [value]), weight: entry.weight })
		}
		return { cols1: columnIndexes(ctx, [key]), radices1: [LC.weightColumnRadix(key)], weights }
	})

	return {
		steps,
		defaultWeight: LC.DEFAULT_GENERATION_WEIGHT,
		// the page rides in the seed: different pages of one query have to draw different layers
		seed: simpleHashInt(`${seed}:${pageIndex}`),
		numLayers,
	}
}

function packMatchupEntry(ctx: CS.LayerQuery, key: LC.MatchupKey, entry: LC.MatchupWeightEntry): number | undefined {
	const byColumn = new Map<LC.WeightColumn, LC.DbValue>()
	const sides: [readonly LC.WeightColumn[], LC.MatchupSide][] = [
		[LC.MATCHUP_COLUMNS[key][0], entry.teams[0]],
		[LC.MATCHUP_COLUMNS[key][1], entry.teams[1]],
	]
	for (const [columns, side] of sides) {
		const values = LC.matchupSideValues(key, side)
		for (let i = 0; i < columns.length; i++) {
			const value = LC.dbValue(columns[i], values[i], ctx)
			if (LC.isUnmappedDbValue(value)) return undefined
			byColumn.set(columns[i], value)
		}
	}
	return LC.packStepKey(key, (column) => byColumn.get(column) ?? null)
}

export async function genVote(args: { ctx: CS.LayerQuery; input: LQY.GenVote.Input }) {
	const { input, ctx } = args
	const base = buildQueryConstraints(ctx, input)
	if (base.code !== 'ok') return base

	const choices = Obj.deepClone(input.choices)
	const chosenLayers: (PostProcessedLayer | undefined)[] = new Array<PostProcessedLayer>(choices.length)
	const names = layerColumns(ctx)
	const columns = columnIndexes(ctx, names)
	const seed = input.seed ?? LQY.getSeed()

	for (let i = 0; i < choices.length; i++) {
		const choice = choices[i]
		if (choice.layerId || (input.onlyIndex !== undefined && input.onlyIndex !== i)) continue
		// each choice is drawn from the pool minus what the other choices took, which is what keeps them distinct
		const filterNode = LQY.GenVote.getChoiceFilterNode(choices, input.uniqueConstraints, i)!
		const res = LE.lowerFilterNode(lowerCtx(ctx), filterNode)
		if (res.code !== 'ok') return res

		const generated = ctx.engine.query<LE.SelectResponse>({
			kind: 'select',
			where: LE.and([base.where, res.ir]),
			indicators: [],
			sort: { random: { ...generationSpec(ctx, seed, i, 1), excludeIds: [] } },
			pageIndex: 0,
			pageSize: 1,
			columns,
		})
		const [layer] = postProcessLayers(
			ctx,
			{ rows: generated.rows, names, indicatorResults: [], indicatorConstraints: [] },
			input,
		)
		if (layer) {
			choice.layerId = layer.id
			chosenLayers[i] = layer
		}
	}

	const choiceErrors: (string | undefined)[] = new Array(choices.length)
	for (let i = 0; i < choices.length; i++) {
		if (!chosenLayers[i] && !choices[i].layerId && (input.onlyIndex === undefined || input.onlyIndex === i)) {
			choiceErrors[i] = 'No suitable layer found'
		}
	}

	return { code: 'ok' as const, chosenLayers, choiceErrors }
}

export type BackburnerTemplate = { itemId: string; filter: F.FilterNode }
export type GenerateWithBackburnerInput = LQY.BaseQueryInput & { templates: BackburnerTemplate[]; seed?: string }
export type GenerateWithBackburnerResult = {
	code: 'ok'
	layer: PostProcessedLayer | null
	consumedItemIds: string[]
	// templates whose filter no longer lowers (e.g. references a deleted filter entity); skipped, never consumed
	invalidItemIds: string[]
}

// The greedy backburner fold: AND each template into the accumulated constraints oldest-first, skipping any
// template that would leave zero solutions (it stays on the backburner for a future generation; later
// templates are still tried).
export function foldBackburnerTemplates(
	templates: { itemId: string; ir: LE.Ir }[],
	baseWhere: LE.Ir,
	count: (where: LE.Ir) => number,
): { where: LE.Ir; consumedItemIds: string[] } {
	let acc = baseWhere
	const consumedItemIds: string[] = []
	for (const template of templates) {
		const candidate = LE.and([acc, template.ir])
		if (count(candidate) === 0) continue
		acc = candidate
		consumedItemIds.push(template.itemId)
	}
	return { where: acc, consumedItemIds }
}

function countSolutions(ctx: CS.LayerEngine, where: LE.Ir): number {
	const idCol = ctx.engine.columnIndex('id')
	return ctx.engine.query<LE.SelectResponse>({
		kind: 'select',
		where,
		indicators: [],
		sort: null,
		pageIndex: 0,
		pageSize: 1,
		columns: [idCol],
	}).totalCount
}

export async function generateWithBackburner(args: {
	ctx: CS.LayerQuery
	input: GenerateWithBackburnerInput
}): Promise<GenerateWithBackburnerResult | F.InvalidFilterNodeResult> {
	const { ctx, input } = args
	// templates carry their own filters (incl. pool membership), so the fold applies only the repeat rules on
	// top of them; the full configured constraints only shape the draw when no template is consumed
	const repeatBase = buildQueryConstraints(ctx, {
		...input,
		constraints: (input.constraints ?? []).filter(c => c.type === 'do-not-repeat'),
	})
	if (repeatBase.code !== 'ok') return repeatBase

	const lowered: { itemId: string; ir: LE.Ir }[] = []
	const invalidItemIds: string[] = []
	for (const template of input.templates) {
		const res = LE.lowerFilterNode(lowerCtx(ctx), template.filter)
		if (res.code !== 'ok') {
			invalidItemIds.push(template.itemId)
			continue
		}
		lowered.push({ itemId: template.itemId, ir: res.ir })
	}

	let { where, consumedItemIds } = foldBackburnerTemplates(lowered, repeatBase.where, (w) => countSolutions(ctx, w))
	if (consumedItemIds.length === 0) {
		const base = buildQueryConstraints(ctx, input)
		if (base.code !== 'ok') return base
		where = base.where
	}

	const names = layerColumns(ctx)
	const columns = columnIndexes(ctx, names)
	const seed = input.seed ?? LQY.getSeed()
	const generated = ctx.engine.query<LE.SelectResponse>({
		kind: 'select',
		where,
		indicators: [],
		sort: { random: { ...generationSpec(ctx, seed, 0, 1), excludeIds: [] } },
		pageIndex: 0,
		pageSize: 1,
		columns,
	})
	const [layer] = postProcessLayers(
		ctx,
		{ rows: generated.rows, names, indicatorResults: [], indicatorConstraints: [] },
		input,
	)
	return { code: 'ok', layer: layer ?? null, consumedItemIds, invalidItemIds }
}

// Per-template "does this still have solutions within the base constraints" probe: request-time validation of
// /reqlayer, the panel's per-row satisfiability indicator, and combinability checks when merging two templates.
export async function checkBackburnerTemplates(args: {
	ctx: QueryCtx
	input: LQY.BaseQueryInput & { templates: BackburnerTemplate[] }
}): Promise<{ code: 'ok'; satisfiable: Record<string, boolean> } | F.InvalidFilterNodeResult> {
	const { ctx, input } = args
	const base = buildQueryConstraints(ctx, input)
	if (base.code !== 'ok') return base
	const satisfiable: Record<string, boolean> = {}
	for (const template of input.templates) {
		const res = LE.lowerFilterNode(lowerCtx(ctx), template.filter)
		if (res.code !== 'ok') {
			satisfiable[template.itemId] = false
			continue
		}
		satisfiable[template.itemId] = countSolutions(ctx, LE.and([base.where, res.ir])) > 0
	}
	return { code: 'ok', satisfiable }
}

export async function layerExists({ input, ctx }: { input: LQY.LayerExistsInput; ctx: CS.LayerEngine }) {
	const known = input.filter((id) => L.isKnownLayer(id))
	const res = ctx.engine.query<LE.MatchesResponse>({
		kind: 'matches',
		filters: [],
		ids: known.map((id) => LC.packId(id)),
	})
	const existing = new Set<L.LayerId>()
	for (let i = 0; i < known.length; i++) {
		if (res.exists[i]) existing.add(known[i])
	}
	return {
		code: 'ok' as const,
		results: input.map((id) => ({ id, exists: existing.has(id) })),
	}
}

export async function queryLayerComponent(args: { ctx: QueryCtx; input: LQY.LayerComponentInput }) {
	const { ctx, input } = args
	if (!LC.getColumnDef(input.column, ctx.effectiveColsConfig)) return { code: 'err:unknown-column' as const }
	const compiled = buildQueryConstraints(ctx, input)
	if (compiled.code !== 'ok') return compiled

	const values = ctx.engine.query<(number | null)[]>({
		kind: 'distinct',
		where: compiled.where,
		col: ctx.engine.columnIndex(input.column),
	})
	return values.map((value) => LC.fromDbValue(input.column, value, ctx)) as string[]
}

// given a set of layer ids, returns those that fall outside the pool defined by `constraints` (a layer is out of pool
// if it fails an active constraint or does not exist). used to gate queue:force-write. with no constraints nothing is
// out of pool, so the check is inert until an admin marks filters as inPool.
export async function getLayersOutOfPool(args: {
	ctx: QueryCtx
	input: { layerIds: L.LayerId[]; constraints: LQY.Constraint[] }
}): Promise<{ code: 'ok'; outOfPool: L.LayerId[] } | F.InvalidFilterNodeResult> {
	const { ctx } = args
	const { layerIds, constraints } = args.input
	if (constraints.length === 0 || layerIds.length === 0) return { code: 'ok' as const, outOfPool: [] }

	const compiled = buildQueryConstraints(ctx, { constraints })
	if (compiled.code !== 'ok') return compiled

	// ids that aren't in the canonical layer format can never be in the pool
	const known = layerIds.filter((id) => L.isKnownLayer(id))
	const res = ctx.engine.query<LE.MatchesResponse>({
		kind: 'matches',
		filters: [compiled.where],
		ids: known.map((id) => LC.packId(id)),
	})
	const inPool = new Set<L.LayerId>()
	for (let i = 0; i < known.length; i++) {
		if (res.exists[i] && res.matches[0][i]) inPool.add(known[i])
	}
	return { code: 'ok' as const, outOfPool: layerIds.filter((id) => !inPool.has(id)) }
}

export async function getLayerItemStatuses(args: { ctx: QueryCtx; input: LQY.LayerItemStatusesInput }) {
	const { ctx, input } = args
	const constraints = input.constraints ?? []
	const list = input.list ?? LQY.initLayerItemsState()
	const layerItems = list.layerItems

	// match state is needed for both indication and warning, so evaluate any constraint with either active
	const filterConstraints = constraints.filter((c): c is Extract<LQY.Constraint, { type: 'filter-entity' }> =>
		c.type === 'filter-entity' && (c.showIndicator !== 'disabled' || c.warn !== 'disabled')
	)
	const lower = lowerCtx(ctx)
	const filterIrs: LE.Ir[] = []
	for (const constraint of filterConstraints) {
		const res = LE.lowerFilterNode(lower, FB.includedIn(constraint.filterId), [constraint.id])
		if (res.code !== 'ok') return res
		filterIrs.push(res.ir)
	}

	const layerIds = [...new Set(LQY.getAllLayerIds(layerItems))].filter((id) => L.isKnownLayer(id))
	const res = ctx.engine.query<LE.MatchesResponse>({
		kind: 'matches',
		filters: filterIrs,
		ids: layerIds.map((id) => LC.packId(id)),
	})

	const present = new Set<L.LayerId>()
	const matchesByFilter = new Map<F.FilterEntityId, Map<L.LayerId, boolean>>()
	for (const constraint of filterConstraints) matchesByFilter.set(constraint.filterId, new Map())
	for (let i = 0; i < layerIds.length; i++) {
		if (res.exists[i]) present.add(layerIds[i])
		for (let f = 0; f < filterConstraints.length; f++) {
			matchesByFilter.get(filterConstraints[f].filterId)!.set(layerIds[i], res.matches[f][i])
		}
	}

	const matchDescriptors: Map<LQY.ItemId, LQY.MatchDescriptor[]> = new Map()
	for (let i = 0; i < layerItems.length; i++) {
		for (const item of LQY.coalesceLayerItems(layerItems[i])) {
			const itemDescriptors = MapUtils.defaultInsGet(matchDescriptors, item.itemId, [])
			for (const constraint of constraints) {
				if (constraint.type === 'filter-anon' || constraint.type === 'filter-menu-items') continue
				const active = constraint.type === 'do-not-repeat'
					|| constraint.showIndicator !== 'disabled'
					|| constraint.warn !== 'disabled'
				if (!active) continue
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
						if (matchesByFilter.get(constraint.filterId)?.get(item.layerId)) {
							itemDescriptors.push({
								type: 'filter-entity',
								constraintId: constraint.id,
								layerId: item.layerId,
								itemId: item.itemId,
							})
						}
						break
					}

					default:
						assertNever(constraint)
				}
			}
		}
	}

	const warns: LQY.QueueWarning[] = []
	for (const { item } of LQY.iterItems(layerItems)) {
		if (!LQY.isLayerListItem(item)) continue
		if (!present.has(item.layerId)) continue
		// seeding and training layers are played outside the pool and repeat rules by design
		if (L.isSeedingOrTrainingLayer(item.layerId)) continue
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
		matchDescriptors,
		warns,
	}

	return { code: 'ok' as const, statuses }
}

export async function getLayerInfo({ ctx, input }: { ctx: CS.LayerEngine; input: { layerId: L.LayerId } }) {
	if (!L.isKnownLayer(input.layerId)) return null
	const names = layerColumns(ctx)
	const row = ctx.engine.query<(number | null)[] | null>({
		kind: 'info',
		id: LC.packId(input.layerId),
		columns: columnIndexes(ctx, names),
	})
	if (!row) return null
	return decodeRow(ctx, row, names)
}

export async function getScoreRanges({ ctx }: { ctx: CS.LayerEngine }) {
	const floatCols = Object.values(ctx.effectiveColsConfig.defs).filter((col) => col.type === 'float' && col.table === 'extra-cols')
	if (floatCols.length === 0) return []
	const ranges = ctx.engine.query<LE.RangeResponse[]>({
		kind: 'ranges',
		columns: floatCols.map((col) => ctx.engine.columnIndex(col.name)),
	})
	// stored floats are scaled ints; unscale back to the app-facing float domain for the sliders
	return floatCols.map((col, i) => ({
		field: col.name,
		min: LC.fromScaledDbFloat(col, ranges[i].min ?? 0),
		max: LC.fromScaledDbFloat(col, ranges[i].max ?? 0),
	}))
}

// ---------------------------- post-processing ----------------------------

export type PostProcessedLayer = ReturnType<typeof postProcessLayers>[number]

function decodeRow(ctx: CS.EffectiveColumnConfig, row: (number | null)[], names: string[]) {
	const layer: Record<string, string | number | boolean | null> = {}
	for (let i = 0; i < names.length; i++) {
		layer[names[i]] = LC.fromDbValue(names[i], row[i], ctx)!
	}
	return layer as L.KnownLayer & Record<string, number | boolean | string | null>
}

function postProcessLayers(
	ctx: CS.EffectiveColumnConfig,
	page: { rows: (number | null)[][]; names: string[]; indicatorResults: boolean[][]; indicatorConstraints: number[] },
	baseInput: LQY.BaseQueryInput,
) {
	const list = baseInput.list ?? LQY.initLayerItemsState()
	let cursorIndex: LQY.ItemIndex | null = null
	if (baseInput.cursor) {
		const cursor = LQY.fromLayerListCursor(list, baseInput.cursor)
		cursorIndex = LQY.resolveCursorIndex(list, cursor)
	}
	const constraints = baseInput.constraints ?? []

	return page.rows.map((row, rowIndex) => {
		const layer = decodeRow(ctx, row, page.names)
		const layerId = layer.id as L.LayerId
		const constraintResults: boolean[] = new Array(constraints.length).fill(false)
		const matchDescriptors: LQY.MatchDescriptor[] = []

		for (let i = 0; i < page.indicatorConstraints.length; i++) {
			const constraintIdx = page.indicatorConstraints[i]
			const matched = page.indicatorResults[rowIndex]?.[i] ?? false
			constraintResults[constraintIdx] = matched
			if (matched) {
				matchDescriptors.push({ type: 'filter-entity', constraintId: constraints[constraintIdx].id, layerId })
			}
		}

		// repeat rules are evaluated per item: a violation says which earlier match it repeats, which is not something
		// a condition over the table can express
		for (let i = 0; i < constraints.length; i++) {
			const constraint = constraints[i]
			if (constraint.type !== 'do-not-repeat' || !cursorIndex) continue
			const descriptors = getisMatchedByRepeatRuleDirect(list, cursorIndex.outerIndex, constraint.id, constraint.rule, layerId)
			if (descriptors) {
				constraintResults[i] = true
				matchDescriptors.push(...descriptors)
			}
		}

		return { ...layer, constraints: constraintResults, matchDescriptors }
	})
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

export const queries = {
	layerExists,
	queryLayerComponent,
	getLayerItemStatuses,
	getLayersOutOfPool,
	getLayerInfo,
	genVote,
	checkBackburnerTemplates,
}

// FNV-1a. Collisions are acceptable for cache keys, and it behaves the same on both hosts.
function simpleHash(str: string): string {
	return simpleHashInt(str).toString(36)
}

function simpleHashInt(str: string): number {
	let hash = 2166136261
	for (let i = 0; i < str.length; i++) {
		hash ^= str.charCodeAt(i)
		hash = Math.imul(hash, 16777619)
	}
	return hash >>> 0
}
