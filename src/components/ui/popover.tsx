import * as PopoverPrimitive from '@radix-ui/react-popover'
import * as React from 'react'

import { cn } from '@/lib/utils'
import { BaseZIndexContext, useZIndex, ZI_OFFSETS } from '@/models/zindex'

import { DraggableWindowOutlet } from './draggable-window'

const Popover = PopoverPrimitive.Root

const PopoverTrigger = PopoverPrimitive.Trigger

const PopoverAnchor = PopoverPrimitive.Anchor

const PopoverContent = React.forwardRef<
	React.ElementRef<typeof PopoverPrimitive.Content>,
	React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>
>(({ className, align = 'center', sideOffset = 4, collisionPadding = 8, children, style, ...props }, ref) => {
	const draggableWindowOutletKey = React.useId()
	const contentRef = React.useRef<HTMLDivElement | null>(null)
	const [contentNode, setContentNode] = React.useState<HTMLDivElement | null>(null)

	const combinedRef = React.useCallback(
		(node: HTMLDivElement | null) => {
			contentRef.current = node
			setContentNode(node)
			if (typeof ref === 'function') {
				ref(node)
			} else if (ref) {
				;(ref as React.MutableRefObject<HTMLDivElement | null>).current = node
			}
		},
		[ref],
	)

	// a Dialog's scroll lock (react-remove-scroll) preventDefaults every wheel event that reaches the document
	// from outside the dialog's own content, and popper content is portalled to the body -- so without this an
	// option list inside a dialog cannot be scrolled at all. Keeping the event inside the popover leaves the
	// browser's own scrolling intact.
	React.useEffect(() => {
		if (!contentNode) return
		const stopPropagation = (e: WheelEvent) => e.stopPropagation()
		contentNode.addEventListener('wheel', stopPropagation)
		return () => contentNode.removeEventListener('wheel', stopPropagation)
	}, [contentNode])

	const contentZIndex = useZIndex(ZI_OFFSETS.POPOVER)

	// never wider or taller than the viewport leaves: on a phone a popover is the whole screen minus a gutter
	return (
		<PopoverPrimitive.Portal>
			<PopoverPrimitive.Content
				ref={combinedRef}
				align={align}
				sideOffset={sideOffset}
				collisionPadding={collisionPadding}
				className={cn(
					'fd-pop w-72 max-w-[calc(100vw-16px)] max-h-(--radix-popover-content-available-height) overflow-y-auto outline-hidden',
					className,
				)}
				style={{ zIndex: contentZIndex, ...style }}
				{...props}
			>
				<BaseZIndexContext.Provider value={contentZIndex}>
					<DraggableWindowOutlet outletKey={draggableWindowOutletKey} getElement={() => contentRef.current}>
						{children}
					</DraggableWindowOutlet>
				</BaseZIndexContext.Provider>
			</PopoverPrimitive.Content>
		</PopoverPrimitive.Portal>
	)
})
PopoverContent.displayName = PopoverPrimitive.Content.displayName

export { Popover, PopoverAnchor, PopoverContent, PopoverTrigger }
