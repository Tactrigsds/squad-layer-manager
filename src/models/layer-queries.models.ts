import * as Gen from '@/lib/generator'
import * as Obj from '@/lib/object'
import { assertNever, isNullOrUndef } from '@/lib/type-guards'
import * as CB from '@/models/constraint-builders'
import * as FB from '@/models/filter-builders'
import * as V from '@/models/vote.models'
import type { VisibilityState } from '@tanstack/react-table'
import { z } from 'zod'
import * as F from './filter.models'
import * as L from './layer'
import type * as LC from './layer-columns'
import * as LL from './layer-list.models'
import * as MH from './match-history.models'

export const RepeatRuleFieldSchema = z.enum(['Map', 'Layer', 'Gamemode', 'Faction', 'Alliance', 'Size'])
export type RepeatRuleField = z.infer<typeof RepeatRuleFieldSchema>
export const RepeatRuleSchema = z.object({
	field: RepeatRuleFieldSchema,
	label: z.string().min(1).max(100).describe('A label for the rule'),
	targetValues: z.array(z.string()).optional().describe('A "Whitelist" of values which the rule applies to'),
	within: z.number().min(0).max(50).describe('the number of matches in which this rule applies. if 0, the rule should be ignored'),
})
export type RepeatRule = z.infer<typeof RepeatRuleSchema>
export function valueFilteredByTargetValues(rule: RepeatRule, value?: string): boolean {
	if (!rule.targetValues || rule.targetValues.length === 0) return false
	return !rule.targetValues.includes(value as string)
}

export type Constraint =
	| {
		type: 'filter-anon'
		filter: F.FilterNode
		filterResults: true
		indicateMatches: false
		invert: false
		id: string
	}
	| {
		type: 'filter-entity'
		filterId: F.FilterEntityId
		indicateMatches: boolean
		// only applies to filtering results
		invert: boolean
		filterResults: boolean
		id: string
	}
	| {
		type: 'do-not-repeat'
		rule: RepeatRule
		indicateMatches: true
		// always inverted when filtering results
		invert: boolean
		filterResults: boolean
		id: string
	}
	| {
		type: 'filter-menu-items'
		items: FilterMenuItem[]
		filterResults: true
		indicateMatches: false
		invert: false
		id: string
	}

export type FilterMenuItem = {
	field: string
	node?: F.FilterNode
	returnPossibleValues: boolean
	// siblings that this menu item *shouldn't* be filtered by
	excludedSiblings?: string[]
}

export type ViewableConstraint = Exclude<Constraint, { indicateMatches: false }>

export const LAYERS_QUERY_SORT_DIRECTION = z.enum(['ASC', 'DESC', 'ASC:ABS', 'DESC:ABS'])
export type LayersQuerySortDirection = z.infer<typeof LAYERS_QUERY_SORT_DIRECTION>
export const LayersQuerySortSchema = z
	.discriminatedUnion('type', [
		z.object({
			type: z.literal('column'),
			sortBy: z.string(),
			direction: LAYERS_QUERY_SORT_DIRECTION.optional().prefault('ASC'),
		}),
		z.object({
			type: z.literal('random'),
			seed: z.string().optional(),
		}),
	])
	.describe('if not provided, no sorting will be done')

export type LayersQuerySort = z.infer<typeof LayersQuerySortSchema>

export const DEFAULT_SORT: LayersQuerySort = {
	type: 'column',
	sortBy: 'Asymmetry_Score',
	direction: 'ASC',
}
export const DEFAULT_PAGE_SIZE = 20

export type LayersQueryInput = {
	pageIndex?: number
	pageSize: number
	sort: LayersQuerySort | null
	selectedLayers?: L.LayerId[]
} & BaseQueryInput

export namespace GenVote {
	export type Input = BaseQueryInput & {
		// choice constraints to be considered "present" aka we should ensure uniqueness among choices for this key
		uniqueConstraints: V.GenVote.ChoiceConstraintKey[]
		choices: V.GenVote.Choice[]
		seed?: string
		onlyIndex?: number
	}

