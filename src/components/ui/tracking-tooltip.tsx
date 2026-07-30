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
 */
export function TrackingTooltip(props: {
	content: React.ReactNode | null
	className?: string
	offset?: number
	// keeps the tooltip inside this element rather than inside the viewport
	boundary?: React.RefObject<HTMLElement | null>
}) {
	const zIndex = useZIndex(ZI_OFFSETS.TOOLTIP)
	const ref = React.useRef<HTMLDivElement | null>(null)
	const frame = React.useRef<number | null>(null)
	const offset = props.offset
	const boundary = props.boundary

	const position = React.useCallback(() => {
		const el = ref.current
		const pointer = Flt.lastPointer()
		if (!el || !pointer) return
		const rect = el.getBoundingClientRect()
		const bounds = boundary?.current ? Flt.elementBounds(boundary.current) : Flt.viewportBounds()
		const { x, y } = Flt.followPoint(pointer, rect, bounds, { offset })
		el.style.transform = `translate3d(${x}px, ${y}px, 0)`
		el.style.visibility = 'visible'
	}, [offset, boundary])

	React.useEffect(() => {
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
	}, [position])

	// before paint, so the tooltip's first frame is already at the pointer rather than at the origin
	React.useLayoutEffect(() => {
		if (props.content !== null) position()
	}, [props.content, position])

	if (props.content === null) return null

	return createPortal(
		<div
			ref={ref}
			role="tooltip"
			style={{ zIndex, visibility: 'hidden' }}
			className={cn(
				'fixed left-0 top-0 pointer-events-none max-w-xs rounded-md border border-border bg-popover px-2 py-1.5',
				'text-xs text-popover-foreground shadow-md',
				props.className,
			)}
		>
			{props.content}
		</div>,
		document.body,
	)
}
