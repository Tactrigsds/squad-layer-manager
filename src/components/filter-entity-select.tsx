import ComboBox from '@/components/combo-box/combo-box.tsx'
import { LOADING } from '@/components/combo-box/constants.ts'
import EmojiDisplay from '@/components/emoji-display.tsx'
import { PermissionDeniedTooltip } from '@/components/permission-denied-tooltip'
import { buttonVariants } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type * as F from '@/models/filter.models'
import * as RBAC from '@/rbac.models'
import * as FilterEntityClient from '@/systems/filter-entity.client'
import * as RbacClient from '@/systems/rbac.client'
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
	const forceWriteDenied = RbacClient.usePermsCheck(RBAC.perm('queue:force-write'))
	return (
		<PermissionDeniedTooltip denied={forceWriteDenied} triggerClassName={cn('flex space-x-2 items-center flex-nowrap', props.className)}>
			<div className={cn('flex space-x-2 items-center flex-nowrap', props.className)}>
				{props.allowToggle && (
					<Checkbox
						id={enableCheckboxId}
						disabled={!!forceWriteDenied}
						onCheckedChange={(v) => {
							if (v === 'indeterminate') return
							props.setEnabled?.(v)
						}}
						checked={props.enabled}
					/>
				)}
				<ComboBox
					title={props.title ?? 'Filter'}
					disabled={!!forceWriteDenied}
					className="grow"
					options={filterOptions ?? LOADING}
					allowEmpty={props.allowEmpty ?? true}
					value={props.filterId}
					onSelect={(filter) =>
						props.onSelect(filter ?? null)}
				>
					{props.children}
				</ComboBox>
				{props.filterId && <FilterEntityLink filterId={props.filterId} />}
			</div>
		</PermissionDeniedTooltip>
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

export function FilterEntityLink(props: { filterId: F.FilterEntityId }) {
	return (
		<Link
			className={buttonVariants({ variant: 'ghost', size: 'icon' })}
			params={{ filterId: props.filterId }}
			to="/filters/$filterId"
		>
			<Icons.Edit />
		</Link>
	)
}