	export function getChoiceFilterNode(choices: V.GenVote.Choice[], uniqueConstraints: V.GenVote.ChoiceConstraintKey[], index: number) {
		const choice = choices[index]
		if (!choice) {
			return null
		}

		let nodes: F.FilterNode[] = []

		for (const [key, colKey] of V.GenVote.iterChoiceCols()) {
			if (!choice.choiceConstraints[key]) continue
			const constraint = choice.choiceConstraints[key]
			nodes.push(FB.comp(FB.eq(colKey, constraint as string)))
		}

		for (let i = 0; i < choices.length; i++) {
			if (index === i) continue
			const otherChoice = choices[i]
			if (otherChoice.layerId) {
				nodes.push(FB.comp(FB.neq('id', otherChoice.layerId)))
			}

			const layer = otherChoice.layerId ? L.toLayer(otherChoice.layerId) : null
			for (const [key, colKey] of V.GenVote.iterChoiceCols()) {
				let value: string

				// don't repeat any values that have already been chosen for columns referencing "explicitely mapped keys", as in  we set a choice constraint for that key
				if (uniqueConstraints.includes(key)) {
					if (layer && layer[colKey]) {
						value = layer[colKey] as string
					} else if (otherChoice.choiceConstraints?.[key]) {
						value = otherChoice.choiceConstraints[key] as string
					} else {
						continue
					}

					nodes.push(FB.comp(FB.neq(colKey, value)))
				}
			}
		}

		return FB.and(nodes)
	}
}

export type LayerComponentInput = BaseQueryInput & { column: LC.GroupByColumn }

export type LayerExistsInput = L.LayerId[]

export type SearchIdsInput = {
	queryString: string
	constraints?: Constraint[]
}

export type LayerItemStatusesInput = BaseQueryInput

export type LayerItemStatuses = {
	present: Set<L.LayerId>
	matchDescriptors: Map<ItemId, MatchDescriptor[]>
}

export type LayerItemStatusesPart = { layerItemStatuses: LayerItemStatuses }

export const LAYER_ITEM_ACTION = z.enum(['add', 'edit'])
export type LayerItemAction = z.infer<typeof LAYER_ITEM_ACTION>

export type BaseQueryInput = {
	constraints?: Constraint[]

	// no cursor or action == repeat rules ignored : we perform a conversion to a layer query cursor
	cursor?: LL.Cursor
	action?: LayerItemAction
}

export function mergeBaseInputs(a: BaseQueryInput, b: BaseQueryInput): BaseQueryInput {
	return {
		constraints: [...(a.constraints || []), ...(b.constraints || [])],
		cursor: b.cursor || a.cursor,
	}
}

export type ItemIndex = LL.ItemIndex

export function offsetListIndexToItemIndex(state: LayerItemsState, index: LL.ItemIndex): ItemIndex {
	for (const { index: currentIndex, item } of iterItems(state.layerItems)) {
		if (item.type === 'match-history-entry') continue
		return { outerIndex: currentIndex.outerIndex + index.outerIndex, innerIndex: index.innerIndex }
	}
	return { outerIndex: state.layerItems.length, innerIndex: index.innerIndex }
}

// cleaning this shit up is incentive to move to zod 4
export const SpecialItemId = {
	FIRST_LIST_ITEM: 0,
	LAST_LIST_ITEM: 1,
}

export type SpecialItemId = typeof SpecialItemId[keyof typeof SpecialItemId]

export const CursorSchema = z.discriminatedUnion('type', [
	z.object({
		type: z.literal('item-relative'),
		itemId: z.union([z.string(), z.literal(SpecialItemId.FIRST_LIST_ITEM), z.literal(SpecialItemId.LAST_LIST_ITEM)]),
		position: z.enum(['before', 'after', 'on']),
	}),
	z.object({
		type: z.literal('index'),
		index: z.object({
			outerIndex: z.number(),
			innerIndex: z.number().nullable(),
		}),
	}),
])

export type Cursor = z.infer<typeof CursorSchema>

