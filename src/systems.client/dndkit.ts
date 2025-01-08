import { DragEndEvent } from '@dnd-kit/core'
import React from 'react'

export type DragEndHandler = (evt: DragEndEvent) => void
type DragEndContext = {
	addHook: (key: string, handler: DragEndHandler) => void
	removeHook: (key: string) => void
}
export const DragEndContext = React.createContext<DragEndContext>({ addHook: () => {}, removeHook: () => {} })

export function useDragEnd(handler: DragEndHandler) {
	const id = React.useId()
	const ctx = React.useContext(DragEndContext)

	React.useEffect(() => {
		ctx.addHook(id, handler)
		return () => ctx.removeHook(id)
	}, [id, handler, ctx])
}
