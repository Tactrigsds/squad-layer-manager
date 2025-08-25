import * as Generator from '@/lib/generator'
import { assertNever } from '@/lib/type-guards'
import * as DND from '@/models/dndkit.models'
import * as DndKit from '@/systems.client/dndkit'
import { z } from 'zod'
import { createId } from '../lib/id'
import * as L from './layer'

export const LayerSourceSchema = z.discriminatedUnion('type', [
	z.object({ type: z.literal('generated') }),
	z.object({ type: z.literal('gameserver') }),
	z.object({ type: z.literal('unknown') }),
	z.object({ type: z.literal('manual'), userId: z.bigint() }),
])

export type LayerSource = z.infer<typeof LayerSourceSchema>
export const LayerListItemIdSchema = z.string().regex(/^[a-zA-Z0-9_-]{6,24}$/)
export type LayerListItemId = z.infer<typeof LayerListItemIdSchema>

export const InnerLayerListItemSchema = z.object({
	itemId: LayerListItemIdSchema,
	layerId: L.LayerIdSchema,
	source: LayerSourceSchema,
})
export type InnerLayerListItem = z.infer<typeof InnerLayerListItemSchema>

export const LayerListItemSchema = z.object({
	itemId: LayerListItemIdSchema,
	layerId: L.LayerIdSchema,
	choices: z.array(InnerLayerListItemSchema).optional(),
	source: LayerSourceSchema,
})

export type LLItemRelativeCursor = {
	itemId: LayerListItemId
	position: 'before' | 'after' | 'on'
}

export type LLItemIndex = {
	outerIndex: number
	innerIndex: number | null
}

type LayerListIteratorResult = LLItemIndex & {
	item: LayerListItem | InnerLayerListItem
}

export const LayerListSchema = z.array(LayerListItemSchema)

export type LayerList = z.infer<typeof LayerListSchema>
export type LayerListItem = z.infer<typeof LayerListItemSchema>
export type NewLayerListItem = Omit<LayerListItem, 'itemId' | 'source'> & { source?: LayerSource }

export function getActiveItemLayerId(item: LayerListItem) {
	return item.layerId
}
export function getDefaultLayerId(item: LayerListItem & { choices: InnerLayerListItem[] }) {
	return item.choices[0].layerId
}

export function layerItemToDragItem(item: Pick<LayerListItem, 'itemId'>): DND.DragItem {
	return {
		id: item.itemId,
		type: 'layer-item',
	}
}
export function llItemCursorsToDropItem(cursors: LLItemRelativeCursor[]): DND.DropItem {
	return {
		type: 'relative-to-drag-item',
		slots: cursors.map(cursor => ({
			dragItem: layerItemToDragItem({ itemId: cursor.itemId }),
			position: cursor.position,
		})),
	}
}

export function dropItemToLLItemCursors(dropItem: DND.DropItem): LLItemRelativeCursor[] {
	if (dropItem.type !== 'relative-to-drag-item') {
		return []
	}
	const slots: LLItemRelativeCursor[] = []

	for (const slot of dropItem.slots) {
		if (slot.dragItem.type === 'layer-item') {
			slots.push({
				itemId: slot.dragItem.id as LayerListItemId,
				position: slot.position,
			})
		}
	}
	return slots
}

export function resolveQualfiedIndexFromCursorForMove(list: LayerList, cursor: LLItemRelativeCursor): LLItemIndex | undefined {
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

export function createLayerListItem(newItem: NewLayerListItem): LayerListItem {
	const source = newItem.source ?? { type: 'unknown' }
	return {
		itemId: createLayerListItemId(),
		source,
		...newItem,
	}
}

export function getNextLayerId(layerQueue: LayerList) {
	if (layerQueue.length === 0) return
	return layerQueue[0].layerId
}

export function isParentVoteItem(item: LayerListItem): item is LayerListItem & { choices: InnerLayerListItem[] } {
	return !!item.choices
}

export function resolveParentItemIndex(itemId: LayerListItemId, layerQueue: LayerList): number | undefined {
	const index = layerQueue.findIndex((layer) => layer.itemId === itemId || layer.choices?.some(l => l.itemId === itemId))
	if (index === -1) return undefined
	return index
}

export function findParentItem(itemId: LayerListItemId, layerQueue: LayerList): LayerListItem | undefined {
	const index = resolveParentItemIndex(itemId, layerQueue)
	if (index === undefined) return undefined
	return layerQueue[index]
}

export function getAllItemLayerIds(item: LayerListItem, opts?: { excludeVoteChoices?: boolean }) {
	const ids = new Set<L.LayerId>()
	if (item.layerId) {
		ids.add(item.layerId)
	}

	if (item.choices && !opts?.excludeVoteChoices) {
		for (const choice of item.choices) ids.add(choice.itemId)
	}
	return ids
}

export function* iterLayerList(layerQueue: LayerList): Generator<LayerListIteratorResult> {
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

export function findItemById(layerQueue: LayerList, itemId: LayerListItemId): LayerListIteratorResult | undefined {
	for (const { item, outerIndex, innerIndex } of iterLayerList(layerQueue)) {
		if (item.itemId === itemId) return { item, outerIndex, innerIndex }
	}
}

export function getItemIndexes(list: LayerList, itemId: LayerListItemId) {
	for (const { item, outerIndex, innerIndex } of iterLayerList(list)) {
		if (!innerIndex) continue
		if (item.itemId === itemId) return [outerIndex, innerIndex]
	}
	return undefined
}

export function isVoteChoiceResult(result: Pick<LayerListIteratorResult, 'innerIndex'>) {
	return result.innerIndex !== null
}

/**
 * Resulting itemId and source will be from first item
 */
export function mergeItems(...items: LayerListItem[]): LayerListItem | undefined {
	if (items.length === 0) return undefined
	const [first] = items

	let choicesGenerator = Generator.map(iterLayerList(items), res => {
		if (res.item.itemId === first.itemId) {
			return {
				...res.item,
				itemId: createLayerListItemId(),
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

export function splice(list: LayerList, indexOrCursor: LLItemRelativeCursor | LLItemIndex, deleteCount: number, ...items: LayerListItem[]) {
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
			const regularItem: LayerListItem = {
				itemId: parentItem.itemId,
				layerId: parentItem.layerId,
				source: parentItem.source,
			}
			list.splice(index.outerIndex, 1, regularItem)
		}
	} else {
		list.splice(index.outerIndex, deleteCount, ...items)
	}

	function isItemIndex(item: LLItemRelativeCursor | LLItemIndex): item is LLItemIndex {
		return (item as any).outerIndex !== undefined
	}
}
