import * as M from '@/models'
import * as Icons from 'lucide-react'
import React from 'react'
// import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'

export type ConstraintViolatioDisplayProps = {
	violated: M.LayerQueryConstraint[]
	children?: React.ReactNode
}

export function ConstraintViolationDisplay(props: ConstraintViolatioDisplayProps) {
	if (props.violated.length == 0) return null
	return (
		<Tooltip>
			{props.children
				? <TooltipTrigger asChild>{props.children}</TooltipTrigger>
				: (
					<TooltipTrigger>
						<Icons.ShieldQuestion className="text-orange-400" />
					</TooltipTrigger>
				)}
			<TooltipContent>
				<ul className="flex flex-col">
					{props.violated.map(v => <li key={v.id}>{v.name ?? v.id}</li>)}
				</ul>
			</TooltipContent>
		</Tooltip>
	)
}
