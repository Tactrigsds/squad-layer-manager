import * as PopoverPrimitive from '@radix-ui/react-popover'
import { Slot } from '@radix-ui/react-slot'
import * as TooltipPrimitive from '@radix-ui/react-tooltip'
import * as React from 'react'

import { type ArmedBy, type ArmProps, composeArm, useArmOnInteraction, useReplayArming } from '@/hooks/use-arm-on-interaction'
import { useIsMobile } from '@/hooks/use-is-mobile'
import { cn } from '@/lib/utils'
import { useZIndex, ZI_OFFSETS } from '@/models/zindex'

const TooltipProvider = TooltipPrimitive.Provider

// `arm` is non-null exactly while the tooltip is still deferred, and carries the handlers that wake it.
const TooltipMobileContext = React.createContext<{
	isMobile: boolean
	arm: ArmProps | null
	armedBy: ArmedBy
} | null>(null)

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
 *
 * Nothing below is mounted until the trigger is first hovered, focused or pressed, so a list that hangs a tooltip
 * off every row pays for the ones that get opened rather than the ones that get rendered. Everything a deferred
 * tooltip would otherwise cost lives in ArmedTooltip, including `useIsMobile`, which registers a resize listener
 * per instance. See `useArmOnInteraction`.
 */
const Tooltip = ({
	children,
	...props
}: React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Root> & {
	children: React.ReactNode
}) => {
	// a caller driving `open` itself has already decided this tooltip matters, and would never see our arming events
	const [armed, armProps, armedBy] = useArmOnInteraction(props.open !== undefined || props.defaultOpen !== undefined)
	const deferred = React.useMemo(() => ({ isMobile: false, arm: armProps, armedBy: null }), [armProps])

	if (!armed) return <TooltipMobileContext.Provider value={deferred}>{children}</TooltipMobileContext.Provider>
	return (
		<ArmedTooltip armedBy={armedBy} {...props}>
			{children}
		</ArmedTooltip>
	)
}
Tooltip.displayName = 'Tooltip'

const ArmedTooltip = ({
	children,
	armedBy,
	...props
}: React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Root> & {
	children: React.ReactNode
	armedBy: ArmedBy
}) => {
	const isMobile = useIsMobile()
	const contextValue = React.useMemo(() => ({ isMobile, arm: null, armedBy }), [isMobile, armedBy])
	const Root = isMobile ? PopoverPrimitive.Root : TooltipPrimitive.Root

	return (
		<TooltipMobileContext.Provider value={contextValue}>
			<Root {...props}>{children}</Root>
		</TooltipMobileContext.Provider>
	)
}

/**
 * Enhanced TooltipTrigger that adapts trigger behavior:
 * - Desktop: Hover/focus triggers tooltip
 * - Mobile: Click/tap triggers popover (with toggle behavior)
 */
const TooltipTrigger = React.forwardRef<
	React.ElementRef<typeof TooltipPrimitive.Trigger>,
	React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Trigger>
>(({ ...props }, ref) => {
	const { isMobile, arm, armedBy } = useTooltipMobile()

	// Stand in for whichever primitive will render here. Both render a button, or the child under asChild, so the
	// tree keeps its shape, and arming swaps the real handlers in underneath the pointer that is already there.
	if (arm) {
		const { asChild, ...rest } = props
		const Comp = asChild ? Slot : 'button'
		return (
			<Comp
				ref={ref}
				data-state="closed"
				{...(asChild ? {} : { type: 'button' as const })}
				{...rest}
				onPointerEnter={props.onPointerEnter ? composeArm(props.onPointerEnter, arm.onPointerEnter) : arm.onPointerEnter}
				onClick={props.onClick ? composeArm(props.onClick, arm.onClick) : arm.onClick}
				onFocus={props.onFocus ? composeArm(props.onFocus, arm.onFocus) : arm.onFocus}
			/>
		)
	}

	return <ArmedTooltipTrigger isMobile={isMobile} armedBy={armedBy} forwardedRef={ref} {...props} />
})
TooltipTrigger.displayName = 'TooltipTrigger'

function ArmedTooltipTrigger({
	isMobile,
	armedBy,
	forwardedRef,
	...props
}: React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Trigger> & {
	isMobile: boolean
	armedBy: ArmedBy
	forwardedRef: React.Ref<React.ElementRef<typeof TooltipPrimitive.Trigger>>
}) {
	const ref = useReplayArming(armedBy, forwardedRef)

	// On mobile, use PopoverTrigger which handles click-to-toggle
	if (isMobile) return <PopoverPrimitive.Trigger ref={ref} {...props} />

	// On desktop, use standard TooltipTrigger with hover behavior
	return <TooltipPrimitive.Trigger ref={ref} {...props} />
}

const TooltipContent = React.forwardRef<
	React.ElementRef<typeof TooltipPrimitive.Content>,
	React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content> & {
		sideOffset?: number
	}
>((props, ref) => {
	// nothing to portal into before the root exists, and the hooks below are not worth paying for until there is
	if (useTooltipMobile().arm) return null
	return <ArmedTooltipContent ref={ref} {...props} />
})
TooltipContent.displayName = 'TooltipContent'

/**
 * Enhanced TooltipContent that adapts content presentation:
 * - Desktop: Standard tooltip styling with subtle appearance
 * - Mobile: Popover styling with enhanced visibility (shadow, border)
 *
 * Mobile popovers are more prominent since they require explicit user interaction.
 */
const ArmedTooltipContent = React.forwardRef<
	React.ElementRef<typeof TooltipPrimitive.Content>,
	React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content> & {
		sideOffset?: number
	}
>(({ className, sideOffset = 4, style, ...props }, ref) => {
	const { isMobile } = useTooltipMobile()
	const zIndex = useZIndex(ZI_OFFSETS.TOOLTIP)

	// On mobile, use PopoverContent with enhanced styling for better visibility
	if (isMobile) {
		return (
			<PopoverPrimitive.Portal>
				<PopoverPrimitive.Content
					ref={ref}
					sideOffset={sideOffset}
					style={{ zIndex, ...style }}
					className={cn(
						'overflow-hidden rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground shadow-lg border border-border',
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
				style={{ zIndex, ...style }}
				className={cn(
					'overflow-hidden rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground',
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
ArmedTooltipContent.displayName = 'ArmedTooltipContent'

export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger }
