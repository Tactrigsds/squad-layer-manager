import * as Gen from '@/lib/generator'
import * as Obj from '@/lib/object'
import { assertNever, isNullOrUndef } from '@/lib/type-guards'
import * as CB from '@/models/constraint-builders'
import { VisibilityState } from '@tanstack/react-table'
import * as Im from 'immer'
import { z } from 'zod'
import * as F from './filter.models'
import * as L from './layer'
import * as LC from './layer-columns'
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

export type ViewableConstraint = Exclude<Constraint, { indicateMatches: false }>

export const LAYERS_QUERY_SORT_DIRECTION = z.enum(['ASC', 'DESC', 'ASC:ABS', 'DESC:ABS'])
export type LayersQuerySortDirection = z.infer<typeof LAYERS_QUERY_SORT_DIRECTION>
export const LayersQuerySortSchema = z
	.discriminatedUnion('type', [
		z.object({
			type: z.literal('column'),
			sortBy: z.string(),
			direction: LAYERS_QUERY_SORT_DIRECTION.optional().default('ASC'),
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

export type LayerComponentInput = BaseQueryInput & { column: LC.GroupByColumn }

export type LayerExistsInput = L.LayerId[]

export type SearchIdsInput = {
	queryString: string
	constraints?: Constraint[]
}

export type LayerItemStatusesInput = BaseQueryInput & { numHistoryEntriesToResolve?: number }

export type LayerItemStatuses = {
	present: Set<L.LayerId>
	matchDescriptors: Map<ItemId, MatchDescriptor[]>
}

export type LayerItemStatusesPart = { layerItemStatuses: LayerItemStatuses }

type LayerItemPatch = {
	type: 'splice'
	cursor: Cursor
	deleteCount: number
	insertions?: LayerItem[]
}

export const LAYER_ITEM_ACTION = z.enum(['add', 'edit'])
export type LayerItemAction = z.infer<typeof LAYER_ITEM_ACTION>

export type BaseQueryInput = {
	constraints?: Constraint[]

	// no cursor or action == repeat rules ignored
	cursor?: Cursor
	action?: LayerItemAction

	patches?: LayerItemPatch[]
}

export function mergeBaseInputs(a: BaseQueryInput, b: BaseQueryInput): BaseQueryInput {
	return {
		constraints: [...(a.constraints || []), ...(b.constraints || [])],
		cursor: b.cursor || a.cursor,
		patches: [...(a.patches || []), ...(b.patches || [])],
	}
}

export type ItemIndex = LL.ItemIndex

// literally just LL.Cursor currently except differnt id
export type Cursor = {
	type: 'item-relative'
	itemId: ItemId
	position: 'before' | 'after' | 'on'
} | {
	type: 'index'
	index: ItemIndex
} | {
	type: 'start'
} | {
	type: 'end'
}

export type GenLayerQueueItemsOptions = {
	numToAdd: number
	numVoteChoices: number
	itemType: 'layer' | 'vote'
	baseFilterId?: F.FilterEntityId
}

export function getEditFilterPageInput(filter: F.FilterNode): BaseQueryInput {
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
}
export type FilterEntityMatchDescriptor = {
	type: 'filter-entity'
	constraintId: string
	itemId?: ItemId
}
export type MatchDescriptor = RepeatMatchDescriptor | FilterEntityMatchDescriptor

export function resolveRepeatedLayerProperties(descriptors: MatchDescriptor[], teamParity: number) {
	const violatedFields: Map<ItemId, MatchDescriptor> = new Map()
	for (const descriptor of descriptors) {
		if (descriptor.type === 'filter-entity') continue
		if (descriptor.type === 'repeat-rule') {
			switch (descriptor.field) {
				case 'Map':
				case 'Layer':
				case 'Size':
				case 'Gamemode':
					violatedFields.set(descriptor.field, descriptor)
					break
				case 'Faction_A':
					violatedFields.set(MH.getTeamNormalizedFactionProp(teamParity, 'A'), descriptor)
					break
				case 'Faction_B':
					violatedFields.set(MH.getTeamNormalizedFactionProp(teamParity, 'B'), descriptor)
					break
				case 'Alliance_A':
					violatedFields.set(MH.getTeamNormalizedAllianceProp(teamParity, 'A'), descriptor)
					break
				case 'Alliance_B':
					violatedFields.set(MH.getTeamNormalizedAllianceProp(teamParity, 'B'), descriptor)
					break
				default:
					assertNever(descriptor.field)
			}
			continue
		}
		assertNever(descriptor)
	}
	return violatedFields
}

export function getFactionAndUnitValue(faction: string, unit: string | null | undefined) {
	return faction + '_' + unit || ''
}

export type ItemId = LL.ItemId | number
export type SingleListItem = {
	type: 'single-list-item'
	itemId: LL.ItemId
	layerId: L.LayerId
} & LL.SparseSingleItem

// uniquely identifies positions layers can appear within the application's state
// TODO this has become awkwardly structured after changes to layer list items
export type VoteListItem = {
	type: 'vote-list-item'
	choices: LL.SparseSingleItem[]
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
	return LL.isVoteItem(item)
}

export function coalesceLayerItems(item: LayerItem) {
	return isVoteListitem(item) ? item.choices : [item]
}

export type LayerItemsIterResult = { index: ItemIndex; item: LayerItem }
export const IterItems = LL.iterItems

export function findItemById(items: LayerItem[], itemId: ItemId): LayerItemsIterResult | undefined {
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
export function toSerial(item: LayerItem | SerialLayerItem) {
	if (typeof item === 'string') {
		return item
	}
	const json = JSON.stringify(item)
	return btoa(json)
}

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

	for (const { item } of LL.iterItems(...layerList)) {
		layerItems.push(getItemForLayerListItem(item))
	}

	return { layerItems, firstLayerItemParity }
}

// mirrors LL.splice with small changes
export function splice(list: LayerItem[], index: ItemIndex, deleteCount: number, ...items: LayerItem[]) {
	if (index.innerIndex !== null) {
		const parentItem = list[index.outerIndex]
		if (!isVoteListitem(parentItem)) throw new Error('Cannot splice non-vote item index on a vote choice')

		let newItems = Gen.map(IterItems(...items), res => res.item)
		newItems = Gen.filter(newItems, item => !isVoteListitem(item))

		parentItem.choices.splice(
			index.innerIndex,
			deleteCount,
			...newItems,
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
export function applyItemStatePatches(baseState: LayerItemsState, input: Pick<BaseQueryInput, 'patches'>) {
	if (!input.patches || input.patches.length === 0) return baseState
	return Im.produce(baseState, (draft) => {
		for (const patch of input.patches!) {
			const index = resolveCursorIndex(draft, patch.cursor)
			if (!index) throw new Error('Invalid cursor')
			switch (patch.type) {
				case 'splice':
					splice(baseState.layerItems, index, patch.deleteCount, ...(patch.insertions ?? []))
					break
				default:
					assertNever(patch.type)
			}
		}
	})
}

export function resolveCursorIndex(
	orderedItemsState: LayerItemsState,
	cursor: Cursor,
): ItemIndex {
	const orderedItems = orderedItemsState.layerItems

	if (cursor.type === 'item-relative') {
		const { index } = Obj.destrNullable(findItemById(orderedItems, cursor.itemId))
		if (!index) throw new Error('Invalid cursor ' + JSON.stringify(cursor))
		if (cursor.position === 'after') return LL.shiftIndex(index, 1)
		return index
	}

	if (cursor.type === 'index') {
		return cursor.index
	}

	if (cursor.type === 'start') {
		return { outerIndex: 0, innerIndex: null }
	}

	if (cursor.type === 'end') {
		return { outerIndex: orderedItems.length, innerIndex: null }
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
	for (const { item } of IterItems(...items)) {
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
			choices: item.choices!.map(choice => ({
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

export function getParityForLayerItem(state: LayerItemsState, _item: LayerItem | SerialLayerItem) {
	const item = typeof _item === 'string' ? fromSerial(_item) : _item

	if (!state.layerItems) return 0
	const { index } = Obj.destrNullable(LL.findItemById(state.layerItems, item.itemId))
	if (isNullOrUndef(index)) throw new Error('Item not found')
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
	return Math.floor(Math.random() * Number.MAX_SAFE_INTEGER).toString()
}
