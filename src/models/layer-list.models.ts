import * as DH from '@/lib/display-helpers'
import * as Generator from '@/lib/generator'
import * as ItemMut from '@/lib/item-mutations'
import { assertNever } from '@/lib/type-guards'
import * as DND from '@/models/dndkit.models'
import * as USR from '@/models/users.models'
import * as V from '@/models/vote.models'
import { z } from 'zod'
import { createId } from '../lib/id'
import * as L from './layer'
import { iterLayerItems } from './layer-queries.models'

export const SourceSchema = z.discriminatedUnion('type', [
	z.object({ type: z.literal('generated') }),
	z.object({ type: z.literal('gameserver') }),
	z.object({ type: z.literal('unknown') }),
	z.object({ type: z.literal('manual'), userId: USR.UserIdSchema }),
])

export type Source = z.infer<typeof SourceSchema>
export const ItemIdSchema = z.string().regex(/^[a-zA-Z0-9_-]{6,24}$/)
export type ItemId = z.infer<typeof ItemIdSchema>

export const InnerLayerListItemSchema = z.object({
	itemId: ItemIdSchema,
	layerId: L.LayerIdSchema,
	source: SourceSchema,
})
export type InnerLayerListItem = z.infer<typeof InnerLayerListItemSchema>

export const NewLayerListItemSchema = z.object({
	// optional so that it can be lazily determined if convenient
	itemId: ItemIdSchema.optional(),
	layerId: L.LayerIdSchema,
	choices: z.array(InnerLayerListItemSchema).min(1).optional(),

	// this is fully optional
	voteConfig: V.AdvancedVoteConfigSchema.partial().extend({ source: SourceSchema }).optional(),

	// should set after a vote has been resolved
	endingVoteState: V.EndingVoteStateSchema.optional(),

	// TODO why is this not in voteConfig??
	displayProps: z.lazy(() => z.array(DH.LAYER_DISPLAY_PROP).optional()),
})

export type NewLayerListItem = z.infer<typeof NewLayerListItemSchema>

export const LayerListItemSchema = NewLayerListItemSchema.extend({
	itemId: ItemIdSchema,
	source: SourceSchema,
})
	.refine((item) => {
		if (!isParentVoteItem(item)) return true
		const choiceSet = new Set<string>()
		for (const choice of item.choices!) {
			if (choiceSet.has(choice.layerId)) return false
			choiceSet.add(choice.layerId)
		}
		return true
	}, { message: 'Duplicate layer IDs in choices' })
	.refine((item): boolean => {
		if (!isParentVoteItem(item)) return true
		return item.choices!.some(choice => choice.layerId === item.layerId)
	}, { message: 'The parent layerId must be included in the choices' })
	.refine((item): boolean => {
		if (!isParentVoteItem(item)) return true
		if (item.endingVoteState && item.endingVoteState.code === 'ended:winner') return true
		return !!item.choices && item.choices[0].layerId === item.layerId
	}, { message: "if vote isn't complete, then the layerId should always be the first layer choice" })

const Index = z.number().min(0)

export const LayerListItemIndex = z.object({
	outerIndex: Index,
	innerIndex: Index.nullable(),
})

export const LayerListItemRelativeCursor = z.object({
	itemId: ItemIdSchema,
	position: z.enum(['before', 'after', 'on']),
})

export type ParentVoteItem = Item & {
	choices: InnerLayerListItem[]
	voteConfig: V.AdvancedVoteConfig
	voteDisplayProps?: DH.LayerDisplayProp[]
}

export const ItemRelativeCursorSchema = z.object({
	itemId: ItemIdSchema,
	position: z.enum(['before', 'after', 'on']),
})

export type ItemRelativeCursor = z.infer<typeof ItemRelativeCursorSchema>

export type ItemIndex = {
	outerIndex: number
	innerIndex: number | null
}

export type LayerListIteratorResult = ItemIndex & {
	item: Item | InnerLayerListItem
}

export const ListSchema = z.array(LayerListItemSchema)

export type List = z.infer<typeof ListSchema>
export type Item = z.infer<typeof LayerListItemSchema>

