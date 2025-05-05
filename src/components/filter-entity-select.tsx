import * as AR from '@/app-routes.ts'
import ComboBox from '@/components/combo-box/combo-box.tsx'
import { LOADING } from '@/components/combo-box/constants.ts'
import { buttonVariants } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import * as M from '@/models'
import * as RBAC from '@/rbac.models'
import * as FilterEntityClient from '@/systems.client/filter-entity.client.ts'
import { useLoggedInUser } from '@/systems.client/logged-in-user'
import * as ReactRx from '@react-rxjs/core'
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
	excludedFilterIds?: M.FilterEntityId[]
	children?: React.ReactNode
}) {
	const filters = ReactRx.useStateObservable(FilterEntityClient.filterEntities$)
	const filterOptions = []
	for (const f of filters.values()) {
		if (!props.excludedFilterIds || !props.excludedFilterIds.includes(f.id)) {
			filterOptions.push({
				value: f.id,
				label: f.name,
			})
		}
	}
	const enableCheckboxId = React.useId()
	const loggedInUser = useLoggedInUser()
	const hasForceWrite = loggedInUser && RBAC.rbacUserHasPerms(loggedInUser, RBAC.perm('queue:force-write'))
	return (
		<div className={cn('flex space-x-2 items-center flex-nowrap', props.className)}>
			{props.allowToggle && (
				<Checkbox
					id={enableCheckboxId}
					disabled={!hasForceWrite}
					onCheckedChange={(v) => {
						if (v === 'indeterminate') return
						props.setEnabled?.(v)
					}}
					checked={props.enabled}
				/>
			)}
			<ComboBox
				title={props.title ?? 'Filter'}
				disabled={!hasForceWrite}
				className="flex-grow"
				options={filterOptions ?? LOADING}
				allowEmpty={props.allowEmpty ?? true}
				value={props.filterId}
				onSelect={(filter) => props.onSelect(filter ?? null)}
			>
				{props.children}
			</ComboBox>
			{props.filterId && (
				<a className={buttonVariants({ variant: 'ghost', size: 'icon' })} target="_blank" href={AR.link('/filters/:id', props.filterId)}>
					<Icons.Edit />
				</a>
			)}
		</div>
	)
}
