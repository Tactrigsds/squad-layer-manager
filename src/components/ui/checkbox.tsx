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
		className={cn(
			'peer h-4 w-4 shrink-0 rounded-sm border border-primary shadow focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground',
			className
		)}
		{...props}
		onCheckedChange={(checked) => {
			if (checked === 'indeterminate') props.onCheckedChange?.(true)
			else props.onCheckedChange?.(checked)
		}}
	>
		<CheckboxPrimitive.Indicator className={cn('flex items-center justify-center text-current')}>
			<CheckIcon className="h-4 w-4" />
		</CheckboxPrimitive.Indicator>
		{/* hacky way to make sure the size of this component doesn't shift around */}
		{/* {!props.checked && <CheckIcon data-checked={props.checked} className="h-4 w-4 invisible" />} */}
	</CheckboxPrimitive.Root>
))
Checkbox.displayName = CheckboxPrimitive.Root.displayName

export { Checkbox }
