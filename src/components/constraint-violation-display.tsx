import * as AR from '@/app-routes'
import { assertNever } from '@/lib/typeGuards'
import * as M from '@/models'
import * as Icons from 'lucide-react'
import React from 'react'
import { Link } from 'react-router-dom'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'

export type ConstraintViolatioDisplayProps = {
	violated: M.LayerQueryConstraint[]
	violationDescriptors?: Record<string, string[] | undefined>
	teamParity?: number
	children?: React.ReactNode
	layerId: string
	padEmpty?: boolean
}

export function ConstraintViolationDisplay(props: ConstraintViolatioDisplayProps) {
	if (props.violated.length == 0) return null
	const dnrViolations = props.violated.filter(v => v.type === 'do-not-repeat')
	const filterViolations = props.violated.filter(v => v.type !== 'do-not-repeat')
	if (dnrViolations.length === 0 && filterViolations.length === 0) return null
	return (
		<div className="flex space-x-0.5 items-center">
			{dnrViolations.length > 0
				? (
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
								{dnrViolations.map(v => (
									<li key={v.id}>
										{v.name ?? v.id}
										{props.violationDescriptors?.[v.id]
											&& props.violationDescriptors[v.id]?.map((descriptor) => <div key={descriptor}>{descriptor}</div>)}
									</li>
								))}
							</ul>
						</TooltipContent>
					</Tooltip>
				)
				: (props.padEmpty && <Icons.ShieldQuestion className="invisible" />)}
			{filterViolations.length > 0
				? (
					<Tooltip delayDuration={0}>
						{props.children
							? <TooltipTrigger asChild>{props.children}</TooltipTrigger>
							: (
								<TooltipTrigger>
									<Icons.ShieldQuestion className="text-orange-400" />
								</TooltipTrigger>
							)}
						<TooltipContent>
							<div className="font-semibold">Filters:</div>
							<ul className="flex flex-col">
								{filterViolations.map(v => {
									let id: string
									let displayName: string
									switch (v.type) {
										case 'filter-anon':
											id = v.id
											displayName = v.name ?? v.id
											break
										case 'filter-entity':
											id = v.filterEntityId
											displayName = v.filterEntityId
											break
										default:
											assertNever(v)
									}

									return (
										<li key={v.id}>
											<Link
												className="underline"
												target="_blank"
												to={AR.link('/filters/:id', id)}
											>
												{displayName}
												{props.violationDescriptors?.[v.id]
													&& props.violationDescriptors[v.id]?.map((descriptor, index) => <div key={index}>{`: ${descriptor}`}</div>)}
											</Link>
										</li>
									)
								})}
							</ul>
						</TooltipContent>
					</Tooltip>
				)
				: (props.padEmpty && <Icons.ShieldQuestion className="invisible" />)}
		</div>
	)
}
