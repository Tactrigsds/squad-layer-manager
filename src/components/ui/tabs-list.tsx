import { cn } from '@/lib/utils'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './tooltip'
export default function TabsList<T extends string>(props: {
	options: { value: T; label: string; disabled?: boolean | string }[]
	active: T
	setActive: (active: T) => void
	className?: string
}) {
	return (
		<TooltipProvider>
			<div className={cn('inline-flex h-9 items-center justify-center rounded-lg bg-muted p-1 text-muted-foreground', props.className)}>
				{props.options.map((option) => {
					const isDisabled = !!option.disabled
					const disabledMessage = typeof option.disabled === 'string' ? option.disabled : null

					const button = (
						<button
							key={option.value}
							type="button"
							data-state={props.active === option.value && 'active'}
							data-softdisabled={isDisabled}
							onClick={() => {
								if (isDisabled) return
								props.setActive(option.value)
							}}
							className="inline-flex data-[softdisabled=true]:cursor-not-allowed items-center justify-center whitespace-nowrap rounded-md px-3 py-1 text-sm font-medium ring-offset-background transition-all focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm"
						>
							{option.label}
						</button>
					)

					if (disabledMessage) {
						return (
							<Tooltip key={option.value}>
								<TooltipTrigger asChild>
									{button}
								</TooltipTrigger>
								<TooltipContent>
									{disabledMessage}
								</TooltipContent>
							</Tooltip>
						)
					}

					return button
				})}
			</div>
		</TooltipProvider>
	)
}
