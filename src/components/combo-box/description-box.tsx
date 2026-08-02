import React, { useImperativeHandle, useRef } from 'react'

import { cn } from '@/lib/utils'
import { useZIndex, ZI_OFFSETS } from '@/models/zindex'

export type DescriptionBoxHandle = {
	show: (title: string | null, description: string) => void
	hide: () => void
}

// the side of the option panel the box sits on when it fits there
export type DescriptionBoxPlacement = 'right' | 'top'

// A box describing the option under the cursor, anchored to the whole option panel rather than to the
// option, so it holds still as the highlight moves. Its contents are written straight to the DOM through
// the handle: the highlight changes on every row the pointer crosses, and rendering that through React
// re-rendered the option list (a picker can carry hundreds of rows) for each one.
export function DescriptionBox(props: { ref: React.Ref<DescriptionBoxHandle>; placement: DescriptionBoxPlacement; className?: string }) {
	const rootRef = useRef<HTMLDivElement | null>(null)
	const titleRef = useRef<HTMLDivElement | null>(null)
	const bodyRef = useRef<HTMLDivElement | null>(null)
	const placement = props.placement

	useImperativeHandle(
		props.ref,
		() => ({
			show: (title, description) => {
				const root = rootRef.current
				if (!root || !titleRef.current || !bodyRef.current) return
				titleRef.current.textContent = title ?? ''
				titleRef.current.hidden = title == null
				bodyRef.current.textContent = description
				const wasHidden = root.hidden
				root.hidden = false
				// the panel does not move while it is open and the box's size is capped, so where it fits is
				// settled on the way in. Measuring per row would force a reflow on every row the pointer crosses.
				if (wasHidden) {
					root.dataset.flipped = 'false'
					const rect = root.getBoundingClientRect()
					const overflows = placement === 'right' ? rect.right > window.innerWidth : rect.top < 0
					if (overflows) root.dataset.flipped = 'true'
				}
			},
			hide: () => {
				if (rootRef.current) rootRef.current.hidden = true
			},
		}),
		[placement],
	)

	const zIndex = useZIndex(ZI_OFFSETS.TOOLTIP)
	return (
		<div
			ref={rootRef}
			hidden
			style={{ zIndex }}
			className={cn(
				'pointer-events-none absolute max-h-48 space-y-1 overflow-hidden rounded-md border bg-popover p-3 text-popover-foreground shadow-md',
				placement === 'right'
					? 'left-full top-0 ml-1.5 w-64 data-[flipped=true]:left-auto data-[flipped=true]:right-full data-[flipped=true]:ml-0 data-[flipped=true]:mr-1.5'
					: 'bottom-full left-0 mb-1.5 w-full data-[flipped=true]:bottom-auto data-[flipped=true]:top-full data-[flipped=true]:mb-0 data-[flipped=true]:mt-1.5',
				props.className,
			)}
		>
			<div ref={titleRef} className="break-words font-mono text-sm font-medium" />
			<div ref={bodyRef} className="break-words text-xs text-muted-foreground" />
		</div>
	)
}
