// Placement for elements that follow the pointer rather than anchor to a trigger, plus the pointer tracking they
// need. Radix owns the anchored case (popover, tooltip, dropdown); this is the case it has no primitive for.

export type Point = { x: number; y: number }
export type Size = { width: number; height: number }
export type Bounds = { left: number; top: number; right: number; bottom: number }

export type FollowOptions = {
	// gap between the pointer and the nearest corner of the followed element
	offset?: number
	// how close to the bounds the element may sit
	margin?: number
}

// Where to put an element of `size` so it trails the pointer without leaving `bounds`. Preferred corner is
// below-right; each axis independently flips to the other side of the pointer when that side overflows, and
// clamps when neither side fits.
export function followPoint(pointer: Point, size: Size, bounds: Bounds, opts?: FollowOptions): Point {
	const offset = opts?.offset ?? 14
	const margin = opts?.margin ?? 8
	return {
		x: placeAxis(pointer.x, size.width, bounds.left + margin, bounds.right - margin, offset),
		y: placeAxis(pointer.y, size.height, bounds.top + margin, bounds.bottom - margin, offset),
	}
}

function placeAxis(pointer: number, length: number, min: number, max: number, offset: number) {
	const after = pointer + offset
	if (after + length <= max) return after
	const before = pointer - offset - length
	if (before >= min) return before
	// neither side fits: sit against whichever edge leaves the element most visible
	return Math.max(min, Math.min(max - length, after))
}

export function viewportBounds(): Bounds {
	return { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight }
}

export function elementBounds(el: HTMLElement): Bounds {
	const rect = el.getBoundingClientRect()
	return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }
}

let lastPoint: Point | null = null
const listeners = new Set<(p: Point) => void>()

function handleMove(ev: PointerEvent) {
	lastPoint = { x: ev.clientX, y: ev.clientY }
	for (const listener of listeners) listener(lastPoint)
}

// a touch never moves before it lands, so pointerdown is the only chance to learn where a tap was
const TRACKED = ['pointermove', 'pointerdown'] as const

// The pointer's last known viewport position, or null before it has moved over the document. A follower mounting
// mid-hover reads this to place itself for its first paint, rather than waiting for the next move.
export function lastPointer(): Point | null {
	return lastPoint
}

// One document listener shared by every follower, installed while any of them is mounted.
export function trackPointer(onMove: (p: Point) => void): () => void {
	if (listeners.size === 0) {
		for (const type of TRACKED) document.addEventListener(type, handleMove, { passive: true, capture: true })
	}
	listeners.add(onMove)
	return () => {
		listeners.delete(onMove)
		if (listeners.size === 0) {
			for (const type of TRACKED) document.removeEventListener(type, handleMove, { capture: true })
		}
	}
}
