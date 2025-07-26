import * as OneToMany from '@/lib/one-to-many-map'
import { assertNever, isNullOrUndef } from '@/lib/type-guards'
import * as FB from '@/models/filter-builders'
import deepEqual from 'fast-deep-equal'
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
	label: z.string().min(1).max(100).optional().describe('A label for the rule'),
	targetValues: z.array(z.string()).optional().describe('A "Whitelist" of values which the rule applies to'),
	within: z.number().min(0).max(50).describe('the number of matches in which this rule applies. if 0, the rule should be ignored'),
})
export type RepeatRule = z.infer<typeof RepeatRuleSchema>
export function valueFilteredByTargetValues(rule: RepeatRule, value?: string): boolean {
	if (!rule.targetValues || rule.targetValues.length === 0) return false
	return !rule.targetValues.includes(value as string)
}

export type LayerQueryConstraint =
	| {
		type: 'filter-anon'
		filter: F.FilterNode
		applyAs: 'field' | 'where-condition'
		name?: string
		id: string
	}
	| {
		type: 'filter-entity'
		filterEntityId: F.FilterEntityId
		applyAs: 'field' | 'where-condition'
		name?: string
		id: string
	}
	| {
		type: 'do-not-repeat'
		rule: RepeatRule
		applyAs: 'field' | 'where-condition'
		name?: string
		id: string
	}
export type NamedQueryConstraint = LayerQueryConstraint & { name: string }

export function filterToNamedConstrant(
	filter: F.FilterNode,
	id: string,
	name: string,
	applyAs: LayerQueryConstraint['applyAs'] = 'where-condition',
): NamedQueryConstraint {
	return {
		type: 'filter-anon',
		filter,
		applyAs,
		name,
		id,
	}
}

export function filterToConstraint(
	filter: F.FilterNode,
	id: string,
	applyAs: LayerQueryConstraint['applyAs'] = 'where-condition',
): LayerQueryConstraint {
	return {
		type: 'filter-anon',
		filter,
		applyAs,
		id,
	}
}

export function filterEntityToConstraint(
	filterEntity: F.FilterEntity,
	id: string,
	applyAs: LayerQueryConstraint['applyAs'] = 'where-condition',
): LayerQueryConstraint {
	return {
		type: 'filter-entity',
		filterEntityId: filterEntity.id,
		id,
		applyAs,
	}
}

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

export type LayersQuerySort = z.infer<typeof LayersQuerySortSchema>

export const DEFAULT_SORT: LayersQuerySort = {
	type: 'column',
	sortBy: 'Asymmetry_Score',
	sortDirection: 'ASC',
}
export const DEFAULT_PAGE_SIZE = 20

export type LayersQueryInput = {
	pageIndex?: number
	pageSize?: number
	sort?: LayersQuerySort
} & LayerQueryBaseInput

export type LayerComponentInput = LayerQueryBaseInput & { column: LC.GroupByColumn }

export type LayerExistsInput = L.LayerId[]

export type SearchIdsInput = {
	queryString: string
	constraints?: LayerQueryConstraint[]
}

export type LayerItemStatusesInput = LayerQueryBaseInput & { numHistoryEntriesToResolve?: number }

export type LayerItemStatuses = {
	blocked: OneToMany.OneToManyMap<string, string>
	present: Set<string>
	violationDescriptors: Map<string, ViolationDescriptor[]>
}

export type LayerItemStatusesPart = { layerItemStatuses: LayerItemStatuses }

export type LayerQueryBaseInput = {
	constraints?: LayerQueryConstraint[]
	cursor?: LayerQueryCursor
}

type LayerVoteItemCursorAction = 'add-after' | 'edit' | 'add-vote-choice'
export type LayerQueryCursor = {
	type: 'id'
	// could be LayerItemId or itemId for parent layer queue item
	itemId: LayerItemId | string
	action: LayerVoteItemCursorAction
} | {
	type: 'layer-queue-index'
	index: number
} | {
	type: 'layer-item-index'
	index: number
}

export type GenLayerQueueItemsOptions = {
	numToAdd: number
	numVoteChoices: number
	itemType: 'layer' | 'vote'
	baseFilterId?: F.FilterEntityId
}

export function getEditedFilterConstraint(filter: F.FilterNode): LayerQueryConstraint {
	return { type: 'filter-anon', id: 'edited-filter', filter, applyAs: 'where-condition' }
}

export type LayerStatuses = {
	// keys are (itemId:(choiceLayerId)?)
	blocked: OneToMany.OneToManyMap<string, string>
	present: Set<L.LayerId>
	violationDescriptors: Map<string, ViolationDescriptor[]>
}

export type ViolationDescriptor = {
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
	reasonItem?: LayerItem
}

