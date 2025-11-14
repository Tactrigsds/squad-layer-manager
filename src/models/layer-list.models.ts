import * as Arr from '@/lib/array'
import * as DH from '@/lib/display-helpers'
import * as Gen from '@/lib/generator'
import * as ItemMut from '@/lib/item-mutations'
import * as Obj from '@/lib/object'
import { assertNever } from '@/lib/type-guards'
import * as DND from '@/models/dndkit.models'
import * as USR from '@/models/users.models'
import * as V from '@/models/vote.models'
import { z } from 'zod'
import { createId } from '../lib/id'
import * as L from './layer'

// ============================================================================
// Base Schemas and Types
// ============================================================================

export const SourceSchema = z.discriminatedUnion('type', [
	z.object({ type: z.literal('generated') }),
	z.object({ type: z.literal('gameserver') }),
	z.object({ type: z.literal('unknown') }),
	z.object({ type: z.literal('manual'), userId: USR.UserIdSchema }),
])

export type Source = z.infer<typeof SourceSchema>

export const ItemIdSchema = z.string().regex(/^[a-zA-Z0-9_-]{6,24}$/)
export type ItemId = z.infer<typeof ItemIdSchema>

// ============================================================================
// Item Schemas and Types
// ============================================================================

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
		if (!item.choices) return true
		const choiceSet = new Set<string>()
		for (const choice of item.choices) {
			if (choiceSet.has(choice.layerId)) return false
			choiceSet.add(choice.layerId)
		}
		return true
	}, { message: 'Duplicate layer IDs in choices' })
	.refine((item): boolean => {
		if (!item.choices) return true
		return item.choices.some(choice => choice.layerId === item.layerId)
	}, { message: 'The parent layerId must be included in the choices' })
	.refine((item): boolean => {
		if (!item.choices) return true
		if (item.endingVoteState && item.endingVoteState.code === 'ended:winner') return true
		return !!item.choices && item.choices[0].layerId === item.layerId
	}, { message: "if vote isn't complete, then the layerId should always be the first layer choice" })

export type Item = z.infer<typeof LayerListItemSchema>

export type ParentVoteItem = Item & {
	choices: InnerLayerListItem[]
	voteConfig: V.AdvancedVoteConfig
	voteDisplayProps?: DH.LayerDisplayProp[]
}

// ============================================================================
// Sparse Item Types
// ============================================================================

type GenericItemId = string | number
export type SparseSingleItem<Id extends GenericItemId = GenericItemId> = {
	itemId: Id
	layerId: L.LayerId
}

export type SparseVoteItem<I extends SparseSingleItem = SparseSingleItem> = {
	itemId: I['itemId']
	layerId: L.LayerId
	choices: I[]
}

export type SparseItem<Id extends GenericItemId = GenericItemId> = SparseSingleItem<Id> | SparseVoteItem<SparseSingleItem<Id>>

{
	const _ = {} as Item satisfies SparseItem
}

// ============================================================================
// Index Schemas and Types
// ============================================================================

export const ItemIndexSchema = z.object({
	outerIndex: z.number().min(0),
	innerIndex: z.number().min(0).nullable(),
})
export type ItemIndex = z.infer<typeof ItemIndexSchema>

// ============================================================================
// Cursor Schemas and Types
// ============================================================================

export const ItemRelativeCursorSchema = z.object({
	itemId: ItemIdSchema,
	position: z.enum(['before', 'after', 'on']),
})

export const CursorSchema = z.discriminatedUnion('type', [
	z.object({
		type: z.literal('item-relative'),
		itemId: ItemIdSchema,
		position: z.enum(['before', 'after', 'on']),
	}),
	z.object({
		type: z.literal('index'),
		index: ItemIndexSchema,
	}),
	z.object({
		type: z.literal('start'),
	}),
	z.object({
		type: z.literal('end'),
	}),
])
export type Cursor = z.infer<typeof CursorSchema>
export type ItemRelativeCursor = Extract<Cursor, { type: 'item-relative' }>

// ============================================================================
// List Schemas and Types
// ============================================================================

export const ListSchema = z.array(LayerListItemSchema)

export type List = z.infer<typeof ListSchema>

// ============================================================================
// Functions
// ============================================================================

export function getActiveItemLayerId<T extends SparseItem>(item: T) {
	return item.layerId
}

export function getDefaultLayerId<T extends SparseItem & { choices: SparseSingleItem[] }>(item: T) {
	return item.choices[0].layerId
}