export function fromLayerListCursor(state: LayerItemsState, cursor: LL.Cursor): Cursor {
	if (cursor.type === 'index') {
		return {
			type: 'index',
			index: offsetListIndexToItemIndex(state, cursor.index),
		}
	}
	if (cursor.type === 'item-relative') return cursor
	if (cursor.type === 'start') {
		return {
			type: 'item-relative',
			itemId: SpecialItemId.FIRST_LIST_ITEM,
			position: 'before',
		}
	}
	if (cursor.type === 'end') {
		return {
			type: 'item-relative',
			itemId: SpecialItemId.LAST_LIST_ITEM,
			position: 'after',
		}
	}
	assertNever(cursor)
}

export type GenLayerQueueItemsOptions = {
	numToAdd: number
	numVoteChoices: number
	itemType: 'layer' | 'vote'
	baseFilterId?: F.FilterEntityId
}

export function getEditFilterPageBaseInput(filter: F.FilterNode): BaseQueryInput {
	return { constraints: [CB.filterAnon('edited-filter', filter)] }
}

export type RepeatMatchDescriptor = {
	type: 'repeat-rule'
	constraintId: string
	field:
		| 'Map'
		| 'Gamemode'
		| 'Layer'
		| 'Size'
		| 'Faction_A'
		| 'Faction_B'
		| 'Alliance_A'
		| 'Alliance_B'
	itemId?: ItemId
	repeatOffset: number
}

export type FilterEntityMatchDescriptor = {
	type: 'filter-entity'
	constraintId: string
	itemId?: ItemId
}
export type MatchDescriptor = RepeatMatchDescriptor | FilterEntityMatchDescriptor

export function resolveRepeatedFieldToDescriptorMap(descriptors: MatchDescriptor[], teamParity: number) {
	const violatedFields: Map<keyof L.KnownLayer, RepeatMatchDescriptor> = new Map()
	for (const descriptor of descriptors) {
		if (descriptor.type === 'filter-entity') continue
		if (descriptor.type === 'repeat-rule') {
			violatedFields.set(resolveLayerPropertyForRepeatDescriptorField(descriptor, teamParity), descriptor)
			continue
		}
		assertNever(descriptor)
	}
	return violatedFields
}

export function resolveLayerPropertyForRepeatDescriptorField(descriptor: RepeatMatchDescriptor, teamParity: number) {
	switch (descriptor.field) {
		case 'Map':
		case 'Layer':
		case 'Size':
		case 'Gamemode':
			return descriptor.field
		case 'Faction_A':
			return MH.getTeamNormalizedFactionProp(teamParity, 'A')
		case 'Faction_B':
			return MH.getTeamNormalizedFactionProp(teamParity, 'B')
		case 'Alliance_A':
			return MH.getTeamNormalizedAllianceProp(teamParity, 'A')
		case 'Alliance_B':
			return MH.getTeamNormalizedAllianceProp(teamParity, 'B')
			break
		default:
			assertNever(descriptor.field)
	}
}

export function getFactionAndUnitValue(faction: string, unit: string | null | undefined) {
	return faction + '_' + unit || ''
}

export type ItemId = LL.ItemId | number
export type SingleListItem = {
	type: 'single-list-item'
	itemId: LL.ItemId
	layerId: L.LayerId
}

export type VoteListItem = {
	type: 'vote-list-item'
	choices: SingleListItem[]
	voteDecided: boolean
	itemId: LL.ItemId
	layerId: L.LayerId
}

export type MatchHistoryItem = {
	type: 'match-history-entry'
	layerId: L.LayerId
	itemId: number
}

export type LayerItem =
	| SingleListItem
	| VoteListItem
	| MatchHistoryItem

{
	const _ = {} as LayerItem satisfies LL.SparseItem
	const _id = _.itemId satisfies ItemId
}

export type LayerItemsState = {
	layerItems: OrderedLayerItems
	firstLayerItemParity: number
}

export function resolveId(item: LayerItem | ItemId) {
	if (typeof item === 'string' || typeof item === 'number') return item
	if (item.type === 'match-history-entry') {
		return item.itemId
	}
	return item.itemId
}

export type OrderedLayerItems = LayerItem[]
export function isVoteListitem(item: LayerItem): item is VoteListItem {
	if (item.type === 'match-history-entry') return false
	return LL.isVoteItem(item)
}

