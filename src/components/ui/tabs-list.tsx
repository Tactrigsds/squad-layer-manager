import { cn } from '@/lib/utils'

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './tooltip'
// `variant="seg"` is the segmented control: a flush group of small buttons with the active one pressed
export default function TabsList<T extends string>(props: {
	options: { value: T; label: string; disabled?: boolean | string }[]
	active: T
	setActive: (active: T) => void
	className?: string
	variant?: 'tabs' | 'seg'
}) {
	const seg = props.variant === 'seg'
	return (
		<TooltipProvider>
			<div className={cn(seg ? 'fd-grp' : 'fd-tabs', props.className)}>
				{props.options.map((option) => {
					const isDisabled = !!option.disabled
					const disabledMessage = typeof option.disabled === 'string' ? option.disabled : null

					const button = (
						<button
							key={option.value}
							type="button"
							data-state={seg ? (props.active === option.value ? 'on' : 'off') : props.active === option.value && 'active'}
							data-softdisabled={isDisabled}
							onClick={() => {
								if (isDisabled) return
								props.setActive(option.value)
							}}
							className={seg ? 'fd-btn fd-btn-sm font-medium' : 'fd-tab'}
						>
							{option.label}
						</button>
					)

					if (disabledMessage) {
						return (
							<Tooltip key={option.value}>
								<TooltipTrigger asChild>{button}</TooltipTrigger>
								<TooltipContent>{disabledMessage}</TooltipContent>
							</Tooltip>
						)
					}

					return button
				})}
			</div>
		</TooltipProvider>
	)
}
