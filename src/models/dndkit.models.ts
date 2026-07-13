import type * as LL from '@/models/layer-list.models'

export type DragEndHandler = (evt: { active: DragItem; over?: DropItem }) => void
export type DragEndContext = {
	addHook: (key: string, handler: DragEndHandler) => void
	removeHook: (key: string) => void
}

export type DragItem = {
	type: 'filter-node'
	id: string
} | {
	type: 'layer-item'
	id: LL.ItemId
} | {
	type: 'history-entry'
	id: number
} | {
	// a column in the layer-table config editor (id = column name)
	type: 'layer-table-column'
	id: string
} | {
	// a column in the layer-generation config editor's pick order (id = column name)
	type: 'layer-generation-column'
	id: string
} | {
	// a flag in an ordered BattleMetrics flag list, e.g. the player flag color hierarchy (id = flag id)
	type: 'bm-flag'
	id: string
}

{
	const _: DragItem = undefined! satisfies { id: string | number }
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