export function coalesceLayerItems(item: LayerItem) {
	return isVoteListitem(item) ? item.choices : [item]
}

export type LayerItemsIterResult = { index: ItemIndex; item: LayerItem }
export const iterItems = LL.iterItems

export function findItemById(items: LayerItem[], itemId: ItemId | SpecialItemId): LayerItemsIterResult | undefined {
	if (itemId === SpecialItemId.FIRST_LIST_ITEM) {
		return Gen.find(LL.iterItems(items), ({ item }) => item.type === 'single-list-item' || item.type === 'vote-list-item')
	}
	if (itemId === SpecialItemId.LAST_LIST_ITEM) {
		return Gen.find(
			LL.iterItems(items, { reverse: true }),
			({ item }) => item.type === 'single-list-item' || item.type === 'vote-list-item',
		)
	}

	return LL.findItemById(items, itemId)
}

// export function findItemByCursor(items: LayerItem[], cursor: Cursor): LayerItemsIterResult | undefined {
// 	if (cursor.type === 'item-relative') {
// 	}
// 	for (const res of IterItems(items)) {
// 		if (res.item.id === cursor.id) {
// 			return res
// 		}
// 	}
// 	return undefined
// }

export type SerialLayerItem = string
export function fromSerial(id: SerialLayerItem | LayerItem): LayerItem {
	if (typeof id === 'string') {
		const json = atob(id)
		return JSON.parse(json)
	}
	return id
}

export function resolveLayerItemsState(layerList: LL.List, history: MH.MatchDetails[]): LayerItemsState {
	const layerItems: OrderedLayerItems = []
	const firstLayerItemParity = history[0]?.ordinal ?? 0
	for (const entry of history) {
		layerItems.push(getLayerItemForMatchHistoryEntry(entry))
	}

	for (const item of layerList) {
		layerItems.push(getItemForLayerListItem(item))
	}

	return { layerItems, firstLayerItemParity }
}

// mirrors LL.splice with small changes
export function splice(list: LayerItem[], index: ItemIndex, deleteCount: number, ...items: LayerItem[]) {
	if (index.innerIndex !== null) {
		const parentItem = list[index.outerIndex]
		if (!isVoteListitem(parentItem)) throw new Error('Cannot splice non-vote item index on a vote choice')

		const newItems = Gen.map(iterItems(...items), res => res.item)
		const newSingleItems = Gen.filter(newItems, item => !isVoteListitem(item)) as Generator<SingleListItem>

		parentItem.choices.splice(
			index.innerIndex,
			deleteCount,
			...newSingleItems,
		)
		if (parentItem.choices.length === 0) {
			list.splice(index.outerIndex, 1)
		}
		if (parentItem.choices.length === 1) {
			// only one choice left, just make this a regular item
			const regularItem: LayerItem = {
				type: 'single-list-item',
				itemId: parentItem.itemId,
				layerId: parentItem.layerId,
			}
			list.splice(index.outerIndex, 1, regularItem)
		}
		if (!parentItem.voteDecided) {
			parentItem.layerId = parentItem.choices[0].layerId
		}
	} else {
		list.splice(index.outerIndex, deleteCount, ...items)
	}
}

export function resolveCursorIndex(
	orderedItemsState: LayerItemsState,
	cursor: Cursor,
): ItemIndex | null {
	const orderedItems = orderedItemsState.layerItems

	if (cursor.type === 'item-relative') {
		const { index } = Obj.destrNullable(findItemById(orderedItems, cursor.itemId))
		if (!index) {
			if (cursor.itemId === SpecialItemId.FIRST_LIST_ITEM || cursor.itemId === SpecialItemId.LAST_LIST_ITEM) {
				return { outerIndex: orderedItems.length, innerIndex: null }
			}
			return null
		}
		if (cursor.position === 'after') return LL.shiftIndex(index, 1)
		return index
	}

	if (cursor.type === 'index') {
		return cursor.index
	}

	assertNever(cursor)
}

export function resolveTeamParityForCursor(state: LayerItemsState, cursor: Cursor) {
	// if (!input.cursor)  return
	const index = resolveCursorIndex(state, cursor)
	return MH.getTeamParityForOffset({ ordinal: state.firstLayerItemParity }, index?.outerIndex ?? 0)
}

