import { assertNever } from '@/lib/type-guards'
import { z } from '@/lib/zod'

export const WINDOW_ID = z.enum([
	'player-details',
	'layer-info',
	'squad-details',
	'teamswaps-help',
	'team-swaps',
	'switch-requests',
	'timeouts',
	'pool-config',
	'sandbox-control',
	'sandbox-admin-list',
	'server-console',
	'chart',
])

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
	return ordered.map((w, i) => (w.stackOrder === i ? w : { ...w, stackOrder: i }))
}

export type InitialPosition = 'above' | 'below' | 'left' | 'right' | 'viewport-center'
type Side = Exclude<InitialPosition, 'viewport-center'>
type Size = { width: number; height: number }
type Rect = Size & { left: number; top: number }
type Point = { x: number; y: number }

const SIDE_PREFERENCE: Record<Side, Side[]> = {
	below: ['below', 'above', 'right', 'left'],
	above: ['above', 'below', 'right', 'left'],
	left: ['left', 'right', 'above', 'below'],
	right: ['right', 'left', 'above', 'below'],
}

// In a right-to-left page 'left' and 'right' swap, so a window opens on the same side of its anchor relative to the
// reading direction. Positions stay physical screen coordinates after this.
const MIRRORED_SIDE: Record<Side, Side> = { below: 'below', above: 'above', left: 'right', right: 'left' }

export type SolvePositionInput = {
	anchor: Rect | null
	size: Size
	preferred: InitialPosition
	offset: number
	padding: number
	viewport: Size
	rtl: boolean
}

/**
 * Where a window of `size` first opens. The window always stays inside the viewport at its own size. It goes beside
 * the anchor, on the first side in order of preference where it does not cover the anchor, sliding along that side
 * as far as the viewport requires. If every side covers the anchor, it takes the side that covers the least.
 */
export function solveInitialPosition(input: SolvePositionInput): Point {
	const { anchor, size, preferred, offset, padding, viewport, rtl } = input
	if (preferred === 'viewport-center' || !anchor) {
		return clampToViewport({ x: (viewport.width - size.width) / 2, y: (viewport.height - size.height) / 2 }, size, padding, viewport)
	}

	let best: { pos: Point; overlap: number } | null = null
	for (const side of SIDE_PREFERENCE[preferred]) {
		const pos = clampToViewport(besideAnchor(anchor, size, rtl ? MIRRORED_SIDE[side] : side, offset), size, padding, viewport)
		const overlap = overlapArea(anchor, { left: pos.x, top: pos.y, width: size.width, height: size.height })
		if (overlap === 0) return pos
		if (!best || overlap < best.overlap) best = { pos, overlap }
	}
	return best!.pos
}

// A window larger than the viewport is pinned to the top-left padding, so its title bar stays reachable.
export function clampToViewport(pos: Point, size: Size, padding: number, viewport: Size): Point {
	return {
		x: Math.max(padding, Math.min(pos.x, viewport.width - size.width - padding)),
		y: Math.max(padding, Math.min(pos.y, viewport.height - size.height - padding)),
	}
}

function besideAnchor(anchor: Rect, size: Size, side: Side, offset: number): Point {
	const centeredX = anchor.left + anchor.width / 2 - size.width / 2
	const centeredY = anchor.top + anchor.height / 2 - size.height / 2
	switch (side) {
		case 'below':
			return { x: centeredX, y: anchor.top + anchor.height + offset }
		case 'above':
			return { x: centeredX, y: anchor.top - size.height - offset }
		case 'left':
			return { x: anchor.left - size.width - offset, y: centeredY }
		case 'right':
			return { x: anchor.left + anchor.width + offset, y: centeredY }
		default:
			assertNever(side)
	}
}

function overlapArea(a: Rect, b: Rect): number {
	const width = Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left)
	const height = Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top)
	return Math.max(0, width) * Math.max(0, height)
}
