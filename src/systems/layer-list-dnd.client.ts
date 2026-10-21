// Collision detection for the layer list's drop targets.
//
// A reorder separator takes up no height. Its hit area is a band computed from the rows around it, so starting a drag
// reflows nothing. A band runs from the centre of the row above to the centre of the row below. The box of a vote
// belongs to the separators between its choices: the band beside a vote stops at the vote's edge, and the first and
// last bands inside a vote stop at the vote's edges too. The first and last separators of the list reach the edges of
// the nearest `data-layer-list-bounds` element.
//
// A row's end zone (create a vote, combine requests) takes priority over the bands, which pass underneath it.
//
// The layer request list uses the same attributes, with every row a single row.
import { type CollisionDetector, CollisionPriority, CollisionType } from '@dnd-kit/abstract'

export const ROW_ATTR = 'data-ll-row'
export type RowKind = 'single' | 'vote'
export const SEPARATOR_ATTR = 'data-ll-separator'
export const BOUNDS_ATTR = 'data-layer-list-bounds'

// every separator's detector reads its neighbours' rects, so they are read once per frame and shared
const rects = new Map<Element, DOMRect>()
let clearScheduled = false

function rectOf(el: Element): DOMRect {
	let rect = rects.get(el)
	if (rect) return rect
	rect = getComputedStyle(el).display === 'contents' ? unionOfChildren(el) : el.getBoundingClientRect()
	rects.set(el, rect)
	if (!clearScheduled) {
		clearScheduled = true
		requestAnimationFrame(() => {
			rects.clear()
			clearScheduled = false
		})
	}
	return rect
}

function unionOfChildren(el: Element): DOMRect {
	let top = Infinity
	let left = Infinity
	let bottom = -Infinity
	let right = -Infinity
	for (const child of el.children) {
		const r = rectOf(child)
		if (r.width === 0 && r.height === 0) continue
		top = Math.min(top, r.top)
		left = Math.min(left, r.left)
		bottom = Math.max(bottom, r.bottom)
		right = Math.max(right, r.right)
	}
	if (top === Infinity) return new DOMRect()
	return new DOMRect(left, top, right - left, bottom - top)
}

function adjacentRow(sep: Element, dir: 'previousElementSibling' | 'nextElementSibling'): Element | null {
	for (let el = sep[dir]; el; el = el[dir]) {
		// the dragged row leaves the flow while dnd-kit's placeholder holds its slot
		if (el.hasAttribute('data-dnd-dragging')) continue
		if (el.hasAttribute(ROW_ATTR)) return el
		if (el.hasAttribute(SEPARATOR_ATTR)) return null
	}
	return null
}

// the edge of a row that a neighbouring band ends at: a vote's near edge, or a single row's centre
function bandEdge(row: Element, side: 'top' | 'bottom') {
	const rect = rectOf(row)
	if ((row.getAttribute(ROW_ATTR) as RowKind) === 'vote') return rect[side]
	return rect.top + rect.height / 2
}

function separatorBand(sep: Element) {
	const list = sep.parentElement
	if (!list) return null
	const bounds = rectOf(sep.closest(`[${BOUNDS_ATTR}]`) ?? list)
	const vote = list.closest(`[${ROW_ATTR}="vote"]`)
	const outer = vote ? rectOf(vote) : bounds
	const prev = adjacentRow(sep, 'previousElementSibling')
	const next = adjacentRow(sep, 'nextElementSibling')
	return {
		left: bounds.left,
		right: bounds.right,
		top: prev ? bandEdge(prev, 'bottom') : outer.top,
		bottom: next ? bandEdge(next, 'top') : outer.bottom,
	}
}

export const separatorCollision: CollisionDetector = ({ dragOperation, droppable }) => {
	const coords = dragOperation.position.current
	const element = (droppable as { element?: Element }).element
	if (!coords || !element) return null
	const band = separatorBand(element)
	if (!band) return null
	if (coords.x < band.left || coords.x > band.right || coords.y < band.top || coords.y >= band.bottom) return null
	return {
		id: droppable.id,
		value: 1,
		type: CollisionType.PointerIntersection,
		priority: CollisionPriority.High,
	}
}

// the pointer anywhere in the element, ahead of any band it overlaps: a row's end zone, or a whole panel
export const pointerInRectCollision: CollisionDetector = ({ dragOperation, droppable }) => {
	const coords = dragOperation.position.current
	const element = (droppable as { element?: Element }).element
	if (!coords || !element) return null
	const zone = rectOf(element)
	if (coords.x < zone.left || coords.x > zone.right || coords.y < zone.top || coords.y >= zone.bottom) return null
	return {
		id: droppable.id,
		value: 1,
		type: CollisionType.PointerIntersection,
		priority: CollisionPriority.Highest,
	}
}
