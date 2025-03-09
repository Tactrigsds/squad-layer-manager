import { cn } from '@/lib/utils'
import * as React from 'react'

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
	rightElement?: React.ReactNode
}

const Input = React.forwardRef<HTMLInputElement, InputProps>(
	({ className, type, rightElement, ...props }, ref) => {
		return (
			<div className="relative flex items-center w-full">
				<input
					type={type}
					className={cn(
						'flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50',
						rightElement && 'pr-10',
						className,
					)}
					ref={ref}
					{...props}
				/>
				{rightElement && (
					<div className="absolute right-3 flex items-center justify-center">
						{rightElement}
					</div>
				)}
			</div>
		)
	},
)
Input.displayName = 'Input'

export { Input }