export function getActiveItemLayerId(item: Item) {
	return item.layerId
}
export function getDefaultLayerId(item: Item & { choices: InnerLayerListItem[] }) {
	return item.choices[0].layerId
}

export function layerItemToDragItem(item: Pick<Item, 'itemId'>): DND.DragItem {
	return {
		id: item.itemId,
		type: 'layer-item',
	}
}
export function llItemCursorsToDropItem(cursors: ItemRelativeCursor[]): DND.DropItem {
	return {
		type: 'relative-to-drag-item',
		slots: cursors.map(cursor => ({
			dragItem: layerItemToDragItem({ itemId: cursor.itemId }),
			position: cursor.position,
		})),
	}
}

export function resolveParentVoteItem(itemId: ItemId, list: List): ParentVoteItem | undefined {
	const itemRes = findItemById(list, itemId)
	if (!itemRes) return
	if (!isParentVoteItem(itemRes.item)) return
	return itemRes.item
}

export function dropItemToLLItemCursors(dropItem: DND.DropItem): ItemRelativeCursor[] {
	if (dropItem.type !== 'relative-to-drag-item') {
		return []
	}
	const slots: ItemRelativeCursor[] = []

	for (const slot of dropItem.slots) {
		if (slot.dragItem.type === 'layer-item') {
			slots.push({
				itemId: slot.dragItem.id as ItemId,
				position: slot.position,
			})
		}
	}
	return slots
}

export function resolveQualfiedIndexFromCursorForMove(list: List, cursor: ItemRelativeCursor): ItemIndex | undefined {
	const itemRes = findItemById(list, cursor.itemId)
	if (!itemRes) return undefined
	if (cursor.position === 'before' || cursor.position === 'on') return itemRes
	if (itemRes.innerIndex !== null) {
		// we'll shift item up
		if (cursor.position === 'after') return { innerIndex: itemRes.innerIndex + 1, outerIndex: itemRes.outerIndex }
		assertNever(cursor.position)
	}
	if (cursor.position === 'after') return { innerIndex: itemRes.innerIndex, outerIndex: itemRes.outerIndex + 1 }
	assertNever(cursor.position)
}

export function createLayerListItemId() {
	return createId(24)
}

export function createLayerListItem(newItem: NewLayerListItem, source: Source): Item {
	return {
		itemId: newItem.itemId ?? createLayerListItemId(),
		source,
		...newItem,
	}
}

export function getNextLayerId(layerQueue: List) {
	if (layerQueue.length === 0) return
	return layerQueue[0].layerId
}

export function isParentVoteItem(item: Item): item is ParentVoteItem {
	return !!item.choices
}

export function isChildItem(itemId: ItemId, parentItemId: ItemId, layerList: List): boolean {
	const parentItem = findParentItem(layerList, itemId)
	if (!parentItem || parentItem.itemId === itemId) return false
	return true
}

export function resolveParentItemIndex(itemId: ItemId, layerQueue: List): number | undefined {
	const index = layerQueue.findIndex((layer) => layer.itemId === itemId || layer.choices?.some(l => l.itemId === itemId))
	if (index === -1) return undefined
	return index
}

export function findParentItem(layerQueue: List, itemId: ItemId): Item | undefined {
	const index = resolveParentItemIndex(itemId, layerQueue)
	if (index === undefined) return undefined
	return layerQueue[index]
}

export function getAllItemLayerIds(item: Item, opts?: { excludeVoteChoices?: boolean }) {
	const ids = new Set<L.LayerId>()
	if (item.layerId) {
		ids.add(item.layerId)
	}

	if (item.choices && !opts?.excludeVoteChoices) {
		for (const choice of item.choices) ids.add(choice.itemId)
	}
	return ids
}

export function* iterLayerList(layerQueue: List): Generator<LayerListIteratorResult> {
	for (let outerIndex = 0; outerIndex < layerQueue.length; outerIndex++) {
		const item = layerQueue[outerIndex]
		yield { item, outerIndex, innerIndex: null }
		if (item.choices) {
			for (let innerIndex = 0; innerIndex < item.choices.length; innerIndex++) {
				const choice = item.choices[innerIndex]
				yield { item: choice, outerIndex, innerIndex }
			}
		}
	}
}

