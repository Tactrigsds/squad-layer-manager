import { z } from 'zod'

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
}
export type DragItemType = DragItem['type']

export function serializeDragItem(item: DragItem) {
	if (item.type === 'layer-item') {
		return JSON.stringify([item.type, item.id])
	} else {
		return JSON.stringify([item.type, item.path])
	}
}

export function deserializeDragItem(str: string): DragItem {
	const parsed = JSON.parse(str)
	const type = parsed[0]

	if (type === 'layer-item') {
		return { type: 'layer-item', id: parsed[1] }
	} else {
		return { type: 'filter-node', path: parsed[1] }
	}
}

function serializeFilterNodePath(path: number[]) {
	return path.join('-')
}

function deserializeFilterNodePath(id: string) {
	return id.split('-').map(Number)
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
