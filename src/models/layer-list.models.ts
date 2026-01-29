import * as Arr from '@/lib/array'
import * as DH from '@/lib/display-helpers'
import * as Gen from '@/lib/generator'
import * as ItemMut from '@/lib/item-mutations'
import * as Obj from '@/lib/object'
import { assertNever } from '@/lib/type-guards'
import type * as DND from '@/models/dndkit.models'
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

// --- Single Item ---

export const NewSingleItemSchema = z.object({
	type: z.literal('single-list-item'),
	itemId: ItemIdSchema.optional(),
	layerId: L.LayerIdSchema,
	source: SourceSchema.optional(),
})
export type NewSingleItem = z.infer<typeof NewSingleItemSchema>

export const SingleItemSchema = NewSingleItemSchema.extend({
	itemId: ItemIdSchema,
	source: SourceSchema,
})
export type SingleItem = z.infer<typeof SingleItemSchema>

// --- Vote Item ---

export const NewVoteItemSchema = z.object({
	type: z.literal('vote-list-item'),
	itemId: ItemIdSchema.optional(),
	layerId: L.LayerIdSchema,
	source: SourceSchema.optional(),
	choices: z.array(SingleItemSchema).min(1),

	voteConfig: z.lazy(() => V.AdvancedVoteConfigSchema.partial().extend({ source: SourceSchema }).optional()),
	endingVoteState: z.lazy(() => V.EndingVoteStateSchema.optional()),
})
export type NewVoteItem = z.infer<typeof NewVoteItemSchema>

export const VoteItemSchema = NewVoteItemSchema.extend({
	itemId: ItemIdSchema,
	source: SourceSchema,
})
	.refine((item) => {
		const choiceSet = new Set<string>()
		for (const choice of item.choices) {
			if (choiceSet.has(choice.layerId)) return false
			choiceSet.add(choice.layerId)
		}
		return true
	}, { error: 'Duplicate layer IDs in choices' })
	.refine((item): boolean => {
		return item.choices.some((choice) => choice.layerId === item.layerId)
	}, { error: 'The parent layerId must be included in the choices' })
	.refine((item): boolean => {
		if (item.endingVoteState && item.endingVoteState.code === 'ended:winner') return true
		return item.choices[0].layerId === item.layerId
	}, { error: "if vote isn't complete, then the layerId should always be the first layer choice" })

export type VoteItem = z.infer<typeof VoteItemSchema>

// --- Discriminated Union ---

export const NewItemSchema = z.discriminatedUnion('type', [
	NewSingleItemSchema,
	NewVoteItemSchema,
])
export type NewItem = z.infer<typeof NewItemSchema>

export const ItemSchema = z.discriminatedUnion('type', [
	SingleItemSchema,
	VoteItemSchema,
])
export type Item = z.infer<typeof ItemSchema>

// ============================================================================
// Sparse Item Types
// ============================================================================

type GenericItemId = string | number
export type SparseSingleItem<Id extends GenericItemId = GenericItemId> = {
	type: 'single-list-item'
	layerId: L.LayerId
	itemId: Id
}

export type SparseVoteItem<I extends SparseSingleItem = SparseSingleItem> = {
	type: 'vote-list-item'
	itemId: I['itemId']
	layerId: L.LayerId
	choices: I[]
}

export type SparseItem<Id extends GenericItemId = GenericItemId> = SparseSingleItem<Id> | SparseVoteItem<SparseSingleItem<Id>> | {
	type: string
	itemId: Id
	layerId: L.LayerId
}

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

export const ListSchema = z.array(ItemSchema)

export type List = z.infer<typeof ListSchema>

// ============================================================================
// Functions
// ============================================================================

