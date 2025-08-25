import { z } from 'zod'

export type DragEndHandler = (evt: { active: DragItem; over?: DropItem }) => void
export type DragEndContext = {
	addHook: (key: string, handler: DragEndHandler) => void
	removeHook: (key: string) => void
}

export const DRAG_ITEM_TYPE = z.enum(['layer-item'])
export type DragItemType = z.infer<typeof DRAG_ITEM_TYPE>

export type DragItem = {
	type: DragItemType
	id: string
}

export function serializeDragItem(item: DragItem) {
	return JSON.stringify([item.type, item.id])
}

export function deserializeDragItem(str: string): DragItem {
	const [type, id] = JSON.parse(str)
	return { type, id }
}

export type DropItem = {
	type: 'relative-to-drag-item'
	slots: DragItemCursor[]
}

export type DragItemCursor = {
	position: 'before' | 'after' | 'on'
	dragItem: DragItem
}

export function serializeDropItem(item: DropItem) {
	return JSON.stringify([item.type, ...item.slots])
}

export function deserializeDropItem(str: string): DropItem {
	const [type, ...slots] = JSON.parse(str)
	return { type, slots }
}
