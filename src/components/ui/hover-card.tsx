import * as HoverCardPrimitive from '@radix-ui/react-hover-card'
import * as React from 'react'

import { cn } from '@/lib/utils'
import { BaseZIndexContext, useZIndex, ZI_OFFSETS } from '@/models/zindex'

const HoverCard = HoverCardPrimitive.Root

const HoverCardTrigger = HoverCardPrimitive.Trigger

const HoverCardContent = React.forwardRef<
	React.ElementRef<typeof HoverCardPrimitive.Content>,
	React.ComponentPropsWithoutRef<typeof HoverCardPrimitive.Content>
>(({ className, align = 'center', sideOffset = 4, children, style, ...props }, ref) => {
	const zIndex = useZIndex(ZI_OFFSETS.POPOVER)
	return (
		<HoverCardPrimitive.Content
			ref={ref}
			align={align}
			sideOffset={sideOffset}
			style={{ zIndex, ...style }}
			className={cn('fd-pop w-64 outline-hidden', className)}
			{...props}
		>
			<BaseZIndexContext.Provider value={zIndex}>{children}</BaseZIndexContext.Provider>
		</HoverCardPrimitive.Content>
	)
})
HoverCardContent.displayName = HoverCardPrimitive.Content.displayName

export { HoverCard, HoverCardContent, HoverCardTrigger }
