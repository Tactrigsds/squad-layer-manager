import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'
import * as React from 'react'

import { cn } from '@/lib/utils'

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
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(({ className, variant, size, asChild = false, ...props }, ref) => {
	const Comp = asChild ? Slot : 'button'
	return <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />
})
Button.displayName = 'Button'

export { Button, buttonVariants }