export function findItemById(layerQueue: List, itemId: ItemId): LayerListIteratorResult | undefined {
	for (const { item, outerIndex, innerIndex } of iterLayerList(layerQueue)) {
		if (item.itemId === itemId) return { item, outerIndex, innerIndex }
	}
}

export function getItemIndex(list: List, itemId: ItemId): ItemIndex | undefined {
	for (const { item, outerIndex, innerIndex } of iterLayerList(list)) {
		if (!innerIndex) continue
		if (item.itemId === itemId) return { outerIndex, innerIndex }
	}
	return undefined
}

export function isVoteChoiceResult(result: Pick<LayerListIteratorResult, 'innerIndex'>) {
	return result.innerIndex !== null
}

/** */
export function mergeItems(newFirstItemId: ItemId, ...items: Item[]): Item | undefined {
	if (items.length === 0) return undefined
	const [first] = items

	let choicesGenerator = Generator.map(iterLayerList(items), res => {
		if (res.item.itemId === first.itemId) {
			return {
				...res.item,
				itemId: newFirstItemId,
			}
		}
		return res.item
	})
	const seenLayerIds = new Set<L.LayerId>()
	choicesGenerator = Generator.filter(choicesGenerator, item => {
		if (isParentVoteItem(item)) return false
		if (seenLayerIds.has(item.layerId)) return false
		seenLayerIds.add(item.layerId)
		return true
	})
	const choices = Array.from(choicesGenerator)
	if (choices.length === 0) return undefined

	return {
		...items[0],
		layerId: choices[0].layerId,
		choices: choices.length > 1 ? choices : undefined,
	}
}

export function addItemsDeterministic(list: List, source: Source, index: ItemIndex, ...items: Item[]) {
	for (const item of items) {
		if (!item.itemId) throw new Error('Item ID is required')
	}
	addItems(list, source, index, ...items)
}

export function addItems(list: List, source: Source, index: ItemIndex, ...items: NewLayerListItem[]) {
	index = truncateAddIndex(index, list)
	const createdItems = items.map(item => createLayerListItem(item, source))

	splice(list, index, 0, ...createdItems)

	function truncateAddIndex(index: ItemIndex, list: List): ItemIndex {
		const outerIndex = Math.min(index.outerIndex, list.length)
		return { outerIndex, innerIndex: index.innerIndex ? Math.min(list[outerIndex].choices!.length, index.innerIndex) : null }
	}
}

export function moveItem(
	list: List,
	source: Source,
	movedItemId: ItemId,
	// needed in case we're merging and we need a new id for the added first choice
	newFirstItemId: ItemId,
	targetCursorOrIndex: ItemRelativeCursor | ItemIndex,
): { merged: false | ItemId; modified: boolean } {
	const movedItemRes = findItemById(list, movedItemId)
	const targetIndex = isItemIndex(targetCursorOrIndex)
		? targetCursorOrIndex
		: resolveQualfiedIndexFromCursorForMove(list, targetCursorOrIndex)

	if (movedItemRes === undefined) {
		console.warn('Failed to move item. item not found', movedItemId, movedItemId)
		return { merged: false, modified: false }
	}
	if (targetIndex === undefined) {
		console.warn('Failed to move item. target item not found', movedItemId, targetCursorOrIndex)
		return { merged: false, modified: false }
	}
	if (indexesEqual(targetIndex, movedItemRes)) return { merged: false, modified: false }

	const targetItem = resolveItemForIndex(list, targetIndex)
	const targetItemParent = targetItem ? findParentItem(list, targetItem.itemId) : undefined

	splice(list, movedItemRes, 1, { itemId: '__placeholder__', layerId: L.DEFAULT_LAYER_ID, source })

	let merged: false | string
	// create a vote out of two existing items
	if (targetItem && !isItemIndex(targetCursorOrIndex) && targetCursorOrIndex.position === 'on') {
		const mergedItem = mergeItems(newFirstItemId, targetItem, movedItemRes.item)
		if (!mergedItem) throw new Error('Failed to merge items')
		splice(list, targetIndex, 1, mergedItem)
		merged = mergedItem.itemId
	} else {
		const movedAndModifiedItem: Item = { ...movedItemRes.item, source }
		splice(list, targetIndex, 0, movedAndModifiedItem)
		if (targetItemParent && isParentVoteItem(targetItemParent)) {
			setCorrectChosenLayerIdInPlace(targetItemParent as ParentVoteItem)
		}
		merged = false
	}
	const placeholderRes = findItemById(list, '__placeholder__')!
	// finally, remove placeholder
	splice(list, placeholderRes, 1)
	return { merged, modified: true }
}