export function resolveViolatedLayerProperties(descriptors: ViolationDescriptor[], teamParity: number) {
	const violatedFields = new Set<string>()
	for (const descriptor of descriptors) {
		// Map ViolationDescriptor fields to KnownLayer fields
		switch (descriptor.field) {
			case 'Faction_A':
				violatedFields.add(MH.getTeamNormalizedFactionProp(teamParity, 'A'))
				break
			case 'Faction_B':
				violatedFields.add(MH.getTeamNormalizedFactionProp(teamParity, 'B'))
				break
			case 'Alliance_A':
				violatedFields.add(MH.getTeamNormalizedAllianceProp(teamParity, 'A'))
				break
			case 'Alliance_B':
				violatedFields.add(MH.getTeamNormalizedAllianceProp(teamParity, 'B'))
				break
			default:
				violatedFields.add(descriptor.field)
				break
		}
	}
	return violatedFields
}

export function getFactionAndUnitValue(faction: string, unit: string | null | undefined) {
	return faction + '_' + unit || ''
}

type LayerItemPartsCommon = {
	layerId: L.LayerId
}

// uniquely identifies positions layers can appear within the application's state
export type LayerItem =
	| LayerItemPartsCommon & {
		type: 'list-item'
		itemId: string
	}
	| VoteChoiceLayerItem
	| LayerItemPartsCommon & {
		type: 'match-history-entry'
		historyEntryId: number
	}

type VoteChoiceLayerItem = LayerItemPartsCommon & {
	type: 'vote-item'
	itemId: string
	choiceIndex: number
}
export type LayerItemsState = {
	layerItems: OrderedLayerItems
	firstLayerItemParity: number
}

type ParentVoteItem = { type: 'parent-vote-item'; parentItemId: string; choices: VoteChoiceLayerItem[] }
export type OrderedLayerItems = (LayerItem | ParentVoteItem)[]
export function isParentVoteItem(item: ParentVoteItem | LayerItem): item is ParentVoteItem {
	return !!(item as any).parentItemId
}

export function coalesceLayerItems(item: ParentVoteItem | LayerItem) {
	return isParentVoteItem(item) ? item.choices : [item]
}
function layerItemsEqual(a: LayerItem | string | ParentVoteItem, b: LayerItem | string | ParentVoteItem) {
	const aStr = typeof a === 'string' ? a : a.type === 'parent-vote-item' ? a.parentItemId : toLayerItemId(a)
	const bStr = typeof b === 'string' ? b : b.type === 'parent-vote-item' ? b.parentItemId : toLayerItemId(b)
	return aStr === bStr
}

export function* iterLayerItems(items: OrderedLayerItems): Generator<LayerItem> {
	for (const item of items) {
		if (isParentVoteItem(item)) {
			yield* iterLayerItems(item.choices)
		} else {
			yield item
		}
	}
}

export type LayerItemId = string
export function toLayerItemId(item: LayerItem) {
	switch (item.type) {
		case 'list-item':
			return `l:${item.layerId}:${item.itemId}`
		case 'vote-item':
			return `v:${item.layerId}:${item.itemId}:${item.choiceIndex}`
		case 'match-history-entry':
			return `h:${item.layerId}:${item.historyEntryId}`
	}
}

export function fromLayerItemId(id: LayerItemId): LayerItem {
	const parts = id.split(':')
	if (parts[0] === 'l') {
		return {
			type: 'list-item',
			layerId: parts[1] as L.LayerId,
			itemId: parts[2],
		}
	} else if (parts[0] === 'v') {
		return {
			type: 'vote-item',
			layerId: parts[1] as L.LayerId,
			itemId: parts[2],
			choiceIndex: parseInt(parts[3]),
		}
	} else if (parts[0] === 'h') {
		return {
			type: 'match-history-entry',
			layerId: parts[1] as L.LayerId,
			historyEntryId: parseInt(parts[2]),
		}
	}
	throw new Error(`Invalid LayerItemId: ${id}`)
}

export function resolveLayerItemsState(layerList: LL.LayerList, history: MH.MatchDetails[]): LayerItemsState {
	const layerItems: OrderedLayerItems = []
	const firstLayerItemParity = history[0]?.ordinal ?? 0
	for (const entry of history) {
		layerItems.push(getLayerItemForMatchHistoryEntry(entry))
	}

	for (const listItem of layerList) {
		if (listItem.vote) {
			const choiceItems: VoteChoiceLayerItem[] = []
			for (let i = 0; i < listItem.vote.choices.length; i++) {
				choiceItems.push(getLayerItemForVoteItem(listItem, i))
			}
			const parent: ParentVoteItem = { type: 'parent-vote-item', parentItemId: listItem.itemId, choices: choiceItems }
			layerItems.push(parent)
		} else {
			layerItems.push(getLayerItemForListItem(listItem))
		}
	}
	return { layerItems, firstLayerItemParity }
}

