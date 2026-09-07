import * as ScrollAreaPrimitive from '@radix-ui/react-scroll-area'
import * as React from 'react'

import { cn } from '@/lib/utils'
import { useZIndex, ZI_OFFSETS } from '@/models/zindex'

// radix sets the viewport's overflow per axis from the scrollbars that are rendered, so an axis with no
// ScrollBar is `overflow: hidden` -- content wider than the viewport is clipped and unreachable. Both axes
// scroll by default for that reason; pass `orientation` only where an axis genuinely cannot overflow.
const ScrollArea = React.forwardRef<
	React.ElementRef<typeof ScrollAreaPrimitive.Root>,
	React.ComponentPropsWithoutRef<typeof ScrollAreaPrimitive.Root> & {
		orientation?: 'vertical' | 'horizontal' | 'both'
		// stretch content shorter than the viewport to fill it, instead of leaving it shrink-wrapped at the
		// top. The children become a flex column, so the one to stretch takes `flex-1`.
		fill?: boolean
	}
>(({ className, children, orientation = 'both', fill = false, ...props }, ref) => {
	const zIndex = useZIndex(ZI_OFFSETS.SCROLLBAR)
	return (
		<ScrollAreaPrimitive.Root
			ref={ref}
			className={cn(
				'relative overflow-hidden',
				// radix lays the content out as a table so it can grow past the viewport; a vertical-only area wants it to shrink to the viewport instead
				orientation === 'vertical' && '[&_[data-radix-scroll-area-viewport]>div]:block!',
				// that same wrapper is the only box that can be measured against the viewport, so `fill` is
				// expressed on it: at least as tall as the viewport, and a flex column so children can grow
				fill &&
					'[&_[data-radix-scroll-area-viewport]>div]:flex! [&_[data-radix-scroll-area-viewport]>div]:flex-col [&_[data-radix-scroll-area-viewport]>div]:min-h-full',
				className,
			)}
			{...props}
		>
			<ScrollAreaPrimitive.Viewport className="h-full w-full rounded-[inherit]">{children}</ScrollAreaPrimitive.Viewport>
			{orientation !== 'horizontal' && <ScrollBar orientation="vertical" />}
			{orientation !== 'vertical' && <ScrollBar orientation="horizontal" />}
			<ScrollAreaPrimitive.Corner style={{ zIndex }} />
		</ScrollAreaPrimitive.Root>
	)
})
ScrollArea.displayName = ScrollAreaPrimitive.Root.displayName

const ScrollBar = React.forwardRef<
	React.ElementRef<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>,
	React.ComponentPropsWithoutRef<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>
>(({ className, orientation = 'vertical', style, ...props }, ref) => {
	const zIndex = useZIndex(ZI_OFFSETS.SCROLLBAR)
	return (
		<ScrollAreaPrimitive.ScrollAreaScrollbar
			ref={ref}
			orientation={orientation}
			className={cn(
				// on a touch screen the scrollbar overlays the content it would otherwise hide, and the finger scrolls anyway
				'flex touch-none select-none pointer-coarse:hidden',
				orientation === 'vertical' && 'h-full w-2.5 border-l border-l-transparent p-px',
				orientation === 'horizontal' && 'h-2.5 flex-col border-t border-t-transparent p-px',
				className,
			)}
			style={{ zIndex, ...style }}
			{...props}
		>
			<ScrollAreaPrimitive.ScrollAreaThumb className="relative flex-1 rounded-sm bg-ctl" />
		</ScrollAreaPrimitive.ScrollAreaScrollbar>
	)
})
ScrollBar.displayName = ScrollAreaPrimitive.ScrollAreaScrollbar.displayName

export { ScrollArea, ScrollBar }
