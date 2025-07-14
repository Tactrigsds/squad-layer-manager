import * as Arr from '@/lib/array'
import * as OneToMany from '@/lib/one-to-many-map'
import { isNullOrUndef } from '@/lib/type-guards'
import * as FB from '@/models/filter-builders'
import * as SS from '@/models/server-state.models'
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
} & LayerQueryContext

export type LayerComponentsInput = LayerQueryContext

export type LayerExistsInput = L.LayerId[]

export type SearchIdsInput = {
	queryString: string
	constraints?: LayerQueryConstraint[]
}

export type LayerStatusesForLayerQueueInput = LayerQueryContext & {
	// the number of history entries to resolve statuses for before the layer queue
	numHistoryEntriesToResolve?: number
}

export type LayerQueryContext = {
	constraints?: LayerQueryConstraint[]

	// "layer items" to be considered as part of the history
	previousLayerItems?: OrderedLayerItems
	firstLayerItemParity?: number
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

type ParentVoteItem = { parentItemId: string; choices: VoteChoiceLayerItem[] }
export type OrderedLayerItems = (LayerItem | ParentVoteItem)[]
export function isParentVoteItem(item: ParentVoteItem | LayerItem): item is ParentVoteItem {
	return !!(item as any).parentItemId
}

export function coalesceLayerItems(item: ParentVoteItem | LayerItem) {
	return isParentVoteItem(item) ? item.choices : [item]
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

export function resolveAllOrderedLayerItems(layerList: LL.LayerList, history: MH.MatchDetails[]) {
	const orderedItems: OrderedLayerItems = []
	const firstLayerItemParity = history[0]?.ordinal ?? 0
	for (const entry of history) {
		orderedItems.push(getLayerItemForMatchHistoryEntry(entry))
	}

	for (const listItem of layerList) {
		if (listItem.vote) {
			const choiceItems: VoteChoiceLayerItem[] = []
			for (let i = 0; i < listItem.vote.choices.length; i++) {
				choiceItems.push(getLayerItemForVoteItem(listItem, i))
			}
			const parent: ParentVoteItem = { parentItemId: listItem.itemId, choices: choiceItems }
			orderedItems.push(parent)
		} else {
			orderedItems.push(getLayerItemForListItem(listItem))
		}
	}
	return { previousLayerItems: orderedItems, firstLayerItemParity }
}

export function resolveRelevantOrderedItemsForQuery(
	orderedItems?: OrderedLayerItems,
	constraints?: LayerQueryConstraint[],
	opts?: { onlyCheckingWhere?: boolean },
) {
	opts ??= {}
	opts.onlyCheckingWhere ??= false
	orderedItems ??= []
	constraints ??= []
	const relevantItems: OrderedLayerItems = []
	let maxLookback = 0
	for (const constraint of constraints) {
		if (constraint.type !== 'do-not-repeat') continue
		if (opts.onlyCheckingWhere && constraint.applyAs !== 'where-condition') continue
		maxLookback = Math.max(maxLookback, constraint.rule.within)
	}

	for (let i = orderedItems.length - 1; i >= 0; i--) {
		const item = orderedItems[i]

		if (maxLookback < (orderedItems.length - i)) {
			break
		}

		const layer = !isParentVoteItem(item) ? L.toLayer(item.layerId) : undefined
		if (!isParentVoteItem(item) && item.type === 'match-history-entry' && ['Seed', 'Training'].includes(layer!.Gamemode as string)) {
			break
		}
		relevantItems.push(item)
	}

	return relevantItems.reverse()
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

export function getParityForLayerItem(context: LayerQueryContext, _item: LayerItem | LayerItemId) {
	const item = typeof _item === 'string' ? fromLayerItemId(_item) : _item

	if (!context.previousLayerItems) return 0
	const itemIndex = context.previousLayerItems.findIndex(elt => coalesceLayerItems(elt).some(currItem => deepEqual(currItem, item)))
	if (isNullOrUndef(itemIndex)) throw new Error('Item not found')
	const parity = itemIndex + (context.firstLayerItemParity ?? 0)
	return parity
}

/**
 * Gets the query context for editing a particular layer item
 */
export function getQueryContextForEditedItem(
	context: LayerQueryContext,
	_item: LayerItem | LayerItemId,
): LayerQueryContext {
	if (!context.previousLayerItems) return context
	const item = typeof _item === 'string' ? fromLayerItemId(_item) : _item
	const index = context.previousLayerItems.findIndex(elt => coalesceLayerItems(elt).some(currItem => deepEqual(currItem, item)))
	const constraints = context.constraints ?? []
	if (index === -1) return context
	if (item.type === 'vote-item') {
		const parentItem = context.previousLayerItems[index]
		if (isParentVoteItem(parentItem)) {
			const layerIds: LayerItemId[] = []
			for (const currentItem of parentItem.choices) {
				layerIds.push(currentItem.layerId)
			}
			const filter = FB.comp(FB.inValues('id', layerIds), { neg: true })
			constraints.push(filterToConstraint(filter, 'vote-choice-sibling-exclusion-' + index))
		}
	}
	return {
		...context,
		previousLayerItems: context.previousLayerItems?.slice(0, index),
	}
}

// assumes current item at index will be shifted to the right if one exists
export function getQueryContextForInsertAtQueueIndex(context: LayerQueryContext, index: number) {
	if (!context.previousLayerItems) return context
	const layerItems = [...context.previousLayerItems]
	let firstQueueItemIdx = -1
	for (let i = 0; i < layerItems.length; i++) {
		const item = layerItems[i]
		if (!isParentVoteItem(item) && item.type === 'match-history-entry') continue
		firstQueueItemIdx = i
		break
	}
	let insertAtIndex: number
	if (firstQueueItemIdx === -1) insertAtIndex = layerItems.length
	else insertAtIndex = insertAtIndex = index

	return {
		...context,
		previousLayerItems: layerItems.slice(0, insertAtIndex),
	}
}

export function getQueryContextForAddingVoteChoice(
	context: LayerQueryContext,
	editedItemId: string,
) {
	if (!context.previousLayerItems) return context
	const index = context.previousLayerItems.findIndex(item => isParentVoteItem(item) && item.parentItemId === editedItemId)
	if (index === -1) return context
	const parentItem = context.previousLayerItems[index] as ParentVoteItem

	const constraints = context.constraints ? [...context.constraints] : []
	const layerIds: L.LayerId[] = []
	for (const currentItem of parentItem.choices) {
		layerIds.push(currentItem.layerId)
	}
	const filter = FB.comp(FB.inValues('id', layerIds), { neg: true })
	constraints.push(filterToConstraint(filter, 'vote-choice-sibling-exclusion-' + index))
	return {
		...context,
		previousLayerItems: context.previousLayerItems?.slice(0, index),
	}
}

export function getQueryContextForAfterItem(
	context: LayerQueryContext,
	_item: LayerItem | LayerItemId,
): LayerQueryContext {
	if (!context.previousLayerItems) return context
	const layerItem = typeof _item === 'string' ? fromLayerItemId(_item) : _item
	let index = context.previousLayerItems.findIndex(elt => coalesceLayerItems(elt).some(currItem => deepEqual(currItem, layerItem)))
	if (index === undefined) {
		console.warn('Item not found in previousLayerItems: ', layerItem)
		index = context.previousLayerItems.length - 1
	}
	return {
		...context,
		previousLayerItems: context.previousLayerItems.slice(0, index + 1),
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
