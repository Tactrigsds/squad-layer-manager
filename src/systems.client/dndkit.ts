import * as DND from '@/models/dndkit.models'
import * as DndKitCore from '@dnd-kit/core'
import React from 'react'

export const DragEndContext = React.createContext<DND.DragEndContext>({ addHook: () => {}, removeHook: () => {} })

export function useDragging() {
	const ctx = DndKitCore.useDndContext()

	return ctx.active
}

export function useDragEnd(handler: DND.DragEndHandler) {
	const id = React.useId()
	const ctx = React.useContext(DragEndContext)

	React.useEffect(() => {
		ctx.addHook(id, handler)
		return () => ctx.removeHook(id)
	}, [id, handler, ctx])
}

export function useDroppable(item: DND.DropItem) {
	return DndKitCore.useDroppable({ id: DND.serializeDropItem(item) })
}

export function useDraggable(item: DND.DragItem) {
	return DndKitCore.useDraggable({ id: DND.serializeDragItem(item) })
}
