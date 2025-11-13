import { CheckIcon } from '@radix-ui/react-icons'
import { X } from 'lucide-react'
import * as React from 'react'

import { Button, type ButtonProps } from '@/components/ui/button'
import { cn } from '@/lib/utils'

const STATES = ['disabled', 'regular', 'inverted'] as const
export type TriState = typeof STATES[number]

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
	const defaultSize = children ? 'sm' : 'icon'
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
			className={className}
			title="Ctrl+Click to invert"
			{...props}
		>
			{children}
			<div
				className={cn(
					'h-4 w-4 shrink-0 rounded-sm border border-primary shadow transition-colors',
					checked === 'regular' && 'bg-primary text-primary-foreground',
					checked === 'inverted' && 'bg-destructive text-destructive-foreground border-destructive',
					checked === 'disabled' && 'bg-background',
				)}
			>
				<span className="flex items-center justify-center">
					{checked === 'regular' && <CheckIcon className="h-4 w-4" />}
					{checked === 'inverted' && <X className="h-3.5 w-3.5 stroke-[3]" />}
					{/* Invisible icon to maintain consistent sizing */}
					{checked === 'disabled' && <CheckIcon className="h-4 w-4 invisible" />}
				</span>
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
			className={cn(
				'h-4 w-4 shrink-0 rounded-sm border border-primary shadow transition-colors',
				checked === 'regular' && 'bg-primary text-primary-foreground',
				checked === 'inverted' && 'bg-destructive text-destructive-foreground border-destructive',
				checked === 'disabled' && 'bg-background',
				className,
			)}
			{...props}
		>
			<span className="flex items-center justify-center">
				{checked === 'regular' && <CheckIcon className="h-4 w-4" />}
				{checked === 'inverted' && <X className="h-3.5 w-3.5 stroke-[3]" />}
				{/* Invisible icon to maintain consistent sizing */}
				{checked === 'disabled' && <CheckIcon className="h-4 w-4 invisible" />}
			</span>
		</div>
	)
}
TriStateCheckboxDisplay.displayName = 'TriStateCheckboxDisplay'

export { TriStateCheckbox, TriStateCheckboxDisplay }
