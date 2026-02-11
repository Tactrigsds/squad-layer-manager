import { Cross2Icon, DrawingPinFilledIcon, DrawingPinIcon } from '@radix-ui/react-icons'
import * as React from 'react'
import { createPortal } from 'react-dom'
import * as Zus from 'zustand'

import * as Obj from '@/lib/object'
import { cn } from '@/lib/utils'
import { DraggableWindowStore, type InitialPosition, useOpenWindows, useWindowDefinitions, type WindowDefinition, type WindowState } from '@/systems/draggable-window.client'

// ============================================================================
// Position Calculation
// ============================================================================

const FALLBACK_POSITIONS: Record<InitialPosition, InitialPosition[]> = {
	below: ['below', 'above', 'right', 'left', 'viewport-center'],
	above: ['above', 'below', 'right', 'left', 'viewport-center'],
	left: ['left', 'right', 'above', 'below', 'viewport-center'],
	right: ['right', 'left', 'above', 'below', 'viewport-center'],
	'viewport-center': ['viewport-center'],
}

function calculatePosition(
	anchorRect: DOMRect | null,
	contentRect: { width: number; height: number },
	position: InitialPosition,
	offset: number,
	collisionPadding: number,
): { x: number; y: number } | null {
	const viewport = {
		width: window.innerWidth,
		height: window.innerHeight,
	}

	let x: number
	let y: number

	if (position === 'viewport-center' || !anchorRect) {
		x = (viewport.width - contentRect.width) / 2
		y = (viewport.height - contentRect.height) / 2
	} else if (position === 'below') {
		x = anchorRect.left + anchorRect.width / 2 - contentRect.width / 2
		y = anchorRect.bottom + offset
	} else if (position === 'above') {
		x = anchorRect.left + anchorRect.width / 2 - contentRect.width / 2
		y = anchorRect.top - contentRect.height - offset
	} else if (position === 'left') {
		x = anchorRect.left - contentRect.width - offset
		y = anchorRect.top + anchorRect.height / 2 - contentRect.height / 2
	} else {
		// right
		x = anchorRect.right + offset
		y = anchorRect.top + anchorRect.height / 2 - contentRect.height / 2
	}

	// Check if position fits within viewport
	const fitsHorizontally = x >= collisionPadding && x + contentRect.width <= viewport.width - collisionPadding
	const fitsVertically = y >= collisionPadding && y + contentRect.height <= viewport.height - collisionPadding

	if (fitsHorizontally && fitsVertically) {
		return { x, y }
	}

	return null
}

function getInitialPosition(
	anchorRect: DOMRect | null,
	contentRect: { width: number; height: number },
	preferredPosition: InitialPosition,
	offset: number,
	collisionPadding: number,
): { x: number; y: number } {
	const fallbacks = FALLBACK_POSITIONS[preferredPosition]

	for (const position of fallbacks) {
		const result = calculatePosition(anchorRect, contentRect, position, offset, collisionPadding)
		if (result) {
			return result
		}
	}

	// Last resort: viewport center with clamping
	const viewport = {
		width: window.innerWidth,
		height: window.innerHeight,
	}

	return {
		x: Math.max(
			collisionPadding,
			Math.min((viewport.width - contentRect.width) / 2, viewport.width - contentRect.width - collisionPadding),
		),
		y: Math.max(
			collisionPadding,
			Math.min((viewport.height - contentRect.height) / 2, viewport.height - contentRect.height - collisionPadding),
		),
	}
}

// ============================================================================
// Window Context
// ============================================================================

interface DraggableWindowContextValue {
	windowId: string
	close: () => void
	isPinned: boolean
	setIsPinned: (pinned: boolean) => void
	bringToFront: () => void
	registerDragBar: (element: HTMLElement | null) => void
	zIndex: number
}

const DraggableWindowContext = React.createContext<DraggableWindowContextValue | null>(null)

export function useDraggableWindow() {
	const context = React.useContext(DraggableWindowContext)
	if (!context) {
		throw new Error('useDraggableWindow must be used within a DraggableWindow')
	}
	return context
}

// ============================================================================
// Window Instance
// ============================================================================

interface DraggableWindowInstanceProps {
	window: WindowState
	definition: WindowDefinition
}