export function isLookbackTerminatingLayerItem(item: LayerItem): boolean {
	if (isVoteListitem(item)) return false
	const layer = L.toLayer(item.layerId)
	return layer && item.type === 'match-history-entry' && ['Seed', 'Training'].includes(layer.Gamemode as string)
}

export function getAllLayerIds(items: OrderedLayerItems) {
	const ids: L.LayerId[] = []
	for (const { item } of iterItems(...items)) {
		ids.push(item.layerId)
	}
	return ids
}

export function getItemForLayerListItem(item: LL.Item): LayerItem {
	if (LL.isVoteItem(item)) {
		const voteDecided = item.endingVoteState?.code === 'ended:winner'
		return {
			type: 'vote-list-item',
			itemId: item.itemId,
			voteDecided,
			layerId: item.layerId,
			choices: item.choices.map(choice => ({
				type: 'single-list-item',
				itemId: choice.itemId,
				layerId: choice.layerId,
			})),
		}
	}
	return {
		type: 'single-list-item',
		itemId: item.itemId,
		layerId: item.layerId,
	}
}

export function getLayerItemForMatchHistoryEntry(entry: MH.MatchDetails): LayerItem {
	return {
		type: 'match-history-entry',
		itemId: entry.historyEntryId,
		layerId: entry.layerId,
	}
}

export function getParityForLayerItem(state: LayerItemsState, item: LayerItem | string) {
	if (!state.layerItems) return 0
	const itemId = typeof item === 'string' ? item : item.itemId
	const { index } = Obj.destrNullable(LL.findItemById(state.layerItems, itemId))
	if (isNullOrUndef(index)) {
		console.warn('Item not found when getting parity, setting 0 instead', item)
		return 0
	}
	const parity = index.outerIndex + (state.firstLayerItemParity ?? 0)
	return parity
}

/**
 * Gets the query context for editing a particular layer item
 */
// export function getQueryCursorForLayerItem(
// 	_item: ParentVoteItem | LayerItem | SerialLayerItem,
// 	action: LayerItemCursorAction,
// ): Cursor {
// 	const itemId = typeof _item === 'string' ? _item : isParentVoteItem(_item) ? _item.parentItemId : toSerial(_item)
// 	return {
// 		type: 'id',
// 		action: action,
// 		itemId,
// 	}
// }

export function getQueryCursorForItemIndex(index: ItemIndex): Cursor {
	return {
		type: 'index',
		index,
	}
}

export const LayerTableConfigSchema = z.object({
	orderedColumns: z.array(
		z.object({ name: z.string(), visible: z.boolean().optional().describe('default true') }),
	),
	defaultSortBy: LayersQuerySortSchema,
	extraLayerSelectMenuItems: z.array(F.EditableComparisonSchema).optional(),
	defaultExtraFilters: z.array(F.FilterEntityIdSchema).optional(),
})

export type LayerTableConfig = z.infer<typeof LayerTableConfigSchema>

export type EffectiveColumnAndTableConfig = LayerTableConfig & LC.EffectiveColumnConfig

export function getDefaultColVisibilityState(cfg: EffectiveColumnAndTableConfig): VisibilityState {
	const res = Object.fromEntries(
		Object.values(cfg.defs).map(col => {
			const colDef = cfg.orderedColumns.find(c => c.name === col.name)
			const visible = colDef ? (colDef.visible ?? true) : false
			return [col.name, visible]
		}),
	)
	return res
}

export type ExtraQueryFiltersActions = {
	select: React.Dispatch<React.SetStateAction<F.FilterEntityId[]>>
	remove: (filterId: F.FilterEntityId) => void
}

export type ApplyAs = 'regular' | 'inverted'
export type FilterApplication = { filterId: F.FilterEntityId; applyAs: ApplyAs }

export type ExtraQueryFiltersState = {
	extraFilters: Set<F.FilterEntityId>
}

export type ExtraQueryFiltersStore = ExtraQueryFiltersActions & ExtraQueryFiltersState

export function getSeed() {
	const bytes = crypto.getRandomValues(new Uint8Array(8))
	return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}
