import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle } from '@/components/ui/item'

import { assertNever } from '@/lib/type-guards'
import * as Typo from '@/lib/typography'
import { cn } from '@/lib/utils'
import * as L from '@/models/layer'
import * as LQY from '@/models/layer-queries.models'
import * as FilterEntityClient from '@/systems.client/filter-entity.client'
import * as LQYClient from '@/systems.client/layer-queries.client'
import type { TooltipContentProps } from '@radix-ui/react-tooltip'
import * as Icons from 'lucide-react'
import React from 'react'
import EmojiDisplay from './emoji-display'
import { FilterEntityLink } from './filter-entity-select'
import { Separator } from './ui/separator'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'

export type ConstraintMatchesIndicator = {
	queriedConstraints: LQY.Constraint[]
	matchingConstraintIds: string[]
	matchDescriptors?: LQY.MatchDescriptor[]
	padEmpty?: boolean
	className?: string
	layerItem?: LQY.LayerItem
	// will be inferred from layerItem if layerId missing
	layerId?: string
	itemParity?: number
	side?: TooltipContentProps['side']
	height?: number
}

export function ConstraintMatchesIndicator(props: ConstraintMatchesIndicator) {
	const filters = FilterEntityClient.useFilterEntities()
	const height = props.height ?? 24
	const iconSize = height * 0.75

	const itemId = props.layerItem && LQY.resolveId(props.layerItem)
	const onMouseOver = () => {
		LQYClient.Store.getState().setHoveredConstraintItemId(itemId ?? null)
	}
	const onMouseOut = () => {
		const state = LQYClient.Store.getState()
		if (state.hoveredConstraintItemId !== itemId) return
		state.setHoveredConstraintItemId(null)
	}

	const indicatorIcons: React.ReactNode[] = []
	const renderedRepeats: Extract<LQY.ViewableConstraint, { type: 'do-not-repeat' }>[] = []
	const renderedFilters: [string, React.ReactNode][] = []
	for (const constraint of props.queriedConstraints) {
		if (!constraint.indicateMatches) continue
		const matched = props.matchingConstraintIds.includes(constraint.id)
		if (constraint.type === 'do-not-repeat') {
			if (!matched) continue
			renderedRepeats.push(constraint)
			continue
		}
		if (constraint.type === 'filter-entity') {
			const filter = filters.get(constraint.filterId)
			if (!filter) {
				console.warn(`Filter not found for constraint ${constraint.id}`)
				continue
			}
			let emoji: string | undefined | null
			let alertMessage: string | undefined | null
			if (matched) {
				emoji = filter.emoji
				alertMessage = filter.alertMessage
			} else {
				if (!filter.invertedEmoji || !filter.invertedAlertMessage) continue
				emoji = filter.invertedEmoji
				alertMessage = filter.invertedAlertMessage
			}
			if (emoji) {
				indicatorIcons.push(
					<EmojiDisplay key={constraint.id} showTooltip={false} emoji={emoji} size={iconSize} />,
				)
			}

			renderedFilters.push(
				[
					constraint.id,
					<Item key={constraint.id} variant="default" className="w-full">
						<ItemMedia>
							{emoji ? <EmojiDisplay emoji={emoji} /> : <Icons.Filter className="bg-orange-500" />}
						</ItemMedia>
						<ItemContent>
							<ItemTitle>{filter.name}</ItemTitle>
							{alertMessage && <ItemDescription className="whitespace-normal line-clamp-none">{alertMessage}</ItemDescription>}
						</ItemContent>
						<ItemActions>
							<FilterEntityLink filterId={filter.id} />
						</ItemActions>
					</Item>,
				],
			)
			continue
		}
		assertNever(constraint)
	}

	if (renderedFilters.length === 0 && renderedRepeats.length === 0) {
		return props.padEmpty
			? (
				<div
					className={cn('flex items-center', props.className)}
					style={{ height: `${height}px` }}
				/>
			)
			: null
	}

	// repeat icon always appears at the start
	if (renderedFilters.length > 0 && indicatorIcons.length === 0) {
		indicatorIcons.push(<Icons.Filter key="__filtered__" className="bg-orange-500" />)
	}
	if (renderedRepeats.length > 0) indicatorIcons.unshift(<ConstraintViolationIcon key="__repeat-violation__" size={iconSize} />)

	return (
		<Tooltip delayDuration={0}>
			<TooltipTrigger
				className={cn('flex -space-x-2 items-center flex-nowrap overflow-hidden', props.className)}
				style={{ height: `${height}px` }}
				onMouseOver={itemId ? onMouseOver : undefined}
				onMouseOut={itemId ? onMouseOut : undefined}
			>
				{indicatorIcons}
			</TooltipTrigger>
			<TooltipContent
				className="max-w-max p-3 bg-popover text-popover-foreground rounded-md border border-solid space-y-2"
				align="start"
				side={props.side}
			>
				{renderedRepeats.length > 0 && (
					<div className="flex flex-col">
						<div className={cn(Typo.Label, 'text-foreground')}>Repeats Detected:</div>
						<ItemGroup>
							{renderedRepeats.map((constraint, index) => {
								const layerId = props.layerId ?? props.layerItem?.layerId
								const descriptors = (() => {
									if (!layerId || !props.matchDescriptors || props.itemParity === undefined) return []
									return props.matchDescriptors
										.filter(descriptor => descriptor.constraintId === constraint.id && descriptor.type === 'repeat-rule')
										.flatMap(descriptor => {
											if (descriptor.type !== 'repeat-rule') return []
											const property = LQY.resolveLayerPropertyForRepeatDescriptorField(descriptor, props.itemParity!)
											return [{
												...descriptor,
												fieldValue: L.toLayer(layerId)[property]!,
											}]
										})
								})()

								const boldValue = (value: string | number) => <span className="font-semibold">{value}</span>

								return (
									<React.Fragment key={constraint.id}>
										{index > 0 && <Separator key={`separator-${constraint.id}`} />}
										<Item variant="default" className="w-max">
											<ItemMedia>
												<ConstraintViolationIcon />
											</ItemMedia>
											<ItemContent className="flex flex-col">
												<ItemTitle className="leading-none">
													{constraint.rule.label ?? constraint.rule.field}
												</ItemTitle>
												<ItemDescription className="font-light flex flex-col">
													{descriptors.length > 0
														? (
															<>
																{descriptors.map((d, i) => (
																	<span key={d.fieldValue}>
																		<span className="font-semibold">{boldValue(d.fieldValue)}</span> was played{' '}
																		<span className="font-semibold">{boldValue(d.repeatOffset)}</span> matches prior
																	</span>
																))}
																<span>
																	Should be &gt; <span className="font-semibold">{boldValue(constraint.rule.within)}</span>
																</span>
															</>
														)
														: (
															<span className="whitespace-nowrap">
																within <span className="font-semibold">{constraint.rule.within}</span>
															</span>
														)}
												</ItemDescription>
											</ItemContent>
										</Item>
									</React.Fragment>
								)
							})}
						</ItemGroup>
					</div>
				)}
				{renderedFilters.length > 0 && (
					<div className="flex flex-col">
						<div className={cn(Typo.Label, 'text-foreground')}>Matching Filters:</div>
						<ItemGroup>
							{renderedFilters.flatMap(([constraintId, elt], index) => {
								return (
									<React.Fragment key={constraintId}>
										{index > 0 && <Separator key={`separator-${constraintId}`} />}
										{elt}
									</React.Fragment>
								)
							})}
						</ItemGroup>
					</div>
				)}
			</TooltipContent>
		</Tooltip>
	)
}

export function ConstraintViolationIcon({ size }: { size?: number }) {
	return <Icons.Repeat className="text-pink-400" size={size} />
}