function DraggableWindowInstance({ window: windowState, definition }: DraggableWindowInstanceProps) {
	const contentRef = React.useRef<HTMLDivElement | null>(null)
	const dragBarRef = React.useRef<HTMLElement | null>(null)
	const positionRef = React.useRef<{ x: number; y: number } | null>(null)
	const dragStartRef = React.useRef<{ mouseX: number; mouseY: number; elementX: number; elementY: number } | null>(null)
	const isDraggingRef = React.useRef(false)
	const [dragBarNode, setDragBarNode] = React.useState<HTMLElement | null>(null)

	const offset = definition.offset ?? 8
	const collisionPadding = definition.collisionPadding ?? 16
	const initialPosition = definition.initialPosition ?? 'below'

	// Helper to update DOM position directly
	const applyPosition = React.useCallback((pos: { x: number; y: number }) => {
		const content = contentRef.current
		if (!content) return
		content.style.left = `${pos.x}px`
		content.style.top = `${pos.y}px`
		content.style.visibility = 'visible'
		positionRef.current = pos
	}, [])

	// Helper to clamp position to viewport
	const clampToViewport = React.useCallback(() => {
		const content = contentRef.current
		const currentPos = positionRef.current
		if (!content || !currentPos) return

		const contentRect = content.getBoundingClientRect()
		const viewport = {
			width: window.innerWidth,
			height: window.innerHeight,
		}

		const clampedX = Math.max(
			collisionPadding,
			Math.min(currentPos.x, viewport.width - contentRect.width - collisionPadding),
		)
		const clampedY = Math.max(
			collisionPadding,
			Math.min(currentPos.y, viewport.height - contentRect.height - collisionPadding),
		)

		if (clampedX !== currentPos.x || clampedY !== currentPos.y) {
			applyPosition({ x: clampedX, y: clampedY })
		}
	}, [collisionPadding, applyPosition])

	const close = React.useCallback(() => {
		DraggableWindowStore.getState().closeWindow(windowState.id)
	}, [windowState.id])

	const bringToFront = React.useCallback(() => {
		DraggableWindowStore.getState().bringToFront(windowState.id)
	}, [windowState.id])

	const setIsPinned = React.useCallback(
		(pinned: boolean) => {
			DraggableWindowStore.getState().setIsPinned(windowState.id, pinned)
		},
		[windowState.id],
	)

	const registerDragBar = React.useCallback((element: HTMLElement | null) => {
		dragBarRef.current = element
		setDragBarNode(element)
	}, [])

	// Calculate initial position once when content is measured
	React.useLayoutEffect(() => {
		if (positionRef.current !== null) return

		const content = contentRef.current
		if (!content) return

		const contentRect = content.getBoundingClientRect()
		const pos = getInitialPosition(windowState.anchorRect, contentRect, initialPosition, offset, collisionPadding)

		applyPosition(pos)
	}, [windowState.anchorRect, initialPosition, offset, collisionPadding, applyPosition])

	// Handle click outside
	React.useEffect(() => {
		if (windowState.isPinned) return

		const handleClickOutside = (e: MouseEvent) => {
			const content = contentRef.current
			if (!content) return

			const target = e.target as Node
			if (content.contains(target)) {
				return
			}

			close()
		}

		// Delay to avoid closing immediately on the same click that opened
		const timeoutId = setTimeout(() => {
			document.addEventListener('mousedown', handleClickOutside)
		}, 0)

		return () => {
			clearTimeout(timeoutId)
			document.removeEventListener('mousedown', handleClickOutside)
		}
	}, [windowState.isPinned, close])

	// Handle escape key
	React.useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				const content = contentRef.current
				if (content?.contains(document.activeElement) || document.activeElement === content) {
					close()
				}
			}
		}

		document.addEventListener('keydown', handleKeyDown)
		return () => document.removeEventListener('keydown', handleKeyDown)
	}, [close])

	// Keep window in bounds when viewport or content resizes
	React.useEffect(() => {
		const content = contentRef.current
		if (!content) return

		const resizeObserver = new ResizeObserver(clampToViewport)
		resizeObserver.observe(content)

		window.addEventListener('resize', clampToViewport)
		return () => {
			resizeObserver.disconnect()
			window.removeEventListener('resize', clampToViewport)
		}
	}, [clampToViewport])

	// Handle dragging
	React.useEffect(() => {
		const content = contentRef.current
		if (!dragBarNode || !content) return

		const handleMouseDown = (e: MouseEvent) => {
			if (!positionRef.current) return
			if (e.button !== 0) return

			e.preventDefault()
			isDraggingRef.current = true
			content.classList.add('select-none')
			bringToFront()

			dragStartRef.current = {
				mouseX: e.clientX,
				mouseY: e.clientY,
				elementX: positionRef.current.x,
				elementY: positionRef.current.y,
			}
		}

		const handleMouseMove = (e: MouseEvent) => {
			if (!isDraggingRef.current || !dragStartRef.current) return

			const deltaX = e.clientX - dragStartRef.current.mouseX
			const deltaY = e.clientY - dragStartRef.current.mouseY

			applyPosition({
				x: dragStartRef.current.elementX + deltaX,
				y: dragStartRef.current.elementY + deltaY,
			})
		}

		const handleMouseUp = () => {
			if (!isDraggingRef.current) return
			isDraggingRef.current = false
			content.classList.remove('select-none')
			if (dragStartRef.current) {
				setIsPinned(true)
			}
			dragStartRef.current = null
		}

		dragBarNode.addEventListener('mousedown', handleMouseDown)
		document.addEventListener('mousemove', handleMouseMove)
		document.addEventListener('mouseup', handleMouseUp)

		return () => {
			dragBarNode.removeEventListener('mousedown', handleMouseDown)
			document.removeEventListener('mousemove', handleMouseMove)
			document.removeEventListener('mouseup', handleMouseUp)
		}
	}, [
		dragBarNode,
		bringToFront,
		applyPosition,
		setIsPinned,
	])

	const handleMouseDown = React.useCallback(() => {
		bringToFront()
	}, [bringToFront])

	const contextValue = React.useMemo<DraggableWindowContextValue>(
		() => ({
			windowId: windowState.id,
			close,
			isPinned: windowState.isPinned,
			setIsPinned,
			bringToFront,
			registerDragBar,
			zIndex: windowState.zIndex,
		}),
		[windowState.id, windowState.isPinned, windowState.zIndex, close, setIsPinned, bringToFront, registerDragBar],
	)

	const Component = definition.component

	return (
		<DraggableWindowContext.Provider value={contextValue}>
			<div
				ref={contentRef}
				role="dialog"
				tabIndex={-1}
				onMouseDown={handleMouseDown}
				className="fixed rounded-md border bg-popover text-popover-foreground shadow-lg outline-none invisible"
				style={{ zIndex: windowState.zIndex }}
			>
				<Component {...windowState.props} />
			</div>
		</DraggableWindowContext.Provider>
	)
}

