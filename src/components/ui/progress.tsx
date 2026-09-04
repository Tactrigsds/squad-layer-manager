import * as ProgressPrimitive from '@radix-ui/react-progress'
import * as React from 'react'

import { cn } from '@/lib/utils'

const Progress = React.forwardRef<
	React.ElementRef<typeof ProgressPrimitive.Root>,
	React.ComponentPropsWithoutRef<typeof ProgressPrimitive.Root>
>(({ className, value, ...props }, ref) => (
	<ProgressPrimitive.Root ref={ref} className={cn('fd-prog relative w-full', className)} {...props}>
		<ProgressPrimitive.Indicator className="fd-prog-bar w-full flex-1" style={{ transform: `translateX(-${100 - (value || 0)}%)` }} />
	</ProgressPrimitive.Root>
))
Progress.displayName = ProgressPrimitive.Root.displayName

export { Progress }
