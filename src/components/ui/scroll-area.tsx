import * as ScrollAreaPrimitive from '@radix-ui/react-scroll-area'
import * as React from 'react'

import { cn } from '@/lib/utils'
import { useZIndex, ZI_OFFSETS } from '@/models/zindex'

// radix sets the viewport's overflow per axis from the scrollbars that are rendered, so an axis with no
// ScrollBar is `overflow: hidden` -- content wider than the viewport is clipped and unreachable. Both axes
// scroll by default for that reason; pass `orientation` only where an axis genuinely cannot overflow.
const ScrollArea = React.forwardRef<
	React.ElementRef<typeof ScrollAreaPrimitive.Root>,
	React.ComponentPropsWithoutRef<typeof ScrollAreaPrimitive.Root> & { orientation?: 'vertical' | 'horizontal' | 'both' }
>(({ className, children, orientation = 'both', ...props }, ref) => {
	const zIndex = useZIndex(ZI_OFFSETS.SCROLLBAR)
	return (
		<ScrollAreaPrimitive.Root ref={ref} className={cn('relative overflow-hidden', className)} {...props}>
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
				'flex touch-none select-none',
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
