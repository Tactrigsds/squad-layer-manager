import * as Icons from 'lucide-react'
import React from 'react'

import { Item, ItemContent, ItemDescription, ItemMedia, ItemTitle } from '@/components/ui/item'
import { TrackingTooltip } from '@/components/ui/tooltip'
import { useFollowTooltip } from '@/hooks/use-follow-tooltip'
import { assertNever } from '@/lib/type-guards'
import { cn } from '@/lib/utils'
import * as Zus from '@/lib/zustand'
import * as F_Msgs from '@/messages/filter.messages'
import type * as F from '@/models/filter.models'
import * as L from '@/models/layer'
import * as LQY from '@/models/layer-queries.models'
import * as FilterEntityClient from '@/systems/filter-entity.client'
import * as LQYClient from '@/systems/layer-queries.client'
import { tr } from '@/systems/messages.client'

import EmojiDisplay from './emoji-display'

export type ConstraintEvalTooltipProps = {
	queriedConstraints: LQY.Constraint[]
	matchDescriptors?: LQY.MatchDescriptor[]
	padEmpty?: boolean
	className?: string
	layerItem?: LQY.LayerItem
	// will be inferred from layerItem if layerId missing
	layerId?: string
	itemParity?: number
	height?: number
	tourId?: string
}

type RepeatRow = {
	key: string
	field: string
	value?: string
	repeatOffset?: number
	within: number
}

type FilterRow = {
	constraintId: string
	filter: F.FilterEntity
	matched: boolean
	emoji: string | null | undefined
	alertMessage: string | null | undefined
}

