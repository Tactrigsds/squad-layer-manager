import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'
import * as React from 'react'

import { SubmitChordKbd } from '@/components/ui/kbd'
import { cn } from '@/lib/utils'
import * as SubmitChordClient from '@/systems/submit-chord.client'

// One orange per surface: `primary` is the single action the surface exists for, everything else is the raised
// grey. `outline` and `secondary` are kept as aliases of the grey so older call sites need no change.
const buttonVariants = cva('fd-btn', {
	variants: {
		variant: {
			default: '',
			primary: 'fd-btn-pri',
			ok: 'fd-btn-ok',
			destructive: 'fd-btn-dng',
			outline: '',
			secondary: '',
			ghost: 'fd-btn-ghost',
			link: 'fd-btn-link',
		},
		size: {
			default: '',
			sm: 'fd-btn-sm',
			lg: 'px-4',
			icon: 'fd-btn-ico',
			'icon-sm': 'fd-btn-ico fd-btn-sm',
		},
	},
	defaultVariants: {
		variant: 'default',
		size: 'default',
	},
})

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
	asChild?: boolean
	// makes this the button the submit chord clicks in its scope, and shows the chord on it. See systems/submit-chord.client.
	// The hint is left out under asChild, whose single child cannot take a sibling.
	submitChord?: SubmitChordClient.ButtonMode | boolean
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
	({ className, variant, size, asChild = false, submitChord, children, ...props }, ref) => {
		const Comp = asChild ? Slot : 'button'
		return (
			<Comp
				className={cn(buttonVariants({ variant, size, className }))}
				ref={ref}
				{...SubmitChordClient.buttonAttrs(submitChord)}
				{...props}
			>
				{children}
				{submitChord && !asChild && <SubmitChordKbd className="pointer-coarse:hidden" />}
			</Comp>
		)
	},
)
Button.displayName = 'Button'

export { Button, buttonVariants }
