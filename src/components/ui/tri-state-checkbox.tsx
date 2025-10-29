import { CheckIcon } from '@radix-ui/react-icons'
import { X } from 'lucide-react'
import * as React from 'react'

import { cn } from '@/lib/utils'

const STATES = ['disabled', 'regular', 'inverted'] as const
export type TriState = typeof STATES[number]

export interface TriStateCheckboxProps extends Omit<React.HTMLAttributes<HTMLButtonElement>, 'onChange'> {
	checked?: TriState
	onCheckedChange?: (checked: TriState) => void
	disabled?: boolean
}

const TriStateCheckbox = React.forwardRef<HTMLButtonElement, TriStateCheckboxProps>(
	({ className, checked = 'disabled', onCheckedChange, disabled = false, ...props }, ref) => {
		const handleClick = () => {
			if (disabled) return
			const nextState = STATES[(STATES.indexOf(checked) + 1) % STATES.length]
			onCheckedChange?.(nextState)
		}

		const handleKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
			if (disabled) return
			if (e.key === ' ' || e.key === 'Enter') {
				e.preventDefault()
				handleClick()
			}
		}

		return (
			<button
				ref={ref}
				type="button"
				role="checkbox"
				aria-checked={checked === 'regular' ? 'true' : checked === 'inverted' ? 'mixed' : 'false'}
				aria-disabled={disabled}
				disabled={disabled}
				onClick={handleClick}
				onKeyDown={handleKeyDown}
				className={cn(
					'peer h-4 w-4 shrink-0 rounded-sm border border-primary shadow focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 transition-colors',
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
			</button>
		)
	},
)

TriStateCheckbox.displayName = 'TriStateCheckbox'

export interface TriStateCheckboxDisplayProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'onChange'> {
	checked?: TriState
}

const TriStateCheckboxDisplay = React.forwardRef<HTMLDivElement, TriStateCheckboxDisplayProps>(
	({ className, checked = 'disabled', ...props }, ref) => {
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
	},
)

TriStateCheckboxDisplay.displayName = 'TriStateCheckboxDisplay'

export { TriStateCheckbox, TriStateCheckboxDisplay }