export function editLayer(list: List, source: Source, itemId: ItemId, layerId: L.LayerId) {
	const itemRes = findItemById(list, itemId)
	if (!itemRes) return
	const item = itemRes.item
	item.source = source
	item.layerId = layerId
	const parentVoteItem = resolveParentVoteItem(itemId, list)
	if (parentVoteItem) {
		setCorrectChosenLayerIdInPlace(parentVoteItem)
	}
}

export function deleteItem(list: List, itemId: ItemId) {
	const itemRes = findItemById(list, itemId)
	if (!itemRes) return
	splice(list, itemRes, 1)
}

export function configureVote(
	list: List,
	source: Source,
	itemId: ItemId,
	voteConfig?: Partial<V.AdvancedVoteConfig> | null,
	displayProps?: DH.LayerDisplayProp[] | null,
) {
	const itemRes = findItemById(list, itemId)
	if (!itemRes) return
	const item = itemRes.item
	if (!isParentVoteItem(item)) throw new Error('Cannot configure vote on non-vote item')
	if (voteConfig === null) {
		item.voteConfig = { source }
		return
	} else if (voteConfig) {
		item.voteConfig = { ...(item.voteConfig ?? {}), ...(voteConfig ?? {}), source }
	}
	if (displayProps === null) {
		delete item.displayProps
	} else if (displayProps) {
		item.displayProps = displayProps
	}
}

export function createVoteOutOfItem(list: List, source: Source, itemId: ItemId, newFirstItemId: ItemId, addedChoices: LL.Item[]) {
	const itemRes = findItemById(list, itemId)
	if (!itemRes) return
	const item = itemRes.item
	if (isParentVoteItem(item)) return
	const voteItem = mergeItems(newFirstItemId, item, ...addedChoices)
	if (!voteItem) return
	voteItem.source = source
	splice(list, itemRes, 1, voteItem)
	return voteItem.itemId
}

export function splice(list: List, indexOrCursor: ItemRelativeCursor | ItemIndex, deleteCount: number, ...items: Item[]) {
	const index = isItemIndex(indexOrCursor) ? indexOrCursor : resolveQualfiedIndexFromCursorForMove(list, indexOrCursor)
	if (index === undefined) return
	if (index.innerIndex !== null) {
		const parentItem = list[index.outerIndex]
		if (!isParentVoteItem(parentItem)) throw new Error('Cannot splice non-vote item index on a vote choice')

		let newItems = Generator.map(iterLayerList(items), res => res.item)
		newItems = Generator.filter(newItems, item => !isParentVoteItem(item))

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
			const regularItem: Item = {
				itemId: parentItem.itemId,
				layerId: parentItem.layerId,
				source: parentItem.source,
			}
			list.splice(index.outerIndex, 1, regularItem)
		}
		setCorrectChosenLayerIdInPlace(parentItem)
	} else {
		list.splice(index.outerIndex, deleteCount, ...items)
	}
}

export function isItemIndex(item: ItemRelativeCursor | ItemIndex): item is ItemIndex {
	return (item as any).outerIndex !== undefined
}

export function setCorrectChosenLayerIdInPlace(item: ParentVoteItem) {
	if (item.endingVoteState && item.endingVoteState.code === 'ended:winner') return item
	item.layerId = item.choices[0].layerId
	return item
}

