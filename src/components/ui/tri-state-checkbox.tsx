import { CheckIcon } from '@radix-ui/react-icons'
import { X } from 'lucide-react'
import * as React from 'react'

import { Button, type ButtonProps } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import * as UI_Msgs from '@/messages/ui.messages'
import { tr } from '@/systems/messages.client'

const STATES = ['disabled', 'regular', 'inverted'] as const
export type TriState = (typeof STATES)[number]

export interface TriStateCheckboxProps extends Omit<ButtonProps, 'onChange' | 'onClick' | 'onTouchEnd'> {
	checked?: TriState
	onCheckedChange?: (checked: TriState) => void
	children?: React.ReactNode
}

const TriStateCheckbox = ({
	className,
	checked = 'disabled',
	onCheckedChange,
	disabled = false,
	children,
	variant = 'ghost',
	size,
	ref,
	...props
}: TriStateCheckboxProps & { ref?: React.Ref<HTMLButtonElement> }) => {
	// Default size based on whether children are provided
	const defaultSize = children ? 'sm' : 'icon-sm'
	const buttonSize = size ?? defaultSize

	const cycleState = (currentState: TriState, skipInverted: boolean) => {
		const states = ['disabled', 'regular'] as TriState[]
		if (!skipInverted) states.push('inverted')
		const currentIndex = states.indexOf(currentState)
		const nextIndex = (currentIndex + 1) % states.length
		return states[nextIndex]
	}

	const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
		if (disabled) return

		if (e.ctrlKey || e.metaKey) {
			// Ctrl+click sets inverted
			onCheckedChange?.('inverted')
		} else {
			// Regular click cycles between disabled and regular
			const nextState = cycleState(checked, true)
			onCheckedChange?.(nextState)
		}
	}

	const handleTouchEnd = (e: React.TouchEvent<HTMLButtonElement>) => {
		if (disabled) return

		// Prevent onClick from firing
		e.preventDefault()

		// On touch, cycle through all states (don't skip inverted)
		const nextState = cycleState(checked, false)
		onCheckedChange?.(nextState)
	}

	return (
		<Button
			ref={ref}
			type="button"
			role="checkbox"
			aria-checked={checked === 'regular' ? 'true' : checked === 'inverted' ? 'mixed' : 'false'}
			aria-disabled={disabled}
			disabled={disabled}
			onClick={handleClick}
			onTouchEnd={handleTouchEnd}
			variant={variant}
			size={buttonSize}
			className={cn('gap-1.5 font-normal', children && 'flex-row-reverse', className)}
			title={tr.text(UI_Msgs.invertHint())}
			{...props}
		>
			{children}
			<div className={cn('fd-cbx', checked === 'regular' && 'fd-cbx-on', checked === 'inverted' && 'fd-cbx-x fd-cbx-on')}>
				{checked === 'regular' && <CheckIcon />}
				{checked === 'inverted' && <X className="stroke-3" />}
			</div>
		</Button>
	)
}

TriStateCheckbox.displayName = 'TriStateCheckbox'

export interface TriStateCheckboxDisplayProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'onChange'> {
	state?: TriState
}

const TriStateCheckboxDisplay = ({
	className,
	state: checked = 'disabled',
	ref,
	...props
}: TriStateCheckboxDisplayProps & { ref?: React.Ref<HTMLDivElement> }) => {
	return (
		<div
			ref={ref}
			role="img"
			aria-label={checked === 'regular' ? 'checked' : checked === 'inverted' ? 'inverted' : 'disabled'}
			className={cn('fd-cbx', checked === 'regular' && 'fd-cbx-on', checked === 'inverted' && 'fd-cbx-x fd-cbx-on', className)}
			{...props}
		>
			{checked === 'regular' && <CheckIcon />}
			{checked === 'inverted' && <X className="stroke-3" />}
		</div>
	)
}
TriStateCheckboxDisplay.displayName = 'TriStateCheckboxDisplay'

export { TriStateCheckbox, TriStateCheckboxDisplay }