export function resolveCursorIndex(
	orderedItemsState: LayerItemsState,
	input: LayerQueryBaseInput,
) {
	const orderedItems = orderedItemsState.layerItems
	const cursor = input.cursor
	if (!cursor) return orderedItemsState.layerItems.length

	if (cursor.type === 'id') {
		const id = cursor.itemId
		const itemIndex = orderedItems.findIndex(item =>
			layerItemsEqual(item, id) || coalesceLayerItems(item).some(item => toLayerItemId(item) === id)
		)
		if (itemIndex === -1) {
			throw new Error(`Item with ID ${id} not found`)
		}
		if (cursor.action === 'add-after') {
			return itemIndex + 1
		} else if (cursor.action === 'edit' || cursor.action === 'add-vote-choice') {
			return itemIndex
		} else {
			assertNever(cursor.action)
		}
	}
	if (cursor.type === 'layer-queue-index') {
		let lastHistoryEntryIndex = -1
		for (let i = orderedItems.length - 1; i >= 0; i--) {
			const item = orderedItems[i]
			if (item.type === 'match-history-entry') {
				lastHistoryEntryIndex = i
				break
			}
		}
		return lastHistoryEntryIndex + 1 + cursor.index
	}

	if (cursor.type === 'layer-item-index') {
		return cursor.index
	}
	assertNever(cursor)
}

export function isLookbackTerminatingLayerItem(item: LayerItem | ParentVoteItem): boolean {
	if (isParentVoteItem(item)) return false
	const layer = L.toLayer(item.layerId)
	return layer && item.type === 'match-history-entry' && ['Seed', 'Training'].includes(layer.Gamemode as string)
}

export function getAllLayerIds(items: OrderedLayerItems) {
	const ids: L.LayerId[] = []
	for (const item of iterLayerItems(items)) {
		ids.push(item.layerId)
	}
	return ids
}

export function getLayerItemForListItem(item: LL.LayerListItem): LayerItem {
	return {
		type: 'list-item',
		itemId: item.itemId,
		layerId: LL.getActiveItemLayerId(item),
	}
}

export function getLayerItemForVoteItem(item: LL.LayerListItem, choiceIndex: number): VoteChoiceLayerItem {
	return {
		type: 'vote-item',
		itemId: item.itemId,
		layerId: item.vote!.choices[choiceIndex],
		choiceIndex: choiceIndex,
	}
}

export function getLayerItemForMatchHistoryEntry(entry: MH.MatchDetails): LayerItem {
	return {
		type: 'match-history-entry',
		historyEntryId: entry.historyEntryId,
		layerId: entry.layerId,
	}
}

export function getParityForLayerItem(state: LayerItemsState, _item: LayerItem | LayerItemId) {
	const item = typeof _item === 'string' ? fromLayerItemId(_item) : _item

	if (!state.layerItems) return 0
	const itemIndex = state.layerItems.findIndex(elt => coalesceLayerItems(elt).some(currItem => deepEqual(currItem, item)))
	if (isNullOrUndef(itemIndex)) throw new Error('Item not found')
	const parity = itemIndex + (state.firstLayerItemParity ?? 0)
	return parity
}

/**
 * Gets the query context for editing a particular layer item
 */
export function getQueryCursorForLayerItem(
	_item: ParentVoteItem | LayerItem | LayerItemId,
	action: LayerVoteItemCursorAction,
): LayerQueryCursor {
	const itemId = typeof _item === 'string' ? _item : isParentVoteItem(_item) ? _item.parentItemId : toLayerItemId(_item)
	return {
		type: 'id',
		action: action,
		itemId,
	}
}

export function getBaseQueryInputForVoteChoice(
	layerItemsState: LayerItemsState,
	constraints: LayerQueryConstraint[],
	parentItemId: string,
): LayerQueryBaseInput {
	const parentItem = layerItemsState.layerItems.find(item => item.type === 'parent-vote-item' && item.parentItemId === parentItemId)
	const cursor: LayerQueryCursor = {
		type: 'id',
		action: 'edit',
		itemId: parentItemId,
	}
	if (!parentItem) return { constraints, cursor }
	const layerIds: L.LayerId[] = []
	for (const currentItem of (parentItem as ParentVoteItem).choices) {
		layerIds.push(currentItem.layerId)
	}
	const filter = FB.comp(FB.inValues('id', layerIds), { neg: true })
	constraints.push(filterToConstraint(filter, 'vote-choice-sibling-exclusion:' + parentItemId))

	return {
		constraints,
		cursor,
	}
}

// assumes current item at index will be shifted to the right if one exists
export function getQueryCursorForQueueIndex(index: number): LayerQueryCursor {
	return {
		type: 'layer-queue-index',
		index,
	}
}

export function getQueryCursorForItemIndex(index: number): LayerQueryCursor {
	return {
		type: 'layer-item-index',
		index,
	}
}

export const LayerTableConfigSchema = z.object({
	orderedColumns: z.array(z.object({ name: z.string(), visible: z.boolean().optional().describe('default true') })),
	defaultSortBy: LayersQuerySortSchema,
})

export type LayerTableConfig = z.infer<typeof LayerTableConfigSchema>

export type EffectiveColumnAndTableConfig = LayerTableConfig & LC.EffectiveColumnConfig

export function getColVisibilityState(cfg: EffectiveColumnAndTableConfig) {
	return Object.fromEntries(
		Object.values(cfg.defs).map(col => {
			const colDef = cfg.orderedColumns.find(c => c.name === col.name)
			const visible = colDef ? (colDef.visible ?? true) : false
			return [col.name, visible]
		}),
	)
}
