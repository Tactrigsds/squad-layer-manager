import * as TogglePrimitive from '@radix-ui/react-toggle'
import { cva, type VariantProps } from 'class-variance-authority'
import * as React from 'react'

import { cn } from '@/lib/utils'

const toggleVariants = cva('fd-btn', {
	variants: {
		variant: {
			default: '',
			outline: '',
		},
		size: {
			default: 'min-w-(--ctl) px-1.5',
			sm: 'fd-btn-sm min-w-[calc(var(--ctl)-4px)] px-1',
			lg: 'px-2.5',
		},
	},
	defaultVariants: {
		variant: 'default',
		size: 'default',
	},
})

const Toggle = React.forwardRef<
	React.ElementRef<typeof TogglePrimitive.Root>,
	React.ComponentPropsWithoutRef<typeof TogglePrimitive.Root> & VariantProps<typeof toggleVariants>
>(({ className, variant, size, ...props }, ref) => (
	<TogglePrimitive.Root ref={ref} className={cn(toggleVariants({ variant, size, className }))} {...props} />
))

Toggle.displayName = TogglePrimitive.Root.displayName

export { Toggle, toggleVariants }
