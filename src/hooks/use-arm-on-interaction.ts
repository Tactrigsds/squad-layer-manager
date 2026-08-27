import React from 'react'
import { flushSync } from 'react-dom'

export type ArmedBy = 'pointer' | 'focus' | null

export type ArmProps = {
	onPointerEnter: React.PointerEventHandler
	onClick: React.MouseEventHandler
	onFocus: React.FocusEventHandler
}

/**
 * Holds back an overlay's machinery until the user first interacts with its trigger.
 *
 * A radix root costs a provider, a state and a handful of listeners. That is free once and ruinous across a long
 * list that hangs one off every row for an interaction almost none of them will ever see.
 *
 * Nothing arms on a press. Swapping the placeholder for the real thing remounts the subtree under it, so a press
 * that armed would lose the click it was going to become, and a trigger can wrap a button. A mouse enters an
 * element long before it clicks, which is the gap this uses. Touch has no hover, so it arms on the click instead,
 * after that click has already been delivered: the overlay opens on the second tap rather than eating the first.
 *
 * The swap is flushed synchronously for the same reason. Pointerenter is a continuous-priority event, so react is
 * free to commit the swap whenever it likes -- including between a mousedown and the mouseup that was going to
 * complete it, which produces no click at all. Flushing inside the handler puts the whole remount before any
 * further input can arrive.
 */
export function useArmOnInteraction(force = false): [armed: boolean, armProps: ArmProps, armedBy: ArmedBy] {
	const [armedBy, setArmedBy] = React.useState<ArmedBy>(null)
	// whichever came first is what gets replayed, so later interactions must not overwrite it
	const arm = React.useCallback((by: NonNullable<ArmedBy>) => flushSync(() => setArmedBy((current) => current ?? by)), [])
	const armPointer = React.useCallback((event: React.PointerEvent) => event.pointerType !== 'touch' && arm('pointer'), [arm])
	const armTouch = React.useCallback(() => arm('pointer'), [arm])
	const armFocus = React.useCallback(() => arm('focus'), [arm])
	const armProps = React.useMemo(
		() => ({ onPointerEnter: armPointer, onClick: armTouch, onFocus: armFocus }),
		[armPointer, armTouch, armFocus],
	)
	return [armedBy !== null || force, armProps, armedBy]
}

/**
 * Puts focus back on the real trigger once it replaces the placeholder.
 *
 * Swapping the two replaces the dom node, and focus goes with the node it was on, which would otherwise strand a
 * keyboard user on the body. It is deliberately the only interaction replayed. Synthesizing the pointer half is
 * what it looks like it needs -- radix opens a tooltip on pointermove, so a pointer that arrives and stops dead on
 * the boundary pixel arms without opening anything -- but a node that appears under a stationary pointer gets no
 * pointerenter from the browser, so it gets no pointerleave either, and a tooltip opened by a synthetic move never
 * closes. Letting real pointer events do the opening keeps radix's idea of the pointer and the browser's the same.
 */
export function useReplayArming<T extends HTMLElement>(armedBy: ArmedBy, forwarded: React.Ref<T> | undefined) {
	const node = React.useRef<T | null>(null)
	const replayed = React.useRef(false)
	// the sanctioned way to write through a forwarded ref, rather than composing one by hand
	React.useImperativeHandle(forwarded, () => node.current as T, [])

	React.useLayoutEffect(() => {
		if (armedBy !== 'focus' || replayed.current) return
		const elt = node.current
		if (!elt) return
		replayed.current = true

		// not synchronously: discarding the placeholder queues a blur, and radix closes a tooltip on blur, so
		// refocusing before that lands opens one and immediately loses it again
		const frame = requestAnimationFrame(() => elt.isConnected && elt.focus())
		return () => cancelAnimationFrame(frame)
	}, [armedBy])

	return node
}

export function composeArm<E extends React.SyntheticEvent>(
	own: ((event: E) => void) | undefined,
	arm: (event: E) => void,
): (event: E) => void {
	return (event) => {
		own?.(event)
		arm(event)
	}
}
