import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle } from '@/components/ui/item'
import * as Typo from '@/lib/typography'
import { cn } from '@/lib/utils'
import * as ZusUtils from '@/lib/zustand'
import * as F from '@/models/filter.models'
import * as LQY from '@/models/layer-queries.models'
import * as FilterEntityClient from '@/systems.client/filter-entity.client'
import * as LQYClient from '@/systems.client/layer-queries.client'
import * as QD from '@/systems.client/queue-dashboard'
import * as ServerSettingsClient from '@/systems.client/server-settings.client.ts'
import { TooltipContentProps } from '@radix-ui/react-tooltip'
import * as Icons from 'lucide-react'
import React from 'react'
import EmojiDisplay from './emoji-display'
import { FilterEntityLink } from './filter-entity-select'
import { Separator } from './ui/separator'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'

export type ConstraintDisplayProps = {
	matchingConstraints: LQY.Constraint[]
	padEmpty?: boolean
	layerItemId?: string
	side?: TooltipContentProps['side']
}

export function ConstraintDisplay(props: ConstraintDisplayProps) {
	const filters = FilterEntityClient.useFilterEntities()
	const onMouseOver = () => {
		LQYClient.Store.getState().setHoveredConstraintItemId(props.layerItemId ?? null)
	}
	const onMouseOut = () => {
		const state = LQYClient.Store.getState()
		if (state.hoveredConstraintItemId !== props.layerItemId) return
		state.setHoveredConstraintItemId(null)
	}

	const constraints = props.matchingConstraints.filter(v => v.indicateMatches) as LQY.ViewableConstraint[]

	if (constraints.length == 0) return null
	const repeatMatches = constraints.filter(v => v.type === 'do-not-repeat')
	const filterMatches = constraints.flatMap(constraint => {
		if (constraint.type === 'do-not-repeat') return []
		const filter = filters.get(constraint.filterId)
		if (!filter) {
			console.warn(`Filter not found for constraint ${constraint.id}`)
			return []
		}
		return [[constraint, filter] as const]
	}) as Array<[LQY.ViewableConstraint, F.FilterEntity]>

	const icons: React.ReactNode[] = []
	// always appears at the start
	if (repeatMatches.length > 0) icons.push(<ConstraintViolationIcon key="__repeat-violation__" />)
	for (const [constraint, filter] of filterMatches) {
		if (!filter.emoji) {
			icons.push(<Icons.Filter key={constraint.id} className="bg-orange-500" />)
		} else {
			icons.push(<EmojiDisplay key={constraint.id} showTooltip={false} emoji={filter.emoji} size="sm" />)
		}
	}

	return (
		<div className="flex space-x-0.5 items-center min-w-0">
			<Tooltip delayDuration={0}>
				<TooltipTrigger
					className="flex -space-x-2 items-center flex-nowrap"
					onMouseOver={props.layerItemId ? onMouseOver : undefined}
					onMouseOut={props.layerItemId ? onMouseOut : undefined}
				>
					{icons}
				</TooltipTrigger>
				<TooltipContent
					className="max-w-sm p-3 bg-popover text-popover-foreground rounded-md border border-solid space-y-2"
					align="start"
					side={props.side}
				>
					{repeatMatches.length > 0 && (
						<div className="flex flex-col">
							<div className={cn(Typo.Label, 'text-foreground')}>Repeats Detected:</div>
							<ItemGroup>
								{repeatMatches.map((constraint, index) => {
									return (
										<React.Fragment key={constraint.id}>
											{index > 0 && <Separator key={`separator-${constraint.id}`} />}
											<Item variant="default" className="w-max">
												<ItemMedia>
													<ConstraintViolationIcon />
												</ItemMedia>
												<ItemContent className="flex flex-row items-center">
													<ItemTitle className="leading-none">{constraint.rule.label ?? constraint.rule.field}</ItemTitle>
													<ItemDescription className="font-light">
														(within {constraint.rule.within})
													</ItemDescription>
												</ItemContent>
											</Item>
										</React.Fragment>
									)
								})}
							</ItemGroup>
						</div>
					)}
					{filterMatches.length > 0 && (
						<div className="flex flex-col">
							<div className={cn(Typo.Label, 'text-foreground')}>Matching Filters:</div>
							<ItemGroup>
								{filterMatches.map(([v, filter], index) => {
									return [
										index > 0 && <Separator key={`separator-${v.id}`} />,
										(
											<Item key={v.id} variant="default" className="w-max">
												<ItemMedia>
													{filter.emoji ? <EmojiDisplay emoji={filter.emoji} /> : <Icons.Filter key={v.id} className="bg-orange-500" />}
												</ItemMedia>
												<ItemContent>
													<ItemTitle>{filter.name}</ItemTitle>
													{filter.alertMessage && <ItemDescription>{filter.alertMessage}</ItemDescription>}
												</ItemContent>
												<ItemActions>
													<FilterEntityLink filterId={filter.id} />
												</ItemActions>
											</Item>
										),
									]
								})}
							</ItemGroup>
						</div>
					)}
				</TooltipContent>
			</Tooltip>
		</div>
	)
}

export function ConstraintViolationIcon() {
	return <Icons.Repeat className="text-pink-400" />
}
