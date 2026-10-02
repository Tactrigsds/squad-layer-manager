import { CheckIcon } from '@radix-ui/react-icons'
import * as React from 'react'

import { cn } from '@/lib/utils'

type CheckedState = boolean | 'indeterminate'

type CheckboxProps = Omit<React.ComponentPropsWithoutRef<'button'>, 'value' | 'defaultChecked' | 'onChange'> & {
	checked?: CheckedState
	defaultChecked?: CheckedState
	// an indeterminate box checks on click, so this only ever receives a boolean
	onCheckedChange?: (checked: boolean) => void
	required?: boolean
}

// Radix's Checkbox markup, aria and keyboard handling, without its provider, presence and hidden form input: those
// are eight fibers and two renders per mount, in tables that mount one per row. The hidden input only matters inside
// a native <form>, and the app submits none.
const Checkbox = React.forwardRef<HTMLButtonElement, CheckboxProps>(
	({ className, checked, defaultChecked, onCheckedChange, required, disabled, onClick, onKeyDown, ...props }, ref) => {
		const [uncontrolled, setUncontrolled] = React.useState<CheckedState>(defaultChecked ?? false)
		const state = checked ?? uncontrolled
		const dataState = state === 'indeterminate' ? 'indeterminate' : state ? 'checked' : 'unchecked'
		return (
			<button
				type="button"
				role="checkbox"
				aria-checked={state === 'indeterminate' ? 'mixed' : state}
				aria-required={required}
				data-state={dataState}
				data-disabled={disabled ? '' : undefined}
				disabled={disabled}
				{...props}
				ref={ref}
				className={cn('fd-cbx peer', className)}
				onKeyDown={(e) => {
					onKeyDown?.(e)
					// WAI-ARIA checkboxes toggle on Space only
					if (!e.defaultPrevented && e.key === 'Enter') e.preventDefault()
				}}
				onClick={(e) => {
					onClick?.(e)
					if (e.defaultPrevented) return
					const next = state === 'indeterminate' ? true : !state
					if (checked === undefined) setUncontrolled(next)
					onCheckedChange?.(next)
				}}
			>
				{state !== false && (
					<span
						data-state={dataState}
						data-disabled={disabled ? '' : undefined}
						className="pointer-events-none flex items-center justify-center text-current"
					>
						<CheckIcon />
					</span>
				)}
			</button>
		)
	},
)
Checkbox.displayName = 'Checkbox'

export { Checkbox }
