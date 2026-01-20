import { Cross2Icon, DrawingPinFilledIcon, DrawingPinIcon } from '@radix-ui/react-icons'
import * as React from 'react'
import { createPortal } from 'react-dom'
import * as Zus from 'zustand'

import { cn } from '@/lib/utils'
import { DraggableWindowStore, type InitialPosition, type OpenWindowState, useOpenWindows, useWindowDefinitions, type WindowDefinition } from '@/systems/draggable-window.client'

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
	window: OpenWindowState
	definition: WindowDefinition
}

function DraggableWindowInstance({ window: windowState, definition }: DraggableWindowInstanceProps) {
	const contentRef = React.useRef<HTMLDivElement | null>(null)
	const dragBarRef = React.useRef<HTMLElement | null>(null)
	const [isDragging, setIsDragging] = React.useState(false)
	const dragStartRef = React.useRef<{ mouseX: number; mouseY: number; elementX: number; elementY: number } | null>(null)

	const offset = definition.offset ?? 8
	const collisionPadding = definition.collisionPadding ?? 16
	const initialPosition = definition.initialPosition ?? 'below'

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
	}, [])

	// Calculate initial position once when content is measured
	React.useLayoutEffect(() => {
		if (windowState.position !== null) return

		const content = contentRef.current
		if (!content) return

		const contentRect = content.getBoundingClientRect()
		const pos = getInitialPosition(windowState.anchorRect, contentRect, initialPosition, offset, collisionPadding)

		DraggableWindowStore.getState().updatePosition(windowState.id, pos)
	}, [windowState.position, windowState.anchorRect, windowState.id, initialPosition, offset, collisionPadding])

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

	// Handle dragging
	React.useEffect(() => {
		const dragBar = dragBarRef.current
		if (!dragBar) return

		const handleMouseDown = (e: MouseEvent) => {
			if (!windowState.position) return
			if (e.button !== 0) return

			e.preventDefault()
			setIsDragging(true)
			bringToFront()

			dragStartRef.current = {
				mouseX: e.clientX,
				mouseY: e.clientY,
				elementX: windowState.position.x,
				elementY: windowState.position.y,
			}
		}

		dragBar.addEventListener('mousedown', handleMouseDown)
		return () => dragBar.removeEventListener('mousedown', handleMouseDown)
	}, [windowState.position, bringToFront])

	React.useEffect(() => {
		if (!isDragging) return

		const handleMouseMove = (e: MouseEvent) => {
			if (!dragStartRef.current) return

			const deltaX = e.clientX - dragStartRef.current.mouseX
			const deltaY = e.clientY - dragStartRef.current.mouseY

			DraggableWindowStore.getState().updatePosition(windowState.id, {
				x: dragStartRef.current.elementX + deltaX,
				y: dragStartRef.current.elementY + deltaY,
			})
		}

		const handleMouseUp = () => {
			setIsDragging(false)
			dragStartRef.current = null
		}

		document.addEventListener('mousemove', handleMouseMove)
		document.addEventListener('mouseup', handleMouseUp)

		return () => {
			document.removeEventListener('mousemove', handleMouseMove)
			document.removeEventListener('mouseup', handleMouseUp)
		}
	}, [isDragging, windowState.id])

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
		}),
		[windowState.id, windowState.isPinned, close, setIsPinned, bringToFront, registerDragBar],
	)

	const Component = definition.component

	return (
		<DraggableWindowContext.Provider value={contextValue}>
			<div
				ref={contentRef}
				role="dialog"
				tabIndex={-1}
				onMouseDown={handleMouseDown}
				className={cn(
					'fixed rounded-md border bg-popover text-popover-foreground shadow-lg outline-none',
					isDragging && 'select-none',
					!windowState.position && 'invisible',
				)}
				style={{
					zIndex: windowState.zIndex,
					left: windowState.position?.x ?? 0,
					top: windowState.position?.y ?? 0,
				}}
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
				const def = definitions.find((d) => d.type === windowState.id)
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

interface DraggableWindowDragBarProps extends React.HTMLAttributes<HTMLDivElement> {}

export const DraggableWindowDragBar = React.forwardRef<HTMLDivElement, DraggableWindowDragBarProps>(
	({ className, ...props }, forwardedRef) => {
		const { registerDragBar } = useDraggableWindow()

		const ref = React.useCallback(
			(node: HTMLDivElement | null) => {
				registerDragBar(node)
				if (typeof forwardedRef === 'function') {
					forwardedRef(node)
				} else if (forwardedRef) {
					forwardedRef.current = node
				}
			},
			[registerDragBar, forwardedRef],
		)

		return (
			<div
				ref={ref}
				className={cn('flex items-center gap-2 cursor-grab active:cursor-grabbing select-none px-3 py-2 border-b', className)}
				{...props}
			/>
		)
	},
)
DraggableWindowDragBar.displayName = 'DraggableWindowDragBar'

interface DraggableWindowTitleProps extends React.HTMLAttributes<HTMLHeadingElement> {}

export const DraggableWindowTitle = React.forwardRef<HTMLHeadingElement, DraggableWindowTitleProps>(
	({ className, ...props }, forwardedRef) => {
		return <h3 ref={forwardedRef} className={cn('flex-1 text-sm font-medium', className)} {...props} />
	},
)
DraggableWindowTitle.displayName = 'DraggableWindowTitle'

interface DraggableWindowPinToggleProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {}

export const DraggableWindowPinToggle = React.forwardRef<HTMLButtonElement, DraggableWindowPinToggleProps>(
	({ className, ...props }, forwardedRef) => {
		const { isPinned, setIsPinned } = useDraggableWindow()

		return (
			<button
				ref={forwardedRef}
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
	},
)
DraggableWindowPinToggle.displayName = 'DraggableWindowPinToggle'

interface DraggableWindowCloseProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {}

export const DraggableWindowClose = React.forwardRef<HTMLButtonElement, DraggableWindowCloseProps>(
	({ className, onClick, ...props }, forwardedRef) => {
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
				ref={forwardedRef}
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
	},
)
DraggableWindowClose.displayName = 'DraggableWindowClose'
