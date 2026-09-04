import { cva, type VariantProps } from 'class-variance-authority'
import * as React from 'react'

import { cn } from '@/lib/utils'

const alertVariants = cva('fd-alert relative w-full text-sm [&>svg]:row-span-2 [&:not(:has(>svg))]:grid-cols-1', {
	variants: {
		variant: {
			default: '',
			destructive: 'fd-alert-dng',
			info: 'fd-alert-info',
			warning: 'fd-alert-warn',
			'repeat-violation': 'fd-alert-rep',
		},
	},
	defaultVariants: {
		variant: 'default',
	},
})

const Alert = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement> & VariantProps<typeof alertVariants>>(
	({ className, variant, ...props }, ref) => (
		<div ref={ref} role="alert" className={cn(alertVariants({ variant }), className)} {...props} />
	),
)
Alert.displayName = 'Alert'

const AlertTitle = React.forwardRef<HTMLParagraphElement, React.HTMLAttributes<HTMLHeadingElement>>(({ className, ...props }, ref) => (
	<h5 ref={ref} className={cn('font-semibold leading-tight', className)} {...props} />
))
AlertTitle.displayName = 'AlertTitle'

const AlertDescription = React.forwardRef<HTMLParagraphElement, React.HTMLAttributes<HTMLParagraphElement>>(
	({ className, ...props }, ref) => <div ref={ref} className={cn('text-xs text-text-2 [&_p]:leading-relaxed', className)} {...props} />,
)
AlertDescription.displayName = 'AlertDescription'

export { Alert, AlertDescription, AlertTitle }
