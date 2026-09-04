import * as CheckboxPrimitive from '@radix-ui/react-checkbox'
import { CheckIcon } from '@radix-ui/react-icons'
import * as React from 'react'

import { cn } from '@/lib/utils'

const Checkbox = React.forwardRef<
	React.ElementRef<typeof CheckboxPrimitive.Root>,
	{ onCheckedChange?: (checked: boolean) => void } & React.ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root>
>(({ className, ...props }, ref) => (
	<CheckboxPrimitive.Root
		ref={ref}
		className={cn('fd-cbx peer', className)}
		{...props}
		onCheckedChange={(checked) => {
			if (checked === 'indeterminate') props.onCheckedChange?.(true)
			else props.onCheckedChange?.(checked)
		}}
	>
		<CheckboxPrimitive.Indicator className="flex items-center justify-center text-current">
			<CheckIcon />
		</CheckboxPrimitive.Indicator>
	</CheckboxPrimitive.Root>
))
Checkbox.displayName = CheckboxPrimitive.Root.displayName

export { Checkbox }
