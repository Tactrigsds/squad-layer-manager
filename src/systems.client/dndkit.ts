import * as DND from '@/models/dndkit.models'
import * as DndKitReact from '@dnd-kit/react'

import React from 'react'

export const DragEndContext = React.createContext<DND.DragEndContext>({ addHook: () => {}, removeHook: () => {} })

export function useDragEnd(handler: DND.DragEndHandler) {
	const id = React.useId()
	const ctx = React.useContext(DragEndContext)

	React.useEffect(() => {
		ctx.addHook(id, handler)
		return () => ctx.removeHook(id)
	}, [id, handler, ctx])
}

export function useDroppable(item: DND.DropItem) {
	return DndKitReact.useDroppable({ id: DND.serializeDropItem(item) })
}

export function useDraggable(item: DND.DragItem, input?: Omit<DndKitReact.UseDraggableInput, 'id'>) {
	return DndKitReact.useDraggable({ id: DND.serializeDragItem(item), ...(input ?? {}) })
}

export function useDragging() {
	const [active, setActive] = React.useState<DND.DragItem | null>(null)

	DndKitReact.useDragDropMonitor({
		onDragStart: (event) => {
			const item = DND.deserializeDragItem(event.operation.source!.id as string)
			console.log('active item set', item)
			setActive(item)
		},
		onDragEnd: () => {
			setActive(null)
		},
	})
	return active
}
