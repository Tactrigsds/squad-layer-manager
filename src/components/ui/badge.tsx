import { cva, type VariantProps } from 'class-variance-authority'
import * as React from 'react'

import { cn } from '@/lib/utils'

const badgeVariants = cva('fd-badge', {
	variants: {
		variant: {
			default: '',
			primary: 'fd-badge-pri',
			secondary: '',
			destructive: 'fd-badge-dng',
			outline: 'fd-badge-line',
			edited: 'fd-badge-warn',
			moved: 'fd-badge-info',
			added: 'fd-badge-ok',
			removed: 'fd-badge-dng',
			info: 'fd-badge-info',
			warning: 'fd-badge-warn',
			repeat: 'fd-badge-rep',
		},
	},
	defaultVariants: {
		variant: 'default',
	},
})

export interface BadgeProps extends React.HTMLAttributes<HTMLDivElement>, VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
	return <div className={cn(badgeVariants({ variant }), className)} {...props} />
}

export { Badge, badgeVariants }
