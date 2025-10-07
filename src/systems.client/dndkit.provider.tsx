import * as DND from '@/models/dndkit.models'
import * as DndKit from '@/systems.client/dndkit'
import * as DndKitReact from '@dnd-kit/react'
import React from 'react'

export function DragContextProvider(props: { children: React.ReactNode }) {
	const hooksRef = React.useRef({} as Record<string, DND.DragEndHandler>)

	function addHook(key: string, hook: DND.DragEndHandler) {
		hooksRef.current[key] = hook
	}
	function removeHook(key: string) {
		delete hooksRef.current[key]
	}

	return (
		<DndKitReact.DragDropProvider
			onDragEnd={event => {
				const { operation } = event
				const { source, target } = operation
				if (!target || !source) return
				for (const hook of Object.values(hooksRef.current)) {
					hook({
						active: DND.deserializeDragItem(source.id as string),
						over: DND.deserializeDropItem(target.id as string),
					})
				}
			}}
		>
			<DndKit.DragEndContext.Provider value={{ addHook, removeHook }}>{props.children}</DndKit.DragEndContext.Provider>
		</DndKitReact.DragDropProvider>
	)
}