// ============================================================================
// Window Outlet (renders all open windows)
// ============================================================================

export function DraggableWindowOutlet() {
	const openWindows = useOpenWindows()
	const definitions = useWindowDefinitions()

	if (openWindows.length === 0) return null

	return createPortal(
		<>
			{openWindows.map((windowState) => {
				const def = definitions.find((d) => d.type === windowState.type)
				if (!def) return null
				return <DraggableWindowInstance key={windowState.id} window={windowState} definition={def} />
			})}
		</>,
		document.body,
	)
}

// ============================================================================
// Window Content Components
// ============================================================================

interface DraggableWindowDragBarProps extends React.HTMLAttributes<HTMLDivElement> {
	ref?: React.Ref<HTMLDivElement>
}

export function DraggableWindowDragBar({ className, ref, ...props }: DraggableWindowDragBarProps) {
	const { registerDragBar } = useDraggableWindow()

	const combinedRef = React.useCallback(
		(node: HTMLDivElement | null) => {
			registerDragBar(node)
			if (typeof ref === 'function') {
				ref(node)
			} else if (ref) {
				ref.current = node
			}
		},
		[registerDragBar, ref],
	)

	return (
		<div
			ref={combinedRef}
			className={cn('flex items-center gap-2 cursor-grab active:cursor-grabbing select-none px-3 py-2 border-b', className)}
			{...props}
		/>
	)
}

interface DraggableWindowTitleProps extends React.HTMLAttributes<HTMLHeadingElement> {
	ref?: React.Ref<HTMLHeadingElement>
}

export function DraggableWindowTitle({ className, ref, ...props }: DraggableWindowTitleProps) {
	return <h3 ref={ref} className={cn('flex-1 text-sm font-medium', className)} {...props} />
}

interface DraggableWindowPinToggleProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
	ref?: React.Ref<HTMLButtonElement>
}

