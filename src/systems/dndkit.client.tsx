import * as DND from '@/models/dndkit.models'
import * as DndKit from '@/systems/dndkit.client'
import * as DndKitReact from '@dnd-kit/react'
import React from 'react'

export function DragContextProvider(props: { children: React.ReactNode }) {
	const handlersRef = React.useRef(new Map<string, DND.DragEndHandler>())

	function addHandler(key: string, handler: DND.DragEndHandler) {
		handlersRef.current.set(key, handler)
	}
	function removeHandler(key: string) {
		handlersRef.current.delete(key)
	}

	return (
		<DndKitReact.DragDropProvider
			onDragEnd={event => {
				const { operation } = event
				const { source, target } = operation
				if (!target || !source) return
				for (const hook of handlersRef.current.values()) {
					hook({
						active: DND.deserializeDragItem(source.id as string),
						over: DND.deserializeDropItem(target.id as string),
					})
				}
			}}
		>
			<DndKit.DragEndContext.Provider value={{ addHook: addHandler, removeHook: removeHandler }}>
				{props.children}
			</DndKit.DragEndContext.Provider>
		</DndKitReact.DragDropProvider>
	)
}
