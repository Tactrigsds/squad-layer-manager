import * as AR from '@/app-routes'
import { assertNever } from '@/lib/type-guards'
import * as Typo from '@/lib/typography'
import { cn } from '@/lib/utils'
import * as LQY from '@/models/layer-queries.models'
import * as FilterEntityClient from '@/systems.client/filter-entity.client'
import * as LayerQueriesClient from '@/systems.client/layer-queries.client'
import * as Icons from 'lucide-react'
import React from 'react'
import { Link } from 'react-router-dom'
import EmojiDisplay from './emoji-display'
import { FilterEntityLabel } from './filter-entity-select'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'

export type ConstraintViolationDisplayProps = {
	violated: LQY.LayerQueryConstraint[]
	violationDescriptors?: LQY.ViolationDescriptor[]
	teamParity?: number
	itemId?: LQY.LayerItemId
	padEmpty?: boolean
}

export function ConstraintViolationDisplay(props: ConstraintViolationDisplayProps) {
	const filters = FilterEntityClient.useFilterEntities()
	const onMouseOver = () => {
		LayerQueriesClient.Store.getState().setHoveredConstraintItemId(props.itemId ?? null)
	}
	const onMouseOut = () => {
		const state = LayerQueriesClient.Store.getState()
		if (state.hoveredConstraintItemId !== props.itemId) return
		state.setHoveredConstraintItemId(null)
	}

	if (props.violated.length == 0) return null
	const dnrViolations = props.violated.filter(v => v.type === 'do-not-repeat')
	const filterViolations = props.violated.filter(v => v.type !== 'do-not-repeat')
	if (dnrViolations.length === 0 && filterViolations.length === 0) return null

	const filterViolationsIcons: React.ReactNode[] = []
	// always appears at the start
	if (dnrViolations.length > 0) filterViolationsIcons.push(<ConstraintViolationIcon />)
	for (const v of filterViolations) {
		if (v.type === 'filter-anon') {
			console.warn("we don't support displaying this kind of violation:", v.type)
			continue
		}
		const filter = filters.get(v.filterEntityId)
		if (!filter?.emoji) {
			filterViolationsIcons.push(<Icons.Filter className="bg-orange-500" />)
		} else {
			filterViolationsIcons.push(<EmojiDisplay showTooltip={false} emoji={filter.emoji} size="sm" />)
		}
	}

	return (
		<div className="flex space-x-0.5 items-center min-w-0">
			<Tooltip delayDuration={0}>
				<TooltipTrigger
					className="flex -space-x-2 items-center flex-nowrap"
					onMouseOver={props.itemId ? onMouseOver : undefined}
					onMouseOut={props.itemId ? onMouseOut : undefined}
				>
					{filterViolationsIcons}
				</TooltipTrigger>
				<TooltipContent className="max-w-sm p-3 bg-secondary border-solid" align="start" side="right">
					{filterViolations.length > 0 && (
						<>
							<ul className="flex flex-col space-y-2">
								{dnrViolations.length > 0 && (
									<>
										<div className={cn(Typo.Label, 'text-foreground')}>Repeats Detected:</div>
										<ul className="flex flex-col space-y-1">
											{dnrViolations.map(v => (
												<li key={v.id} className="flex items-center space-x-1">
													<ConstraintViolationIcon />
													<span>
														{v.rule.label ?? v.rule.field} <span className="font-light">(within {v.rule.within})</span>
													</span>
												</li>
											))}
										</ul>
									</>
								)}
								<div className="flex flex-col space-y-1">
									<div className={cn(Typo.Label, 'text-foreground')}>Filtered By:</div>
									{filterViolations.map(v => {
										let id: string
										let displayName: string
										switch (v.type) {
											case 'filter-anon':
												id = v.id
												displayName = v.name ?? v.id
												break

											case 'filter-entity': {
												const filter = filters.get(v.filterEntityId)
												if (!filter) return null

												return (
													<li key={v.id}>
														<FilterEntityLabel filter={filter} includeLink={true} />
													</li>
												)
												break
											}

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
														<div key={index} className="text-secondary-foreground">{`: ${descriptor.field}`}</div>
													))}
												</Link>
											</li>
										)
									})}
								</div>
							</ul>
						</>
					)}
				</TooltipContent>
			</Tooltip>
		</div>
	)
}

export function ConstraintViolationIcon() {
	return <Icons.Repeat className="text-pink-400" />
}
