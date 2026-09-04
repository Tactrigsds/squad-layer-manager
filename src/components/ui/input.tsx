import * as React from 'react'

import { cn } from '@/lib/utils'

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
	rightElement?: React.ReactNode
	containerClassName?: string
}

const Input = React.forwardRef<HTMLInputElement, InputProps>(({ className, type, rightElement, containerClassName, ...props }, ref) => {
	return (
		<div className={cn('relative flex items-center w-full', containerClassName)}>
			<input
				type={type}
				className={cn(
					'fd-inp w-full file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground',
					rightElement && 'pr-8',
					className,
				)}
				ref={ref}
				{...props}
			/>
			{rightElement && <div className="absolute right-2 flex items-center justify-center">{rightElement}</div>}
		</div>
	)
})
Input.displayName = 'Input'

export { Input }
