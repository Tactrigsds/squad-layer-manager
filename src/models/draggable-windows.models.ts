import { z } from 'zod'

export const WINDOW_ID = z.enum(['player-details', 'layer-info', 'squad-details', 'teamswitches-help'])

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

/**
 * Windows carry a dense stack ordinal rather than a z-index. The ordinal is resolved against
 * the enclosing base z-index at render time, so the same window renders correctly whether its
 * outlet lives at the page root or inside a dialog or popover.
 */
export function normalizeStackOrder<T extends { stackOrder: number }>(windows: readonly T[]): T[] {
	const ordered = [...windows].sort((a, b) => a.stackOrder - b.stackOrder)
	return ordered.map((w, i) => w.stackOrder === i ? w : { ...w, stackOrder: i })
}