export function toSparseItem<I extends InnerLayerListItem | ParentVoteItem>(item: I) {
	if (isVoteItem(item as any)) {
		const voteItem = item as ParentVoteItem
		return {
			itemId: voteItem.itemId,
			layerId: voteItem.layerId,
			choices: voteItem.choices.map(choice => ({
				itemId: choice.itemId,
				layerId: choice.layerId,
			})),
		} satisfies SparseVoteItem
	}
	const singleItem = item as InnerLayerListItem
	return {
		itemId: singleItem.itemId,
		layerId: singleItem.layerId,
	} satisfies SparseSingleItem
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
				type: 'item-relative',
				itemId: slot.dragItem.id as ItemId,
				position: slot.position,
			})
		}
	}
	return slots
}

export function resolveCursorIndex(list: List, cursor: Cursor): ItemIndex | undefined {
	if (cursor.type === 'index') return cursor.index
	if (cursor.type === 'start') return { innerIndex: null, outerIndex: 0 }
	if (cursor.type === 'end') return { innerIndex: null, outerIndex: list.length - 1 }
	const itemRes = findItemById(list, cursor.itemId)
	if (!itemRes) return undefined
	if (cursor.position === 'before' || cursor.position === 'on') return itemRes.index
	if (itemRes.index.innerIndex !== null) {
		// we'll shift item up
		if (cursor.position === 'after') return { innerIndex: itemRes.index.innerIndex + 1, outerIndex: itemRes.index.outerIndex }
		assertNever(cursor.position)
	}
	if (cursor.position === 'after') return { innerIndex: itemRes.index.innerIndex, outerIndex: itemRes.index.outerIndex + 1 }
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
	return layerQueue[0].layerId
}

export function isParentVoteItem(item: Item): item is ParentVoteItem {
	return !!item.choices
}

export function isVoteItem<T extends SparseItem>(item: T): item is T & { choices: any[] } {
	return !!(item as any).choices
}

export function isChildItem(itemId: ItemId, parentItemId: ItemId, layerList: List): boolean {
	const parentItem = findParentItem(layerList, itemId)
	if (!parentItem || parentItem.itemId === itemId) return false
	return true
}

export function resolveParentItemIndex<T extends SparseItem>(itemId: ItemId, layerQueue: T[]): number | undefined {
	const index = layerQueue.findIndex((layer) =>
		layer.itemId === itemId || (isVoteItem(layer) && layer.choices.some(l => l.itemId === itemId))
	)
	if (index === -1) return undefined
	return index
}

export function findParentItem<T extends SparseItem>(layerQueue: T[], itemId: ItemId): T | undefined {
	const index = resolveParentItemIndex(itemId, layerQueue)
	if (index === undefined) return undefined
	return layerQueue[index]
}

export function getAllItemLayerIds<T extends SparseItem>(item: T, opts?: { excludeVoteChoices?: boolean }) {
	const ids = new Set<L.LayerId>()
	if (item.layerId) {
		ids.add(item.layerId)
	}

	if (isVoteItem(item) && !opts?.excludeVoteChoices) {
		for (const choice of item.choices) {
			if ('layerId' in choice) {
				ids.add(choice.layerId)
			}
		}
	}
	return ids
}

export type ItemIteratorResult<I extends SparseItem> = {
	index: ItemIndex
	item: I
}

export function iterItems<T extends SparseItem>(items: T[], opts?: { reverse?: boolean }): Generator<ItemIteratorResult<T>>
export function iterItems<T extends SparseItem>(...items: T[]): Generator<ItemIteratorResult<T>>
export function* iterItems<T extends SparseItem>(
	...args: T[] | [T[], { reverse?: boolean }]
): Generator<ItemIteratorResult<T>> {
	let itemsArray: T[]
	let reverse = false

	// Handle different argument patterns
	if (Array.isArray(args[0]) && !('itemId' in args[0])) {
		// Pattern: iterItems(items, opts)
		itemsArray = args[0] as T[]
		reverse = (args[1] as any)?.reverse ?? false
	} else {
		// Pattern: iterItems(...items)
		itemsArray = args as T[]
	}

	const indices = reverse
		? Array.from({ length: itemsArray.length }, (_, i) => itemsArray.length - 1 - i)
		: Array.from({ length: itemsArray.length }, (_, i) => i)

	for (const outerIndex of indices) {
		const item = itemsArray[outerIndex]
		yield { item, index: { outerIndex, innerIndex: null } }
		if (isVoteItem(item)) {
			const choiceIndices = reverse
				? Array.from({ length: item.choices.length }, (_, i) => item.choices.length - 1 - i)
				: Array.from({ length: item.choices.length }, (_, i) => i)
			for (const innerIndex of choiceIndices) {
				const choice = item.choices[innerIndex]
				yield { item: choice, index: { outerIndex, innerIndex } }
			}
		}
	}
}

