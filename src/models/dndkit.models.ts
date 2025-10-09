import { assertNever } from '@/lib/type-guards'

export type DragEndHandler = (evt: { active: DragItem; over?: DropItem }) => void
export type DragEndContext = {
	addHook: (key: string, handler: DragEndHandler) => void
	removeHook: (key: string) => void
}

export type DragItem = {
	type: 'layer-item' | 'filter-node'
	id: string
} | {
	type: 'history-entry'
	id: number
}

export type DragItemType = DragItem['type']

export function serializeDragItem(item: DragItem) {
	return JSON.stringify([item.type, item.id])
}

export function deserializeDragItem(str: string): DragItem {
	const parsed = JSON.parse(str)
	const [type, id] = parsed
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