// if layers are placed before the generated layer then we should update the generated layer's attribution, indicating that the editor has taken responsibility for preventing issues with the new layer sequence.
export function changeGeneratedLayerAttributionInPlace(layerList: List, mutations: ItemMut.Mutations, userId: bigint) {
	let afterModified = false
	const allModifiedItems = ItemMut.getAllMutationIds(mutations)
	for (const { item } of iterLayerList(layerList)) {
		if (item.source.type === 'generated') {
			if (afterModified) item.source = { type: 'manual', userId }
		} else if (!afterModified && allModifiedItems.has(item.itemId)) {
			afterModified = true
		}
	}
}

export function swapFactions(existingItem: Item, newSource?: Source) {
	const updated: Item = { ...existingItem }
	const layerId = L.swapFactionsInId(existingItem.layerId)
	updated.layerId = layerId
	if (newSource) updated.source = newSource
	if (isParentVoteItem(existingItem)) {
		updated.choices = existingItem.choices.map(choice => swapFactions(choice, newSource))
	}
	return updated
}

export function clearTally(_item: Item) {
	if (!_item.endingVoteState) return _item
	const item = { ..._item }
	delete item.endingVoteState
	return item
}

export function isLocallyLastIndex(itemId: ItemId, list: List) {
	const res = findItemById(list, itemId)
	if (!res) return false
	if (res.innerIndex != null) {
		const parentRes = findParentItem(list, itemId)! as ParentVoteItem
		return parentRes.choices.length - 1 === res.innerIndex
	}
	return list.length - 1 === res.outerIndex
}

export function isLocallyFirstIndex(index: ItemIndex) {
	if (index.innerIndex !== null) {
		return index.innerIndex === 0
	}
	return index.outerIndex === 0 && index.innerIndex === null
}

export function displayLayerListItem(item: Item, index: ItemIndex) {
	if (isParentVoteItem(item)) {
		return item.choices.map((choice, innerIndex) =>
			`${getItemNumber({ outerIndex: index.outerIndex, innerIndex })} ${DH.displayLayer(choice.layerId)}`
		).join('\n')
	}
	return `${getItemNumber(index)} ${DH.displayLayer(item.layerId)}`
}

export function getItemNumber(index: ItemIndex) {
	const inner = index.innerIndex !== null ? `${index.innerIndex + 1}` : ''
	return `${index.outerIndex + 1}.${inner}`
}

export function resolveLayerQueueItemIndexForNumber(layerList: List, number: string) {
	const match = /^(\d+)(?:\.(\d+))?$/
	const matchResult = match.exec(number)
	if (!matchResult) return null
	const outerIndex = parseInt(matchResult[1]) - 1
	const innerIndex = matchResult[2] ? parseInt(matchResult[2]) - 1 : null
	return { outerIndex, innerIndex }
}

export function resolveItemForIndex(layerList: List, index: ItemIndex): Item | undefined {
	const { outerIndex, innerIndex } = index
	if (innerIndex === null) return layerList[outerIndex]
	return layerList[outerIndex]?.choices?.[innerIndex]
}

export function resolveLayerQueueItemForNumber(layerList: List, number: string) {
	const index = resolveLayerQueueItemIndexForNumber(layerList, number)
	if (!index) return undefined
	return resolveItemForIndex(layerList, index)
}

export function indexesEqual(a: ItemIndex, b: ItemIndex) {
	return a.outerIndex === b.outerIndex && a.innerIndex === b.innerIndex
}

export function getLastLocalIndexForItem(itemId: ItemId, layerList: List): ItemIndex | undefined {
	const res = findItemById(layerList, itemId)
	if (!res) return undefined
	if (res.innerIndex === null) {
		const parentItem = layerList[res.outerIndex]
		if (!isParentVoteItem(parentItem)) return undefined
		return { outerIndex: res.outerIndex, innerIndex: parentItem.choices.length - 1 }
	}
	return { outerIndex: layerList.length - 1, innerIndex: null }
}
