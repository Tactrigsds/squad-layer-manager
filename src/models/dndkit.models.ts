import { assertNever } from '@/lib/type-guards'

export type DragEndHandler = (evt: { active: DragItem; over?: DropItem }) => void
export type DragEndContext = {
	addHook: (key: string, handler: DragEndHandler) => void
	removeHook: (key: string) => void
}

export type DragItem = {
	type: 'layer-item'
	id: string
} | {
	type: 'filter-node'
	path: number[]
} | {
	type: 'history-entry'
	id: number
}

export type DragItemType = DragItem['type']

export function serializeDragItem(item: DragItem) {
	if (item.type === 'layer-item' || item.type === 'history-entry') {
		return JSON.stringify([item.type, item.id])
	} else if (item.type === 'filter-node') {
		return JSON.stringify([item.type, item.path])
	} else {
		assertNever(item)
	}
}

export function deserializeDragItem(str: string): DragItem {
	const parsed = JSON.parse(str)
	const type = parsed[0]

	if (type === 'layer-item' || type === 'history-entry') {
		return { type, id: parsed[1] }
	} else {
		return { type, path: parsed[1] }
	}
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
