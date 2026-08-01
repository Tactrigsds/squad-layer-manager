import * as React from 'react'
import { createPortal } from 'react-dom'

import * as Flt from '@/lib/floating'
import { cn } from '@/lib/utils'
import { useZIndex, ZI_OFFSETS } from '@/models/zindex'

/**
 * A tooltip that follows the pointer instead of anchoring to a trigger, for surfaces whose hover targets are
 * smaller and denser than an element Radix could anchor to -- chart segments, legend swatches, stat tiles.
 *
 * The caller owns which target is hovered and passes the content for it; `null` closes the tooltip. Movement is
 * written straight to the node's transform, so following the pointer never re-renders React -- only a change of
 * content does.
 *
 * Passing an `anchor` parks it at one point instead, which with `interactive` makes it reachable: see
 * `useFollowTooltip`, which drives both modes from one trigger.
 */
export function TrackingTooltip(props: {
	content: React.ReactNode | null
	className?: string
	offset?: number
	// keeps the tooltip inside this element rather than inside the viewport
	boundary?: React.RefObject<HTMLElement | null>
	id?: string
	// parks the tooltip at this point instead of following the pointer
	anchor?: Flt.Point | null
	// lets the pointer reach the tooltip, for content with links or buttons in it
	interactive?: boolean
	nodeRef?: React.RefObject<HTMLDivElement | null>
	onPointerEnter?: React.PointerEventHandler<HTMLDivElement>
	onPointerLeave?: React.PointerEventHandler<HTMLDivElement>
}) {
	const zIndex = useZIndex(ZI_OFFSETS.TOOLTIP)
	const ref = React.useRef<HTMLDivElement | null>(null)
	const frame = React.useRef<number | null>(null)
	const offset = props.offset
	const boundary = props.boundary
	const anchor = props.anchor ?? null
	const nodeRef = props.nodeRef

	const setNode = React.useCallback(
		(node: HTMLDivElement | null) => {
			ref.current = node
			if (nodeRef) nodeRef.current = node
		},
		[nodeRef],
	)

	const position = React.useCallback(() => {
		const el = ref.current
		const point = anchor ?? Flt.lastPointer()
		if (!el || !point) return
		const rect = el.getBoundingClientRect()
		const bounds = boundary?.current ? Flt.elementBounds(boundary.current) : Flt.viewportBounds()
		const { x, y } = Flt.followPoint(point, rect, bounds, { offset })
		el.style.transform = `translate3d(${x}px, ${y}px, 0)`
		el.style.visibility = 'visible'
	}, [offset, boundary, anchor])

	React.useEffect(() => {
		if (anchor) return
		const untrack = Flt.trackPointer(() => {
			if (!ref.current || frame.current !== null) return
			frame.current = requestAnimationFrame(() => {
				frame.current = null
				position()
			})
		})
		return () => {
			untrack()
			if (frame.current !== null) cancelAnimationFrame(frame.current)
			frame.current = null
		}
	}, [position, anchor])

	// before paint, so the tooltip's first frame is already at the pointer rather than at the origin
	React.useLayoutEffect(() => {
		if (props.content !== null) position()
	}, [props.content, position])

	if (props.content === null) return null

	return createPortal(
		<div
			ref={setNode}
			id={props.id}
			role="tooltip"
			style={{ zIndex, visibility: 'hidden' }}
			onPointerEnter={props.onPointerEnter}
			onPointerLeave={props.onPointerLeave}
			className={cn(
				'fixed left-0 top-0 max-w-xs rounded-md border border-border bg-popover px-2 py-1.5',
				'text-xs text-popover-foreground shadow-md',
				props.interactive ? 'pointer-events-auto' : 'pointer-events-none',
				props.className,
			)}
		>
			{props.content}
		</div>,
		document.body,
	)
}
