import React from 'react'
import { DragEndContext, DragEndHandler } from './dndkit'
import { DndContext, DragEndEvent } from '@dnd-kit/core'

export function DragContextProvider(props: { children: React.ReactNode }) {
	const hooksRef = React.useRef({} as Record<string, DragEndHandler>)
	function onDragEnd(event: DragEndEvent) {
		for (const hook of Object.values(hooksRef.current)) {
			hook(event)
		}
	}

	function addHook(key: string, hook: DragEndHandler) {
		hooksRef.current[key] = hook
	}
	function removeHook(key: string) {
		delete hooksRef.current[key]
	}

	return (
		<DndContext onDragEnd={onDragEnd}>
			<DragEndContext.Provider value={{ addHook, removeHook }}>{props.children}</DragEndContext.Provider>
		</DndContext>
	)
}