export function ConstraintEvalTooltip(props: ConstraintEvalTooltipProps) {
	const filters = FilterEntityClient.useFilterEntities()
	const tooltip = useFollowTooltip()
	const height = props.height ?? 24
	const iconSize = height * 0.75
	const layerId = props.layerId ?? props.layerItem?.layerId
	const itemId = props.layerItem && LQY.resolveId(props.layerItem)
	const onMouseOver = () => {
		LQYClient.Actions.setHoveredConstraintItemId(itemId ?? null)
	}
	const onMouseOut = () => {
		const state = Zus.getState(LQYClient.Store)
		if (state.hoveredConstraintItemId !== itemId) return
		LQYClient.Actions.setHoveredConstraintItemId(null)
	}

	const descriptorsForItem = props.matchDescriptors?.filter((desc) => {
		if (desc.itemId && desc.itemId !== itemId) return false
		if (layerId && !L.layersEqual(desc.layerId, layerId)) return false
		if (desc.type === 'filter-entity' || desc.type === 'installed-mods') {
			return !!layerId
		} else if (desc.type === 'repeat-rule') {
			return desc.itemId === itemId
		} else {
			assertNever(desc)
		}
	})

	const indicatorIcons: React.ReactNode[] = []
	const repeatRows: RepeatRow[] = []
	const filterRows: FilterRow[] = []
	// the collection this layer needs, when the server does not have it
	let unsupportedCollection: string | undefined
	// the same filter can be reached by several constraints (pool filter, indicate lists, applied extras)
	const renderedFilterIds = new Set<string>()
	for (const constraint of props.queriedConstraints) {
		if (constraint.type === 'filter-anon' || constraint.type === 'filter-menu-items') continue
		const matched = !!descriptorsForItem?.some((desc) => desc.constraintId === constraint.id)
		if (constraint.showIndicator === 'disabled') continue
		if ((constraint.showIndicator === 'regular' && !matched) || (constraint.showIndicator === 'inverted' && matched)) continue
		if (constraint.type === 'do-not-repeat') {
			if (!matched) continue
			const field = constraint.rule.label ?? constraint.rule.field
			const within = constraint.rule.within
			let pushed = false
			if (layerId && props.itemParity !== undefined) {
				for (const desc of descriptorsForItem!) {
					if (desc.type !== 'repeat-rule' || desc.constraintId !== constraint.id) continue
					const property = LQY.resolveLayerPropertyForRepeatDescriptorField(desc, props.itemParity)
					repeatRows.push({
						key: `${constraint.id}-${desc.field}-${desc.repeatOffset}`,
						field,
						value: String(L.toLayer(layerId)[property]),
						repeatOffset: desc.repeatOffset,
						within,
					})
					pushed = true
				}
			}
			if (!pushed) repeatRows.push({ key: constraint.id, field, within })
			continue
		}
		// a descriptor for this constraint is the miss: the layer's collection is not installed
		if (constraint.type === 'installed-mods') {
			if (!matched) continue
			unsupportedCollection = descriptorsForItem?.find(
				(desc): desc is LQY.UnsupportedModMatchDescriptor => desc.type === 'installed-mods' && desc.constraintId === constraint.id,
			)?.collection
			continue
		}
		if (constraint.type === 'filter-entity') {
			if (renderedFilterIds.has(constraint.filterId)) continue
			const filter = filters.get(constraint.filterId)
			if (!filter) {
				console.warn(`Filter not found for constraint ${constraint.id}`)
				continue
			}
			const emoji = matched ? filter.emoji : filter.invertedEmoji
			const alertMessage = matched ? filter.alertMessage : filter.invertedAlertMessage
			if (!matched && (!emoji || !alertMessage)) continue
			renderedFilterIds.add(constraint.filterId)
			filterRows.push({ constraintId: constraint.id, filter, matched, emoji, alertMessage })
			if (emoji) {
				indicatorIcons.push(<EmojiDisplay key={constraint.id} showTooltip={false} emoji={emoji} size={iconSize} />)
			}
			continue
		}
		assertNever(constraint)
	}

	if (filterRows.length === 0 && repeatRows.length === 0 && !unsupportedCollection) {
		return props.padEmpty ? <div className={cn('flex items-center', props.className)} style={{ height: `${height}px` }} /> : null
	}

	// repeat icon always appears at the start
	if (filterRows.length > 0 && indicatorIcons.length === 0) {
		indicatorIcons.push(<Icons.Filter key="__filtered__" className="bg-warn" />)
	}
	if (repeatRows.length > 0) indicatorIcons.unshift(<ConstraintViolationIcon key="__repeat-violation__" size={iconSize} />)
	// an unloadable layer outranks everything else wrong with it
	if (unsupportedCollection) {
		indicatorIcons.unshift(<Icons.PackageX key="__unsupported-mod__" size={iconSize} className="text-destructive" />)
	}

	const strong = (value: React.ReactNode) => <span className="font-semibold">{value}</span>
	const muted = (value: React.ReactNode) => <span className="text-muted-foreground">{value}</span>

	return (
		<>
			<button
				type="button"
				// the trigger is a row of emoji/icons, so it has no text of its own to be named by
				aria-label={tr.text(F_Msgs.layerIndicators())}
				data-tour={props.tourId}
				className={cn('flex -space-x-2 items-center flex-nowrap overflow-hidden', props.className)}
				style={{ height: `${height}px` }}
				onMouseOver={itemId ? onMouseOver : undefined}
				onMouseOut={itemId ? onMouseOut : undefined}
				{...tooltip.triggerProps}
			>
				{indicatorIcons}
			</button>
			<TrackingTooltip
				{...tooltip.contentProps}
				className="w-[400px] max-w-[calc(100vw-2rem)] p-1.5 flex flex-col gap-0.5 text-sm"
				content={
					!tooltip.open ? null : (
						<>
							{unsupportedCollection && (
								<div className="grid grid-cols-[1.25rem_minmax(0,1fr)] gap-x-2.5 p-2 rounded-sm bg-destructive/20">
									<Icons.PackageX className="size-4.5 mt-px text-destructive" />
									<div className="flex flex-col gap-0.5">
										<div className="font-semibold">{tr.text(F_Msgs.unsupportedModTitle(unsupportedCollection))}</div>
										<div className="text-muted-foreground">{tr.text(F_Msgs.unsupportedModHint())}</div>
									</div>
								</div>
							)}
							{repeatRows.map((row) => (
								<div key={row.key} className="grid grid-cols-[1.25rem_minmax(0,1fr)_auto] gap-x-2.5 items-center p-2">
									<ConstraintViolationIcon size={18} />
									<div>
										{row.value === undefined
											? tr.richText(F_Msgs.repeatRowFieldOnly(muted(row.field)))
											: tr.richText(F_Msgs.repeatRow(muted(row.field), strong(row.value)))}
									</div>
									<div className="text-muted-foreground tabular-nums">
										{row.repeatOffset === undefined
											? tr.text(F_Msgs.repeatRowWithin(row.within))
											: tr.text(F_Msgs.repeatRowDistance(row.repeatOffset, row.within))}
									</div>
								</div>
							))}
							{filterRows.length > 0 && (repeatRows.length > 0 || unsupportedCollection) && (
								<div role="separator" className="h-px mx-2 my-0.5 bg-(--line-soft)" />
							)}
							{filterRows.map((row) => (
								<a
									key={row.constraintId}
									href={`/filters/${row.filter.id}`}
									target="_blank"
									rel="noreferrer"
									className="grid grid-cols-[1.25rem_minmax(0,1fr)_auto] gap-x-2.5 items-center p-2 rounded-sm text-foreground no-underline hover:bg-accent"
								>
									{row.emoji ? (
										<EmojiDisplay emoji={row.emoji} showTooltip={false} size={18} />
									) : (
										<Icons.Filter className="size-4.5 text-warn" />
									)}
									<div className="flex flex-col gap-px">
										<div>
											{row.matched
												? tr.richText(F_Msgs.filterRowIn(strong(row.filter.name)))
												: tr.richText(F_Msgs.filterRowNotIn(strong(row.filter.name)))}
										</div>
										{row.alertMessage && <div className="text-muted-foreground whitespace-normal">{row.alertMessage}</div>}
									</div>
									<Icons.ArrowUpRight className="size-4 text-muted-foreground" />
								</a>
							))}
						</>
					)
				}
			/>
		</>
	)
}

