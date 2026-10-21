import * as DndKitReact from '@dnd-kit/react'
import React from 'react'

import * as UI_Msgs from '@/messages/ui.messages'
import * as DND from '@/models/dndkit.models'
import { tr } from '@/systems/messages.client'

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

export const DRAG_INSTRUCTIONS_ID = 'drag-instructions'

// The attributes dnd-kit's Accessibility plugin would set. That plugin rescans every draggable on each registration,
// which is quadratic in the number of grips on a page.
function markActivator(element: Element) {
	if (!element.hasAttribute('tabindex')) element.setAttribute('tabindex', '0')
	if (!element.hasAttribute('role') && element.tagName !== 'BUTTON') element.setAttribute('role', 'button')
	if (!element.hasAttribute('aria-roledescription')) element.setAttribute('aria-roledescription', tr.text(UI_Msgs.dragRoleDescription()))
	if (!element.hasAttribute('aria-describedby')) element.setAttribute('aria-describedby', DRAG_INSTRUCTIONS_ID)
}

export function useDraggable(item: DND.DragItem, input?: Omit<DndKitReact.UseDraggableInput, 'id'>) {
	const drag = DndKitReact.useDraggable({ id: DND.serializeDragItem(item), ...(input ?? {}) })
	const hasHandleRef = React.useRef(false)
	const baseHandleRef = drag.handleRef
	const baseRef = drag.ref
	const handleRef = React.useCallback(
		(element: Element | null) => {
			baseHandleRef(element)
			hasHandleRef.current = !!element
			if (element) markActivator(element)
		},
		[baseHandleRef],
	)
	// a handle is a descendant of the element, so its ref is attached first
	const ref = React.useCallback(
		(element: Element | null) => {
			baseRef(element)
			if (element && !hasHandleRef.current) markActivator(element)
		},
		[baseRef],
	)
	return {
		get draggable() {
			return drag.draggable
		},
		get isDragging() {
			return drag.isDragging
		},
		get isDropping() {
			return drag.isDropping
		},
		get isDragSource() {
			return drag.isDragSource
		},
		handleRef,
		ref,
	}
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