export function toSparseItem(item: Item) {
	if (isVoteItem(item)) {
		return {
			type: 'vote-list-item',
			itemId: item.itemId,
			layerId: item.layerId,
			choices: item.choices.map(choice => ({
				type: choice.type,
				itemId: choice.itemId,
				layerId: choice.layerId,
			})),
		} satisfies SparseVoteItem
	}
	return {
		type: 'single-list-item',
		itemId: item.itemId,
		layerId: item.layerId,
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

export function resolveParentVoteItem(itemId: ItemId, list: List): VoteItem | undefined {
	const itemRes = findItemById(list, itemId)
	if (!itemRes) return
	if (!isVoteItem(itemRes.item)) return
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
	if (cursor.type === 'end') return { innerIndex: null, outerIndex: list.length }
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

export function createItemId() {
	return createId(24)
}

export function createItem(newItem: NewSingleItem, source: Source): SingleItem
export function createItem(newItem: NewVoteItem, source: Source): VoteItem
export function createItem(newItem: NewItem, source: Source): Item
export function createItem(newItem: NewItem, source: Source): Item {
	if (newItem.type === 'vote-list-item') {
		return createVoteItem(newItem.choices, source, newItem.voteConfig)
	}
	return {
		...newItem,
		itemId: newItem.itemId ?? createItemId(),
		source,
	}
}

export function createVoteItem(
	choices: (L.LayerId | NewSingleItem | SingleItem)[],
	source: Source,
	voteConfig?: Partial<V.AdvancedVoteConfig>,
): VoteItem {
	const items = choices.map((choice): SingleItem => {
		if (typeof choice === 'string') {
			return createItem({ type: 'single-list-item', layerId: choice }, source)
		}
		if (choice.itemId && choice.source) {
			return choice as SingleItem
		}
		return createItem(choice, source)
	})
	return {
		type: 'vote-list-item',
		itemId: createItemId(),
		layerId: items[0].layerId,
		choices: items,
		voteConfig: { ...(voteConfig ?? {}), source },
		source,
	}
}

export function getNextLayerId(layerQueue: List) {
	if (layerQueue.length === 0) return null
	return layerQueue[0]?.layerId ?? null
}

export function isParentVoteItem(item: Item): item is VoteItem {
	return isVoteItem(item)
}

export function isVoteItem<T extends SparseItem>(item: T): item is Extract<T, { type: 'vote-list-item' }> {
	return item.type === 'vote-list-item'
}

export function isChildItem(itemId: ItemId, voteItemId: ItemId, layerList: List): boolean {
	const parentItem = findParentItem(layerList, itemId)
	return !!parentItem && parentItem.itemId === voteItemId
}

export function resolveParentItemIndex<T extends SparseItem>(itemId: ItemId, layerQueue: T[]): number | undefined {
	const index = layerQueue.findIndex((layer) => (isVoteItem(layer) && layer.choices.some(l => l.itemId === itemId)))
	if (index === -1) return undefined
	return index
}

export function findParentItem<T extends SparseItem>(layerQueue: T[], itemId: ItemId) {
	const index = resolveParentItemIndex(itemId, layerQueue)
	if (index === undefined) return undefined
	return layerQueue[index] as Extract<T, { choices: any[] }>
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
				const choice = item.choices[innerIndex] as unknown as Extract<T, { type: 'single-list-item' }>
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

/** Merges items into a single item or vote item depending on the number of unique choices */
export function mergeItems(newFirstItemId: ItemId, ...items: Item[]): Item | undefined {
	if (items.length === 0) return undefined
	const [first] = items

	let choicesGenerator = Gen.map(iterItems(...items), (res): SingleItem => {
		const item = res.item
		if (item.itemId === first.itemId) {
			return {
				type: 'single-list-item',
				itemId: newFirstItemId,
				layerId: item.layerId,
				source: item.source,
			}
		}
		return {
			type: 'single-list-item',
			itemId: item.itemId,
			layerId: item.layerId,
			source: item.source,
		}
	})
	const seenLayerIds = new Set<L.LayerId>()
	choicesGenerator = Gen.filter(choicesGenerator, item => {
		if (seenLayerIds.has(item.layerId)) return false
		seenLayerIds.add(item.layerId)
		return true
	})
	const choices = Array.from(choicesGenerator)
	if (choices.length === 0) return undefined

	if (choices.length === 1) {
		return choices[0]
	}

	return {
		type: 'vote-list-item',
		itemId: first.itemId,
		layerId: choices[0].layerId,
		source: first.source,
		choices,
	}
}

export function addItemsDeterministic(list: List, source: Source, index: ItemIndex, ...items: Item[]) {
	for (const item of items) {
		if (!item.itemId) throw new Error('Item ID is required')
	}
	addItems(list, source, index, ...items)
}

export function addItems(list: List, source: Source, index: ItemIndex, ...items: NewItem[]) {
	index = truncateAddIndex(index, list)
	const createdItems = items.map((item): Item => {
		if (item.type === 'vote-list-item') {
			return {
				...item,
				itemId: item.itemId ?? createItemId(),
				source,
			}
		}
		return createItem(item, source)
	})

	splice(list, index, 0, ...createdItems)

	function truncateAddIndex(index: ItemIndex, list: List): ItemIndex {
		const outerIndex = Math.min(index.outerIndex, list.length)
		if (!index.innerIndex) return { outerIndex, innerIndex: null }
		const outerItem = list[outerIndex]
		if (!isVoteItem(outerItem)) return { outerIndex, innerIndex: null }
		return { outerIndex, innerIndex: Math.min(outerItem.choices.length, index.innerIndex) }
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

	splice(list, movedIndex, 1, { type: 'single-list-item', itemId: '__placeholder__', layerId: L.DEFAULT_LAYER_ID, source })

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
		if (targetItemParent && isVoteItem(targetItemParent)) {
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
	config?: Partial<V.AdvancedVoteConfig> | null,
) {
	const { item } = Obj.destrNullable(findItemById(list, itemId))
	if (!item) return
	if (!isParentVoteItem(item)) throw new Error('Cannot configure vote on non-vote item')
	if (config === null) {
		item.voteConfig = { source }
		return
	} else if (config) {
		item.voteConfig = { ...(item.voteConfig ?? {}), ...config, source }
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

		const newItems = Gen.map(iterItems(...items), res => res.item)

		const singleItems = Gen.filter(newItems, item => item.type === 'single-list-item') as Generator<SingleItem>
		parentItem.choices.splice(
			index.innerIndex,
			deleteCount,
			...singleItems,
		)
		if (parentItem.choices.length === 0) {
			list.splice(index.outerIndex, 1)
		}
		if (parentItem.choices.length === 1) {
			// only one choice left, just make this a regular item
			const regularItem: SingleItem = {
				type: 'single-list-item',
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

export function getChosenItem(voteItem: VoteItem) {
	if (voteItem.endingVoteState && voteItem.endingVoteState.code === 'ended:winner') {
		return findItemById(voteItem.choices, voteItem.endingVoteState.winnerId)?.item as SingleItem
	}
	return voteItem.choices[0]
}

export function setEndingVoteStateInPlace(voteItem: VoteItem, state: V.EndingVoteState | null) {
	if (state) {
		voteItem.endingVoteState = state
	} else {
		delete voteItem.endingVoteState
	}
	setCorrectChosenLayerIdInPlace(voteItem)
}

export function setCorrectChosenLayerIdInPlace(item: VoteItem) {
	if (item.endingVoteState && item.endingVoteState.code === 'ended:winner') return item
	item.layerId = item.choices[0].layerId
	return item
}

// if layers are placed/edited before the generated layer then we should update the generated layer's attribution, indicating that the editor has taken responsibility for preventing issues with the new layer sequence.
export function changeGeneratedLayerAttributionInPlace(layerList: List, mutations: ItemMut.Mutations, userId: bigint) {
	let afterModified = false
	const allModifiedItems = ItemMut.getAllMutationIds(mutations)
	for (const { item } of iterItems(...layerList)) {
		if (item.source.type === 'generated') {
			if (afterModified) {
				item.source = { type: 'manual', userId }
				ItemMut.tryApplyMutation('edited', item.itemId, mutations)
			}
		} else if (!afterModified && allModifiedItems.has(item.itemId)) {
			afterModified = true
		}
	}
}

export function swapFactionsInPlace(list: List, id: ItemId, newSource?: Source): boolean {
	const { item: existingItem } = Obj.destrNullable(findItemById(list, id))
	if (!existingItem) return false
	const layer = L.swapFactions(existingItem.layerId)
	if (!layer) return false

	existingItem.layerId = layer.id
	existingItem.source = newSource ?? existingItem.source
	if (isVoteItem(existingItem)) {
		const updatedChoices = Obj.deepClone(existingItem.choices)
		for (const choice of updatedChoices) {
			const success = swapFactionsInPlace(existingItem.choices, choice.itemId, newSource)
			if (!success) return false
		}
		existingItem.choices = updatedChoices
	} else {
		const parentVoteItem = findParentItem(list, existingItem.itemId)
		if (parentVoteItem && getChosenItem(parentVoteItem).itemId === existingItem.itemId) {
			parentVoteItem.layerId = layer.id
		}
	}

	return true
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
	const inner = index.innerIndex !== null ? `.${index.innerIndex + 1}` : ''
	return `+${index.outerIndex + 1}${inner}`
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
	const outerItem = layerList[index.outerIndex]
	if (index.innerIndex !== null && isVoteItem(outerItem)) {
		return { outerIndex: index.outerIndex, innerIndex: outerItem.choices.length - 1 }
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
