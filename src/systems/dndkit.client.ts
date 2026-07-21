import * as DND from '@/models/dndkit.models'
import { type CollisionDetector, CollisionPriority, CollisionType } from '@dnd-kit/abstract'
import * as DndKitReact from '@dnd-kit/react'

import React from 'react'

// like @dnd-kit/collision's pointerIntersection, but measured against the droppable element's LIVE rect: the
// cached shape can lag a drag-start expansion, and it disagrees with the pointer under page zoom. Used wherever a
// thin, dynamically-expanding drop target (the reorder separators) must track the pointer precisely.
export const livePointerIntersection: CollisionDetector = ({ dragOperation, droppable }) => {
	const coords = dragOperation.position.current
	const element = (droppable as { element?: Element }).element
	if (!coords || !element) return null
	const rect = element.getBoundingClientRect()
	if (coords.x < rect.left || coords.x > rect.right || coords.y < rect.top || coords.y > rect.bottom) return null
	const dx = coords.x - (rect.left + rect.width / 2)
	const dy = coords.y - (rect.top + rect.height / 2)
	return {
		id: droppable.id,
		value: 1 / (Math.hypot(dx, dy) || 1),
		type: CollisionType.PointerIntersection,
		priority: CollisionPriority.High,
	}
}

export const DragEndContext = React.createContext<DND.DragEndContext>({ addHook: () => {}, removeHook: () => {} })

export function useDragEnd(handler: DND.DragEndHandler) {
	const id = React.useId()
	const ctx = React.useContext(DragEndContext)

	React.useEffect(() => {
		ctx.addHook(id, handler)
		return () => ctx.removeHook(id)
	}, [id, handler, ctx])
}

export function useDroppable(item: DND.DropItem, input?: Omit<DndKitReact.UseDroppableInput, 'id'>) {
	return DndKitReact.useDroppable({ id: DND.serializeDropItem(item), ...(input ?? {}) })
}

export function useDraggable(item: DND.DragItem, input?: Omit<DndKitReact.UseDraggableInput, 'id'>) {
	return DndKitReact.useDraggable({ id: DND.serializeDragItem(item), ...(input ?? {}) })
}

export function useDragging() {
	const [active, setActive] = React.useState<DND.DragItem | null>(null)

	DndKitReact.useDragDropMonitor({
		onDragStart: (event) => {
			const item = DND.deserializeDragItem(event.operation.source!.id as string)
			setActive(item)
		},
		onDragEnd: () => {
			setActive(null)
		},
	})
	return active
}

export function useDragDropMonitor(
	onDragStart?: (item: DND.DragItem) => void,
	onDragEnd?: (source: DND.DragItem, target: DND.DropItem | null) => void,
) {
	DndKitReact.useDragDropMonitor({
		onDragStart: (event) => {
			const item = DND.deserializeDragItem(event.operation.source!.id as string)
			onDragStart?.(item)
		},
		onDragEnd: (event) => {
			const source = DND.deserializeDragItem(event.operation.source!.id as string)
			const target = event.operation.target?.id ? DND.deserializeDropItem(event.operation.target.id as string) : null
			onDragEnd?.(source, target)
		},
	})
}

export function useDraggingCallback(callback: (item: DND.DragItem | null) => void) {
	DndKitReact.useDragDropMonitor({
		onDragStart: (event) => {
			const item = DND.deserializeDragItem(event.operation.source!.id as string)
			callback(item)
		},
		onDragEnd: () => {
			callback(null)
		},
	})
}
