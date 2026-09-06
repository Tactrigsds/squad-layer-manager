// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import * as React from 'react'
import { afterEach, describe, expect, it } from 'vitest'

import { Tooltip, TooltipContent, TooltipTrigger } from './tooltip.tsx'

afterEach(cleanup)

// A native title is inherited by every descendant, and the browser draws it over a custom tooltip. A trigger
// therefore has to declare it carries no advisory text of its own -- unless it deliberately does.
describe('TooltipTrigger and the native title', () => {
	it('empties an inherited title, so the browser draws nothing over the tooltip', () => {
		render(
			<div title="row hint">
				<Tooltip>
					<TooltipTrigger asChild>
						<span data-testid="trigger">1.24</span>
					</TooltipTrigger>
					<TooltipContent>the real tip</TooltipContent>
				</Tooltip>
			</div>,
		)
		expect(screen.getByTestId('trigger').getAttribute('title')).toBe('')
	})

	it('leaves a title the trigger set itself, which is its own hint rather than a leak from above', () => {
		render(
			<div title="row hint">
				<Tooltip>
					<TooltipTrigger asChild>
						<button type="button" data-testid="trigger" title="Copy steam id" />
					</TooltipTrigger>
					<TooltipContent>the real tip</TooltipContent>
				</Tooltip>
			</div>,
		)
		expect(screen.getByTestId('trigger').getAttribute('title')).toBe('Copy steam id')
	})
})
