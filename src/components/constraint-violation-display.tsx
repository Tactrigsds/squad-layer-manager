import * as AR from '@/app-routes'
import { assertNever } from '@/lib/type-guards'
import * as LQY from '@/models/layer-queries.models'
import * as QD from '@/systems.client/queue-dashboard.ts'
import * as Icons from 'lucide-react'
import React from 'react'
import { Link } from 'react-router-dom'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'

export type ConstraintViolationDisplayProps = {
	violated: LQY.LayerQueryConstraint[]
	violationDescriptors?: LQY.ViolationDescriptor[]
	teamParity?: number
	children?: React.ReactNode
	itemId?: LQY.LayerItemId
	padEmpty?: boolean
}

export function ConstraintViolationDisplay(props: ConstraintViolationDisplayProps) {
	const onMouseOver = () => {
		QD.QDStore.getState().setHoveredConstraintItemId(props.itemId)
	}
	const onMouseOut = () => {
		QD.QDStore.getState().setHoveredConstraintItemId(original => {
			if (original === props.itemId) {
				return undefined
			}
			return original
		})
	}

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
								<TooltipTrigger onMouseOver={props.itemId ? onMouseOver : undefined} onMouseOut={props.itemId ? onMouseOut : undefined}>
									<Icons.ShieldQuestion className="text-pink-400" />
								</TooltipTrigger>
							)}
						<TooltipContent align="start" side="right" className="max-w-sm p-3">
							<div className="font-semibold text-base mb-2">Repeated:</div>
							<ul className="flex flex-col space-y-1">
								{dnrViolations.map(v => <li key={v.id} className="text-sm">{v.name ?? v.id}</li>)}
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
						<TooltipContent className="max-w-sm p-3" align="start" side="right">
							<div className="font-semibold text-base mb-2">Filtered:</div>
							<ul className="flex flex-col space-y-2">
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
												className="underline text-blue-400 hover:text-blue-300 text-sm"
												target="_blank"
												to={AR.link('/filters/:id', id)}
											>
												{displayName}
												{props.violationDescriptors?.filter(d => d.constraintId === v.id).map((descriptor, index) => (
													<div key={index} className="text-gray-300 text-xs mt-1">{`: ${descriptor.field}`}</div>
												))}
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
