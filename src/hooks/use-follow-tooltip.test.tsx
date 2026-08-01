// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import * as React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useFollowTooltip } from './use-follow-tooltip.ts'

const OPEN_DELAY = 250
const LEAVE_GRACE = 150

function Harness() {
	const tooltip = useFollowTooltip()
	return (
		<div>
			<button type="button" data-testid="trigger" {...tooltip.triggerProps}>
				indicators
			</button>
			<button type="button" data-testid="outside">
				outside
			</button>
			{tooltip.open && (
				<div
					data-testid="content"
					data-interactive={tooltip.contentProps.interactive}
					ref={tooltip.contentProps.nodeRef}
					onPointerEnter={tooltip.contentProps.onPointerEnter}
					onPointerLeave={tooltip.contentProps.onPointerLeave}
				>
					body
				</div>
			)}
		</div>
	)
}

const trigger = () => screen.getByTestId('trigger')
const content = () => screen.queryByTestId('content')
const isOpen = () => content() !== null
const isPinned = () => content()?.getAttribute('data-interactive') === 'true'

const advance = (ms: number) => act(() => void vi.advanceTimersByTime(ms))

// fireEvent's pointer helpers default to an empty PointerEvent, whose pointerType is '' rather than 'mouse'
const mouse = { pointerType: 'mouse' }
const touch = { pointerType: 'touch' }

function hoverIn() {
	fireEvent.pointerEnter(trigger(), mouse)
}
function hoverOut() {
	fireEvent.pointerLeave(trigger(), mouse)
}
// a real click is a pointer press, the focus it causes, then the click
function clickTrigger(opts: { pointerType: string } = mouse) {
	fireEvent.pointerDown(trigger(), opts)
	fireEvent.focus(trigger())
	fireEvent.click(trigger(), { detail: 1, clientX: 40, clientY: 40 })
}

beforeEach(() => {
	vi.useFakeTimers()
	render(<Harness />)
})

afterEach(() => {
	cleanup()
	vi.useRealTimers()
})

describe('useFollowTooltip', () => {
	it('opens on hover after the delay and closes as soon as the pointer leaves', () => {
		hoverIn()
		expect(isOpen()).toBe(false)
		advance(OPEN_DELAY)
		expect(isOpen()).toBe(true)
		expect(isPinned()).toBe(false)

		hoverOut()
		expect(isOpen()).toBe(false)
	})

	it('does not open when the pointer leaves before the delay elapses', () => {
		hoverIn()
		advance(OPEN_DELAY - 50)
		hoverOut()
		advance(OPEN_DELAY)
		expect(isOpen()).toBe(false)
	})

	it('pins on click, and a pinned tooltip survives leaving the trigger for the content', () => {
		hoverIn()
		advance(OPEN_DELAY)
		clickTrigger()
		expect(isPinned()).toBe(true)

		// crossing the gap leaves the trigger before the content is reached
		hoverOut()
		advance(LEAVE_GRACE - 50)
		fireEvent.pointerEnter(content()!, mouse)
		advance(LEAVE_GRACE)
		expect(isOpen()).toBe(true)
	})

	it('closes a pinned tooltip once the pointer has left both the trigger and the content', () => {
		clickTrigger()
		hoverOut()
		fireEvent.pointerEnter(content()!, mouse)
		fireEvent.pointerLeave(content()!, mouse)
		expect(isOpen()).toBe(true)
		advance(LEAVE_GRACE)
		expect(isOpen()).toBe(false)
	})

	it('closes on a second click and will not reopen on hover until the pointer leaves the trigger', () => {
		hoverIn()
		advance(OPEN_DELAY)
		clickTrigger()
		clickTrigger()
		expect(isOpen()).toBe(false)

		// still hovering the trigger: nothing should bring it back
		hoverIn()
		advance(OPEN_DELAY * 2)
		expect(isOpen()).toBe(false)

		hoverOut()
		hoverIn()
		advance(OPEN_DELAY)
		expect(isOpen()).toBe(true)
	})

	it('opens pinned on the first tap and closes on the second, ignoring hover entirely', () => {
		fireEvent.pointerEnter(trigger(), touch)
		advance(OPEN_DELAY)
		expect(isOpen()).toBe(false)

		clickTrigger(touch)
		expect(isPinned()).toBe(true)

		// a tap synthesises a leave on release, which must not close it
		fireEvent.pointerLeave(trigger(), touch)
		advance(LEAVE_GRACE)
		expect(isOpen()).toBe(true)

		clickTrigger(touch)
		expect(isOpen()).toBe(false)
	})

	it('closes a pinned tooltip when something outside is pressed', () => {
		clickTrigger(touch)
		expect(isOpen()).toBe(true)
		fireEvent.pointerDown(screen.getByTestId('outside'), touch)
		expect(isOpen()).toBe(false)
	})

	it('stays open when the content itself is pressed', () => {
		clickTrigger()
		fireEvent.pointerDown(content()!, mouse)
		expect(isOpen()).toBe(true)
	})

	it('closes a hovered tooltip on escape, and does not reopen until the pointer leaves', () => {
		hoverIn()
		advance(OPEN_DELAY)
		fireEvent.keyDown(document, { key: 'Escape' })
		expect(isOpen()).toBe(false)

		advance(OPEN_DELAY * 2)
		expect(isOpen()).toBe(false)

		hoverOut()
		hoverIn()
		advance(OPEN_DELAY)
		expect(isOpen()).toBe(true)
	})

	it('opens pinned on keyboard focus and closes on blur and on escape', () => {
		fireEvent.focus(trigger())
		expect(isPinned()).toBe(true)
		fireEvent.keyDown(document, { key: 'Escape' })
		expect(isOpen()).toBe(false)

		fireEvent.focus(trigger())
		expect(isOpen()).toBe(true)
		fireEvent.blur(trigger())
		expect(isOpen()).toBe(false)
	})

	it('does not treat the focus caused by a click as a keyboard focus', () => {
		clickTrigger()
		expect(isPinned()).toBe(true)
		// blur belongs to the click's focus, not a keyboard one, so it must not close the tooltip
		fireEvent.blur(trigger())
		expect(isOpen()).toBe(true)
	})
})
