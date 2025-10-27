import * as PopoverPrimitive from '@radix-ui/react-popover'
import * as TooltipPrimitive from '@radix-ui/react-tooltip'
import * as React from 'react'

import { useIsMobile } from '@/hooks/use-is-mobile'
import { cn } from '@/lib/utils'

const TooltipProvider = TooltipPrimitive.Provider

// Context to share mobile state and ensure consistent behavior across all tooltip components
const TooltipMobileContext = React.createContext<
	{
		isMobile: boolean
	} | null
>(null)

const useTooltipMobile = () => {
	const context = React.useContext(TooltipMobileContext)
	if (!context) {
		throw new Error(
			'TooltipTrigger and TooltipContent must be used within a Tooltip component. Make sure to wrap your tooltip components in <Tooltip>...</Tooltip>',
		)
	}
	return context
}

/**
 * Enhanced Tooltip component that adapts behavior based on device type:
 * - Desktop: Uses native tooltip behavior (hover to show, blur to hide)
 * - Mobile: Uses popover behavior (tap to open, tap elsewhere or button again to close)
 *
 * This ensures better mobile UX since tooltips are difficult to interact with on touch devices.
 */
const Tooltip = ({ children, ...props }: React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Root> & {
	children: React.ReactNode
}) => {
	const isMobile = useIsMobile()

	// Provide mobile state to all child components via context
	const contextValue = React.useMemo(() => ({ isMobile }), [isMobile])

	// On mobile devices, use Popover which supports tap-to-open/close behavior
	if (isMobile) {
		return (
			<TooltipMobileContext.Provider value={contextValue}>
				<PopoverPrimitive.Root {...props}>{children}</PopoverPrimitive.Root>
			</TooltipMobileContext.Provider>
		)
	}

	// On desktop, use standard Tooltip with hover behavior
	return (
		<TooltipMobileContext.Provider value={contextValue}>
			<TooltipPrimitive.Root {...props}>{children}</TooltipPrimitive.Root>
		</TooltipMobileContext.Provider>
	)
}
Tooltip.displayName = 'Tooltip'

/**
 * Enhanced TooltipTrigger that adapts trigger behavior:
 * - Desktop: Hover/focus triggers tooltip
 * - Mobile: Click/tap triggers popover (with toggle behavior)
 */
const TooltipTrigger = React.forwardRef<
	React.ElementRef<typeof TooltipPrimitive.Trigger>,
	React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Trigger>
>(({ ...props }, ref) => {
	const { isMobile } = useTooltipMobile()

	// On mobile, use PopoverTrigger which handles click-to-toggle
	if (isMobile) {
		return <PopoverPrimitive.Trigger ref={ref} {...props} />
	}

	// On desktop, use standard TooltipTrigger with hover behavior
	return <TooltipPrimitive.Trigger ref={ref} {...props} />
})
TooltipTrigger.displayName = 'TooltipTrigger'

/**
 * Enhanced TooltipContent that adapts content presentation:
 * - Desktop: Standard tooltip styling with subtle appearance
 * - Mobile: Popover styling with enhanced visibility (shadow, border)
 *
 * Mobile popovers are more prominent since they require explicit user interaction.
 */
const TooltipContent = React.forwardRef<
	React.ElementRef<typeof TooltipPrimitive.Content>,
	React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content> & {
		sideOffset?: number
	}
>(({ className, sideOffset = 4, ...props }, ref) => {
	const { isMobile } = useTooltipMobile()

	// On mobile, use PopoverContent with enhanced styling for better visibility
	if (isMobile) {
		return (
			<PopoverPrimitive.Portal>
				<PopoverPrimitive.Content
					ref={ref}
					sideOffset={sideOffset}
					className={cn(
						'z-50 overflow-hidden rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground shadow-lg border border-border',
						'animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95',
						'data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2',
						className,
					)}
					{...props}
				/>
			</PopoverPrimitive.Portal>
		)
	}

	// On desktop, use standard TooltipContent with subtle styling
	return (
		<TooltipPrimitive.Portal>
			<TooltipPrimitive.Content
				ref={ref}
				sideOffset={sideOffset}
				className={cn(
					'z-50 overflow-hidden rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground',
					'animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95',
					'data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2',
					// overrides
					'bg-secondary text-secondary-foreground',
					className,
				)}
				{...props}
			/>
		</TooltipPrimitive.Portal>
	)
})
TooltipContent.displayName = 'TooltipContent'

export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger }
