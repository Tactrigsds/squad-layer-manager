// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import * as React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useFollowTooltip } from './use-follow-tooltip.ts'

const LEAVE_GRACE = 150

function Harness(props: { pinnable?: boolean; delayMs?: number }) {
	const tooltip = useFollowTooltip({ pinnable: props.pinnable ?? true, delayMs: props.delayMs })
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

// The skip window is shared by every trigger and outlives a test, so each test starts a clear minute after the
// last one ended rather than restarting the clock on top of it.
let clock = Date.UTC(2024, 0, 1)

beforeEach(() => {
	clock += 60_000
	vi.useFakeTimers()
	vi.setSystemTime(clock)
})

afterEach(() => {
	cleanup()
	vi.useRealTimers()
})

describe('useFollowTooltip', () => {
	beforeEach(() => {
		render(<Harness />)
	})

	it('opens as soon as the pointer enters and closes as soon as it leaves', () => {
		hoverIn()
		expect(isOpen()).toBe(true)
		expect(isPinned()).toBe(false)

		hoverOut()
		expect(isOpen()).toBe(false)
	})

	it('pins on click, and a pinned tooltip survives leaving the trigger for the content', () => {
		hoverIn()
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
		clickTrigger()
		clickTrigger()
		expect(isOpen()).toBe(false)

		// still hovering the trigger: nothing should bring it back
		hoverIn()
		expect(isOpen()).toBe(false)

		hoverOut()
		hoverIn()
		expect(isOpen()).toBe(true)
	})

	it('opens pinned on the first tap and closes on the second, ignoring hover entirely', () => {
		fireEvent.pointerEnter(trigger(), touch)
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

	it('closes a hovered tooltip on escape, and reopens on a fresh hover', () => {
		hoverIn()
		fireEvent.keyDown(document, { key: 'Escape' })
		expect(isOpen()).toBe(false)

		hoverOut()
		hoverIn()
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

describe('useFollowTooltip, not pinnable', () => {
	beforeEach(() => {
		render(<Harness pinnable={false} />)
	})

	it('still follows the pointer on hover, but never becomes reachable', () => {
		hoverIn()
		expect(isOpen()).toBe(true)
		expect(isPinned()).toBe(false)
	})

	it('dismisses on click rather than freezing, and will not reopen until the pointer leaves', () => {
		hoverIn()
		clickTrigger()
		expect(isOpen()).toBe(false)

		hoverIn()
		expect(isOpen()).toBe(false)

		hoverOut()
		hoverIn()
		expect(isOpen()).toBe(true)
	})

	// a tap is the only way to open one at all, so touch keeps the frozen state even here
	it('opens on the first tap and closes on the second, without becoming reachable', () => {
		clickTrigger(touch)
		expect(isOpen()).toBe(true)
		expect(isPinned()).toBe(false)

		clickTrigger(touch)
		expect(isOpen()).toBe(false)
	})

	it('still opens on keyboard focus', () => {
		fireEvent.focus(trigger())
		expect(isOpen()).toBe(true)
		expect(isPinned()).toBe(false)
		fireEvent.blur(trigger())
		expect(isOpen()).toBe(false)
	})
})

const DELAY = 500
const SKIP_DELAY = 300

describe('useFollowTooltip, with a hover delay', () => {
	beforeEach(() => {
		render(<Harness delayMs={DELAY} />)
	})

	it('holds the tooltip back until the pointer has settled', () => {
		hoverIn()
		expect(isOpen()).toBe(false)

		advance(DELAY - 50)
		expect(isOpen()).toBe(false)

		advance(50)
		expect(isOpen()).toBe(true)
	})

	it('opens nothing for a pointer that only passes over on its way somewhere else', () => {
		hoverIn()
		advance(DELAY - 100)
		hoverOut()
		advance(DELAY)
		expect(isOpen()).toBe(false)
	})

	// a click, a tap and a keyboard focus are all deliberate, so none of them waits
	it('skips the delay for a click and for keyboard focus', () => {
		clickTrigger()
		expect(isPinned()).toBe(true)

		close()
		fireEvent.focus(trigger())
		expect(isOpen()).toBe(true)
	})

	it('opens a neighbouring tip at once while the skip window is still open', () => {
		hoverIn()
		advance(DELAY)
		expect(isOpen()).toBe(true)

		hoverOut()
		expect(isOpen()).toBe(false)

		// straight back in, inside the skip window: no second wait
		advance(SKIP_DELAY - 100)
		hoverIn()
		expect(isOpen()).toBe(true)
	})

	it('waits again once the skip window has lapsed', () => {
		hoverIn()
		advance(DELAY)
		hoverOut()

		advance(SKIP_DELAY + 50)
		hoverIn()
		expect(isOpen()).toBe(false)
		advance(DELAY)
		expect(isOpen()).toBe(true)
	})
})

function close() {
	fireEvent.keyDown(document, { key: 'Escape' })
	fireEvent.pointerLeave(trigger(), mouse)
}
