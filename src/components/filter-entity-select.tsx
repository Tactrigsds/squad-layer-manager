import ComboBox from '@/components/combo-box/combo-box.tsx'
import { LOADING } from '@/components/combo-box/constants.ts'
import EmojiDisplay from '@/components/emoji-display.tsx'
import { buttonVariants } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type * as F from '@/models/filter.models'
import * as FilterEntityClient from '@/systems/filter-entity.client'
import { Link } from '@tanstack/react-router'
import * as Icons from 'lucide-react'
import React from 'react'
import { Checkbox } from './ui/checkbox.tsx'

export default function FilterEntitySelect(props: {
	className?: string
	title?: string
	allowEmpty?: boolean
	filterId: string | null
	onSelect: (filterId: string | null) => void
	allowToggle?: boolean
	enabled?: boolean
	setEnabled?: (enabled: boolean) => void
	excludedFilterIds?: F.FilterEntityId[]
	children?: React.ReactNode
}) {
	const filters = FilterEntityClient.useFilterEntities()
	const filterOptions = []
	for (const f of filters.values()) {
		if (!props.excludedFilterIds || !props.excludedFilterIds.includes(f.id)) {
			filterOptions.push({
				value: f.id,
				label: (
					<span className="flex items-center space-x-1">
						{f.emoji && <EmojiDisplay emoji={f.emoji} size="sm" />}
						<span>{f.name}</span>
					</span>
				),
			})
		}
	}
	const enableCheckboxId = React.useId()
	return (
		<div className={cn('flex space-x-2 items-center flex-nowrap', props.className)}>
			{props.allowToggle && (
				<Checkbox
					id={enableCheckboxId}
					onCheckedChange={(v) => {
						if (v === 'indeterminate') return
						props.setEnabled?.(v)
					}}
					checked={props.enabled}
				/>
			)}
			<ComboBox
				title={props.title ?? 'Filter'}
				className="grow"
				options={filterOptions ?? LOADING}
				allowEmpty={props.allowEmpty ?? true}
				value={props.filterId}
				onSelect={(filter) => props.onSelect(filter ?? null)}
			>
				{props.children}
			</ComboBox>
			{props.filterId && <FilterEntityLink filterId={props.filterId} />}
		</div>
	)
}

export function FilterEntityLabel(props: { className?: string; filter: F.FilterEntity; includeLink?: boolean }) {
	return (
		<span className={cn('flex items-center space-x-1', props.className)}>
			<span className="flex items-center space-x-1">
				{props.filter.emoji && <EmojiDisplay emoji={props.filter.emoji} size="sm" />}
				<span>{props.filter.name}</span>
			</span>
			{props.includeLink && <FilterEntityLink filterId={props.filter.id} />}
		</span>
	)
}

export function FilterEntityLink(props: { filterId: F.FilterEntityId; className?: string }) {
	return (
		<Link
			className={cn(buttonVariants({ variant: 'ghost', size: 'icon' }), props.className)}
			params={{ filterId: props.filterId }}
			to="/filters/$filterId"
			target="__blank"
		>
			<Icons.ExternalLink />
		</Link>
	)
}
