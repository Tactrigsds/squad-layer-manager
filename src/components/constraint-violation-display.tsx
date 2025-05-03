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
	const dnrViolations = props.violated.filter(v => v.type === 'do-not-repeat')
	const filterViolations = props.violated.filter(v => v.type !== 'do-not-repeat')
	return (
		<>
			{dnrViolations.length > 0 && (
				<Tooltip delayDuration={0}>
					{props.children
						? <TooltipTrigger asChild>{props.children}</TooltipTrigger>
						: (
							<TooltipTrigger>
								<Icons.ShieldQuestion className="text-pink-400" />
							</TooltipTrigger>
						)}
					<TooltipContent>
						<div className="font-semibold">DNR:</div>
						<ul className="flex flex-col">
							{props.violated.map(v => <li key={v.id}>{v.name ?? v.id}</li>)}
						</ul>
					</TooltipContent>
				</Tooltip>
			)}
			{filterViolations.length > 0 && (
				<Tooltip delayDuration={0}>
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
			)}
		</>
	)
}
