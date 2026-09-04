import * as SeparatorPrimitive from '@radix-ui/react-separator'
import * as React from 'react'

import { cn } from '@/lib/utils'

const Separator = React.forwardRef<
	React.ElementRef<typeof SeparatorPrimitive.Root>,
	React.ComponentPropsWithoutRef<typeof SeparatorPrimitive.Root>
>(({ className, orientation = 'horizontal', decorative = true, ...props }, ref) => (
	<SeparatorPrimitive.Root
		ref={ref}
		decorative={decorative}
		orientation={orientation}
		className={cn(
			'shrink-0 bg-line',
			orientation === 'horizontal' ? 'h-px w-full shadow-[0_1px_0_var(--line-soft)]' : 'h-full w-px shadow-[1px_0_0_var(--line-soft)]',
			className,
		)}
		{...props}
	/>
))
Separator.displayName = SeparatorPrimitive.Root.displayName

export { Separator }
