import * as DND from '@/models/dndkit.models'
import * as DndKit from '@/systems.client/dndkit'
import { DndContext, DragEndEvent } from '@dnd-kit/core'
import React from 'react'

export function DragContextProvider(props: { children: React.ReactNode }) {
	const hooksRef = React.useRef({} as Record<string, DND.DragEndHandler>)
	function onDragEnd(event: DragEndEvent) {
		for (const hook of Object.values(hooksRef.current)) {
			hook({
				active: DND.deserializeDragItem(event.active.id as string),
				over: event.over ? DND.deserializeDropItem(event.over.id as string) : undefined,
			})
		}
	}

	function addHook(key: string, hook: DND.DragEndHandler) {
		hooksRef.current[key] = hook
	}
	function removeHook(key: string) {
		delete hooksRef.current[key]
	}

	return (
		<DndContext onDragEnd={onDragEnd}>
			<DndKit.DragEndContext.Provider value={{ addHook, removeHook }}>{props.children}</DndKit.DragEndContext.Provider>
		</DndContext>
	)
}
