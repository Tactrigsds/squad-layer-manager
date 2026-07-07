import * as DND from '@/models/dndkit.models'
import * as DndKit from '@/systems/dndkit.client'
import { Cursor, defaultPreset, PreventSelection } from '@dnd-kit/dom'
import * as DndKitReact from '@dnd-kit/react'
import React from 'react'

// dnd-kit's Cursor and PreventSelection plugins each inject a global `* { ... !important }` stylesheet on
// drag start and remove it on drop. A universal-selector rule forces a full-document style recalc (every
// element, ~thousands) four times per drag -- the dominant cause of drag/drop freezes here. Drop them; the
// grabbing cursor and drag-time selection suppression are cosmetic and not worth a whole-document restyle.
const DRAG_PLUGINS = defaultPreset.plugins.filter((p) => p !== Cursor && p !== PreventSelection)

export function DragContextProvider(props: { children: React.ReactNode }) {
	const handlersRef = React.useRef(new Map<string, DND.DragEndHandler>())

	const addHandler = React.useCallback((key: string, handler: DND.DragEndHandler) => {
		handlersRef.current.set(key, handler)
	}, [])
	const removeHandler = React.useCallback((key: string) => {
		handlersRef.current.delete(key)
	}, [])

	const dragEndContextValue = React.useMemo(() => ({ addHook: addHandler, removeHook: removeHandler }), [addHandler, removeHandler])

	return (
		<DndKitReact.DragDropProvider
			plugins={DRAG_PLUGINS}
			onDragEnd={event => {
				const { operation } = event
				const { source, target } = operation
				if (!target || !source) return
				const active = DND.deserializeDragItem(source.id as string)
				const over = DND.deserializeDropItem(target.id as string)
				const hooks = [...handlersRef.current.values()]
				// Defer handler dispatch out of dnd-kit's drop transition. Handlers synchronously mutate the
				// queue store, which fans a large number of zustand subscription updates into the startTransition
				// dnd-kit runs its drop finalization in -- tripping React's "large number of updates inside
				// startTransition" concurrent-mode warning. A microtask runs before paint, so there's no flash.
				queueMicrotask(() => {
					for (const hook of hooks) {
						hook({ active, over })
					}
				})
			}}
		>
			<DndKit.DragEndContext.Provider value={dragEndContextValue}>
				{props.children}
			</DndKit.DragEndContext.Provider>
		</DndKitReact.DragDropProvider>
	)
}