export type RepeatViolationDisplayProps = {
	constraint: Extract<LQY.Constraint, { type: 'do-not-repeat' }>
	showIcon: boolean
	layerId?: string
	matchDescriptors?: LQY.MatchDescriptor[]
	itemParity?: number
}

export function RepeatViolationDisplay(props: RepeatViolationDisplayProps) {
	const { constraint, layerId, matchDescriptors, itemParity } = props

	const descriptors = React.useMemo(() => {
		if (!layerId || !matchDescriptors || itemParity === undefined) return []
		return matchDescriptors
			.filter((descriptor) => descriptor.constraintId === constraint.id && descriptor.type === 'repeat-rule')
			.flatMap((descriptor) => {
				if (descriptor.type !== 'repeat-rule') return []
				const property = LQY.resolveLayerPropertyForRepeatDescriptorField(descriptor, itemParity)
				return [
					{
						...descriptor,
						fieldValue: L.toLayer(layerId)[property]!,
					},
				]
			})
	}, [layerId, matchDescriptors, itemParity, constraint.id])

	const boldValue = (value: string | number) => <span className="font-semibold">{value}</span>

	return (
		<Item variant="default" className="w-max">
			{props.showIcon && (
				<ItemMedia>
					<ConstraintViolationIcon />
				</ItemMedia>
			)}
			<ItemContent className="flex flex-col">
				<ItemTitle className="leading-none">{constraint.rule.label ?? constraint.rule.field}</ItemTitle>
				<ItemDescription className="font-light flex flex-col">
					{descriptors.length > 0 ? (
						<>
							{descriptors.map((d) => (
								<span key={`${d.fieldValue}-${d.constraintId}-${d.repeatOffset}`}>
									{tr.richText(F_Msgs.repeatDescriptor(boldValue(d.fieldValue), boldValue(d.repeatOffset), d.repeatOffset))}
								</span>
							))}
							<span>{tr.richText(F_Msgs.repeatShouldBeOver(boldValue(constraint.rule.within)))}</span>
						</>
					) : (
						<span className="whitespace-nowrap">
							{tr.richText(F_Msgs.repeatWithin(<span className="font-semibold">{constraint.rule.within}</span>))}
						</span>
					)}
				</ItemDescription>
			</ItemContent>
		</Item>
	)
}

export function ConstraintViolationIcon({ size }: { size?: number }) {
	return <Icons.Repeat className="text-repeat-violation" size={size} />
}