export function DraggableWindowPinToggle({ className, ref, ...props }: DraggableWindowPinToggleProps) {
	const { isPinned, setIsPinned } = useDraggableWindow()

	return (
		<button
			ref={ref}
			type="button"
			onClick={() => setIsPinned(!isPinned)}
			className={cn(
				'rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2',
				className,
			)}
			aria-label={isPinned ? 'Unpin window' : 'Pin window'}
			{...props}
		>
			{isPinned ? <DrawingPinFilledIcon className="h-4 w-4" /> : <DrawingPinIcon className="h-4 w-4" />}
		</button>
	)
}

interface DraggableWindowCloseProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
	ref?: React.Ref<HTMLButtonElement>
}

export function DraggableWindowClose({ className, onClick, ref, ...props }: DraggableWindowCloseProps) {
	const { close } = useDraggableWindow()

	const handleClick = React.useCallback(
		(e: React.MouseEvent<HTMLButtonElement>) => {
			close()
			onClick?.(e)
		},
		[close, onClick],
	)

	return (
		<button
			ref={ref}
			type="button"
			onClick={handleClick}
			className={cn(
				'rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2',
				className,
			)}
			aria-label="Close window"
			{...props}
		>
			<Cross2Icon className="h-4 w-4" />
		</button>
	)
}

// ============================================================================
// Open Window Interaction (with preloading support)
// ============================================================================

interface OpenWindowInteractionProps<TProps> {
	windowId: string
	windowProps: TProps
	preload: 'intent' | 'viewport' | 'render' | 'none'
	intentDelay?: number
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	render: React.FunctionComponent<any>
	ref?: React.Ref<Element>
	[extra: string]: unknown
}

export function OpenWindowInteraction<TProps>(
	_props: OpenWindowInteractionProps<TProps>,
) {
	const eltRef = React.useRef<Element | null>(null)
	const [props, otherEltProps] = Obj.partition(
		_props,
		'ref',
		'windowId',
		'windowProps',
		'preload',
		'intentDelay',
		'render',
	)

	const isLoaded = Zus.useStore(DraggableWindowStore, (state) => {
		const def = state.definitions.find((d) => d.type === props.windowId)
		if (!def) return false
		const instanceId = def.getId(props.windowProps)
		const entry = state.loaderCache.find((e) => e.key?.windowId === instanceId)
		return !!entry?.data
	})

	const openWindow = React.useCallback((anchor?: Element | null) => {
		DraggableWindowStore.getState().openWindow(props.windowId, props.windowProps, anchor as HTMLElement | null)
	}, [props.windowId, props.windowProps])

	const preloadWindow = React.useCallback(() => {
		if (isLoaded) return
		DraggableWindowStore.getState().preloadWindow(props.windowId, props.windowProps)
	}, [props.windowId, props.windowProps, isLoaded])

	const [intentTimeout, setIntentTimeout] = React.useState<NodeJS.Timeout | null>(null)

	// Preload on render
	React.useEffect(() => {
		if (props.preload === 'render') {
			preloadWindow()
		}
	}, [props.preload, preloadWindow])

	// Preload on viewport intersection
	React.useEffect(() => {
		if (props.preload !== 'viewport' || !eltRef.current || isLoaded) return

		const observer = new IntersectionObserver(
			(entries) => {
				entries.forEach((entry) => {
					if (entry.isIntersecting) {
						preloadWindow()
					}
				})
			},
			{ threshold: 0.1 },
		)

		observer.observe(eltRef.current)

		return () => {
			observer.disconnect()
		}
	}, [props.preload, preloadWindow, isLoaded])

	const handleMouseEnter = () => {
		if (props.preload === 'intent' && !isLoaded) {
			const delay = props.intentDelay ?? 150
			const timeout = setTimeout(() => {
				preloadWindow()
			}, delay)
			setIntentTimeout(timeout)
		}
	}

	const handleMouseLeave = () => {
		if (intentTimeout) {
			clearTimeout(intentTimeout)
			setIntentTimeout(null)
		}
	}

	const handleClick = () => {
		openWindow(eltRef.current)
	}

	const childProps = {
		...otherEltProps,
		ref: eltRef,
		onClick: handleClick,
		onMouseEnter: handleMouseEnter,
		onMouseLeave: handleMouseLeave,
	} as any

	return <props.render {...childProps} />
}
