import { Slot } from '@radix-ui/react-slot'
import * as React from 'react'
import { createPortal } from 'react-dom'

import { HELP_TIP_DELAY_MS, useFollowTooltip } from '@/hooks/use-follow-tooltip'
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
 * Passing an `anchor` parks it at one point instead, which with `interactive` makes it reachable. `Tooltip` below
 * drives both modes from a single trigger and is what most callers want.
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

	// recording the pointer costs one listener for the whole app and has to be running before the first tooltip
	// opens, or that one has nowhere to place itself
	React.useEffect(() => Flt.watchPointer(), [])

	// a closed tooltip must not subscribe to movement: a page carries far more of them than it ever shows at once
	const tracking = props.content !== null && !anchor
	React.useEffect(() => {
		if (!tracking) return
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
	}, [position, tracking])

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
			className={cn('fd-tip fixed left-0 top-0', props.interactive ? 'pointer-events-auto' : 'pointer-events-none', props.className)}
		>
			{props.content}
		</div>,
		document.body,
	)
}

type TriggerProps = React.HTMLAttributes<HTMLElement> & {
	ref: (node: HTMLElement | null) => void
	'aria-describedby': string | undefined
	'aria-expanded'?: boolean
}

type ContentProps = Pick<
	React.ComponentProps<typeof TrackingTooltip>,
	'id' | 'nodeRef' | 'anchor' | 'interactive' | 'onPointerEnter' | 'onPointerLeave'
>

type TooltipState = { open: boolean; triggerProps: TriggerProps; contentProps: ContentProps }

// Compound-component plumbing only: the trigger and the content are meaningless outside a `Tooltip`, so an unset
// context is a mistake rather than a state to render.
const TooltipCtx = React.createContext<TooltipState | null>(null)

function useTooltipState() {
	const state = React.useContext(TooltipCtx)
	if (!state) throw new Error('TooltipTrigger and TooltipContent must be used inside a <Tooltip>')
	return state
}

/**
 * Hover, focus or tap a trigger to show a tooltip that follows the pointer. `useFollowTooltip` documents the full
 * state machine.
 *
 * `pinnable` is needed only when the content holds links or buttons: clicking the trigger then freezes the tooltip
 * and lets the pointer reach them. Plain-text tooltips leave it off, so a click on the trigger dismisses them
 * rather than parking a surface over whatever the next click was aimed at.
 *
 * `help` marks a tip that explains a control rather than content the reader went looking for. Those wait for the
 * pointer to settle, so sweeping a toolbar sets nothing off. A tooltip that is itself the point of the hover, like
 * a name behind an avatar, leaves it off and opens at once.
 *
 */
const Tooltip = (props: { children: React.ReactNode; pinnable?: boolean; help?: boolean }) => {
	return (
		<HoverTooltip pinnable={props.pinnable ?? false} delayMs={props.help ? HELP_TIP_DELAY_MS : 0}>
			{props.children}
		</HoverTooltip>
	)
}
Tooltip.displayName = 'Tooltip'

function HoverTooltip(props: { children: React.ReactNode; pinnable: boolean; delayMs: number }) {
	const follow = useFollowTooltip({ pinnable: props.pinnable, delayMs: props.delayMs })
	return <TooltipCtx.Provider value={follow}>{props.children}</TooltipCtx.Provider>
}

const TooltipTrigger = React.forwardRef<HTMLElement, React.HTMLAttributes<HTMLElement> & { asChild?: boolean }>(
	({ asChild, ...props }, forwardedRef) => {
		const { triggerProps } = useTooltipState()
		const { ref: setTrigger, ...ownProps } = triggerProps

		const setRef = React.useCallback(
			(node: HTMLElement | null) => {
				// A native title on any ancestor is inherited by everything under it, and the browser draws that over
				// this tooltip. An empty title is how an element declares it has no advisory text of its own, which is
				// exactly true of a trigger whose advisory text is the tooltip -- but not of one that sets a title
				// deliberately, so that one is left alone. Set on the node rather than passed as a prop so it holds
				// whatever element `asChild` was given; ref callbacks run after the mutation phase, so a title React
				// is managing is already in place by the time this reads for one.
				if (node && !node.hasAttribute('title')) node.setAttribute('title', '')
				setTrigger(node)
				if (typeof forwardedRef === 'function') forwardedRef(node)
				else if (forwardedRef) forwardedRef.current = node
			},
			[setTrigger, forwardedRef],
		)

		const Comp = asChild ? Slot : 'button'
		return <Comp ref={setRef} type={asChild ? undefined : 'button'} {...props} {...composeHandlers(ownProps, props)} />
	},
)
TooltipTrigger.displayName = 'TooltipTrigger'

const TooltipContent = (props: { children?: React.ReactNode; className?: string }) => {
	const { open, contentProps } = useTooltipState()
	return <TrackingTooltip {...contentProps} className={props.className} content={open ? props.children : null} />
}
TooltipContent.displayName = 'TooltipContent'

// The trigger owns pointer and focus handlers the caller may also want, so run ours and then theirs rather than
// letting either spread win.
function composeHandlers(ours: React.HTMLAttributes<HTMLElement>, theirs: React.HTMLAttributes<HTMLElement>) {
	const composed: Record<string, unknown> = { ...ours }
	for (const [key, ourHandler] of Object.entries(ours)) {
		const theirHandler = (theirs as Record<string, unknown>)[key]
		if (typeof ourHandler !== 'function' || typeof theirHandler !== 'function') continue
		composed[key] = (event: unknown) => {
			ourHandler(event)
			theirHandler(event)
		}
	}
	return composed
}

export { Tooltip, TooltipContent, TooltipTrigger }
