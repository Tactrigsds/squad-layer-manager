import { z } from 'zod'

export const WINDOW_ID = z.enum(['player-details', 'layer-info'])

export type WindowId = z.infer<typeof WINDOW_ID>

export interface DraggableWindowContextValue {
	windowId: string
	close: () => void
	isPinned: boolean
	setIsPinned: (pinned: boolean) => void
	bringToFront: () => void
	registerDragBar: (element: HTMLElement | null) => void
	zIndex: number
}