export function findItemById<T extends SparseItem>(layerQueue: T[], itemId: T['itemId']): ItemIteratorResult<T> | undefined {
	for (const result of iterItems(...layerQueue)) {
		if (result.item.itemId === itemId) return result
	}
}

export function getItemIndex<T extends SparseItem>(list: T[], itemId: ItemId): ItemIndex | undefined {
	for (const { item, index } of iterItems(...list)) {
		if (index.innerIndex === null) continue
		if (item.itemId === itemId) return index
	}
	return undefined
}

export function isVoteChoiceResult<T extends SparseItem = SparseItem>(result: Pick<ItemIteratorResult<T>, 'index'>) {
	return result.index.innerIndex !== null
}

/** */
export function mergeItems(newFirstItemId: ItemId, ...items: Item[]): Item | undefined {
	if (items.length === 0) return undefined
	const [first] = items

	let choicesGenerator = Gen.map(iterItems(...items), res => {
		if (res.item.itemId === first.itemId) {
			return {
				...res.item,
				itemId: newFirstItemId,
			}
		}
		return res.item
	})
	const seenLayerIds = new Set<L.LayerId>()
	choicesGenerator = Gen.filter(choicesGenerator, item => {
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
	cursor: Cursor,
): { merged: false | ItemId; modified: boolean } {
	const { index: movedIndex, item: movedItem } = Obj.destrNullable(findItemById(list, movedItemId))
	const targetIndex = cursor.type === 'index'
		? cursor.index
		: resolveCursorIndex(list, cursor)

	if (movedIndex === undefined) {
		console.warn('Failed to move item. item not found', movedItemId, movedItemId)
		return { merged: false, modified: false }
	}
	if (targetIndex === undefined) {
		console.warn('Failed to move item. target item not found', movedItemId, cursor)
		return { merged: false, modified: false }
	}
	if (indexesEqual(targetIndex, movedIndex)) return { merged: false, modified: false }

	const targetItem = resolveItemForIndex(list, targetIndex)
	const targetItemParent = targetItem ? findParentItem(list, targetItem.itemId) : undefined

	splice(list, movedIndex, 1, { itemId: '__placeholder__', layerId: L.DEFAULT_LAYER_ID, source })

	let merged: false | string
	// create a vote out of two existing items
	if (targetItem && cursor.type === 'item-relative' && cursor.position === 'on') {
		const mergedItem = mergeItems(newFirstItemId, targetItem, movedItem)
		if (!mergedItem) throw new Error('Failed to merge items')
		splice(list, targetIndex, 1, mergedItem)
		merged = mergedItem.itemId
	} else {
		const movedAndModifiedItem: Item = { ...movedItem, source }
		splice(list, targetIndex, 0, movedAndModifiedItem)
		if (targetItemParent) {
			setCorrectChosenLayerIdInPlace(targetItemParent)
		}
		merged = false
	}
	const { index: placeholderIndex } = findItemById(list, '__placeholder__')!
	// finally, remove placeholder
	splice(list, placeholderIndex, 1)
	return { merged, modified: true }
}

export function editLayer(list: List, source: Source, itemId: ItemId, layerId: L.LayerId) {
	const { item } = Obj.destrNullable(findItemById(list, itemId))
	if (!item) return
	const parentVoteItem = resolveParentVoteItem(itemId, list)
	if (parentVoteItem) {
		const otherChoices = parentVoteItem?.choices.filter(choice => choice.itemId !== itemId)
		if (Arr.deref('layerId', otherChoices).includes(layerId)) {
			return
		}
	}
	item.source = source
	item.layerId = layerId
	if (parentVoteItem) setCorrectChosenLayerIdInPlace(parentVoteItem)
}

export function deleteItem(list: List, itemId: ItemId) {
	const { index } = Obj.destrNullable(findItemById(list, itemId))
	if (!index) return
	splice(list, index, 1)
}

export function configureVote(
	list: List,
	source: Source,
	itemId: ItemId,
	voteConfig?: Partial<V.AdvancedVoteConfig> | null,
	displayProps?: DH.LayerDisplayProp[] | null,
) {
	const { item } = Obj.destrNullable(findItemById(list, itemId))
	if (!item) return
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

export function createVoteOutOfItem(list: List, source: Source, itemId: ItemId, newFirstItemId: ItemId, addedChoices: Item[]) {
	const { index, item } = Obj.destrNullable(findItemById(list, itemId))
	if (!item || !index) return
	if (isParentVoteItem(item)) return
	const voteItem = mergeItems(newFirstItemId, item, ...addedChoices)
	if (!voteItem) return
	voteItem.source = source
	splice(list, index, 1, voteItem)
	return voteItem.itemId
}

export function splice(list: List, indexOrCursor: ItemRelativeCursor | ItemIndex, deleteCount: number, ...items: Item[]) {
	const index = isItemIndex(indexOrCursor) ? indexOrCursor : resolveCursorIndex(list, indexOrCursor)
	if (index === undefined) return
	if (index.innerIndex !== null) {
		const parentItem = list[index.outerIndex]
		if (!isParentVoteItem(parentItem)) throw new Error('Cannot splice non-vote item index on a vote choice')

		let newItems = Gen.map(iterItems(...items), res => res.item)
		newItems = Gen.filter(newItems, item => !isParentVoteItem(item))

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

export function setCorrectChosenLayerIdInPlace(item: Item) {
	if (item.endingVoteState && item.endingVoteState.code === 'ended:winner') return item
	if (item.choices) item.layerId = item.choices[0].layerId
	return item
}

// if layers are placed before the generated layer then we should update the generated layer's attribution, indicating that the editor has taken responsibility for preventing issues with the new layer sequence.
export function changeGeneratedLayerAttributionInPlace(layerList: List, mutations: ItemMut.Mutations, userId: bigint) {
	let afterModified = false
	const allModifiedItems = ItemMut.getAllMutationIds(mutations)
	for (const { item } of iterItems(...layerList)) {
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

export function isLocallyLastIndex<T extends SparseItem>(itemId: ItemId, list: T[]) {
	const { index } = Obj.destrNullable(findItemById(list, itemId))
	if (!index) return false
	if (index.innerIndex != null) {
		const parentRes = findParentItem(list, itemId)!
		if (!isVoteItem(parentRes)) return false
		return parentRes.choices.length - 1 === index.innerIndex
	}
	return list.length - 1 === index.outerIndex
}

export function isLocallyFirstIndex(index: ItemIndex) {
	if (index.innerIndex !== null) {
		return index.innerIndex === 0
	}
	return index.outerIndex === 0 && index.innerIndex === null
}

export function displayLayerListItem(item: Item, index: ItemIndex) {
	if (isVoteItem(item)) {
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

export function resolveLayerQueueItemIndexForNumber(number: string) {
	const match = /^(\d+)(?:\.(\d+))?$/
	const matchResult = match.exec(number)
	if (!matchResult) return null
	const outerIndex = parseInt(matchResult[1]) - 1
	const innerIndex = matchResult[2] ? parseInt(matchResult[2]) - 1 : null
	return { outerIndex, innerIndex }
}

export function resolveItemForIndex<T extends SparseItem>(
	layerList: T[],
	index: ItemIndex,
): T | Extract<T, { choices: unknown[] }>['choices'][number] | undefined {
	const { outerIndex, innerIndex } = index
	if (innerIndex === null) return layerList[outerIndex]
	const item = layerList[outerIndex]
	if (isVoteItem(item)) {
		return item.choices[innerIndex]
	}
	return undefined
}

export function resolveLayerQueueItemForNumber<T extends SparseItem>(layerList: T[], number: string) {
	const index = resolveLayerQueueItemIndexForNumber(number)
	if (!index) return undefined
	return resolveItemForIndex(layerList, index)
}

export function indexesEqual(a: ItemIndex, b: ItemIndex) {
	return a.outerIndex === b.outerIndex && a.innerIndex === b.innerIndex
}

export function getLastLocalIndexForItem<T extends SparseItem>(itemId: ItemId, layerList: T[]): ItemIndex | undefined {
	const { index } = Obj.destrNullable(findItemById(layerList, itemId))
	if (!index) return undefined
	if (index.innerIndex === null) {
		const parentItem = layerList[index.outerIndex]
		if (!isVoteItem(parentItem)) return undefined
		return { outerIndex: index.outerIndex, innerIndex: parentItem.choices.length - 1 }
	}
	return { outerIndex: layerList.length - 1, innerIndex: null }
}

export function shiftIndex(index: ItemIndex, offset: number = 1): ItemIndex {
	const { outerIndex, innerIndex } = index
	if (innerIndex === null) {
		return { outerIndex: outerIndex + offset, innerIndex: null }
	}
	return { outerIndex, innerIndex: innerIndex + offset }
}
