import { Link } from '@tanstack/react-router'
import * as Icons from 'lucide-react'

import * as Typo from '@/lib/typography'
import { cn } from '@/lib/utils'
import * as Zus from '@/lib/zustand'
import * as F_Msgs from '@/messages/filter.messages'
import type * as FR from '@/models/filter-references.models'
import type * as F from '@/models/filter.models'
import * as FilterEntityClient from '@/systems/filter-entity.client'
import { tr } from '@/systems/messages.client'
import * as SettingsClient from '@/systems/settings.client'

import { Badge } from './ui/badge'
import { Label } from './ui/label'

// Everything pointing at a filter, and the reason its delete button is disabled. The extra filters a user has
// pulled into the applied-filters panel are deliberately absent: they are a view preference rather than a
// reference, and are dropped when the filter goes.
export function FilterReferences(props: { filterId: F.FilterEntityId }) {
	const references = FilterEntityClient.useFilterReferences().get(props.filterId) ?? []
	const fromFilters = references.filter((ref) => ref.type === 'filter-entity')
	const fromPools = references.filter((ref) => ref.type === 'pool-config')

	return (
		<section aria-label={tr.text(F_Msgs.referencesHeading())} className="flex flex-col gap-2">
			<div className="flex items-center gap-2">
				<h4 className={Typo.H4}>{tr.text(F_Msgs.referencesHeading())}</h4>
				<Badge variant={references.length > 0 ? 'secondary' : 'outline'}>{tr.text(F_Msgs.referenceCount(references.length))}</Badge>
			</div>
			{references.length === 0 ? (
				<p className="text-sm text-muted-foreground">{tr.text(F_Msgs.noReferences())}</p>
			) : (
				<>
					<p className="text-sm text-muted-foreground">{tr.text(F_Msgs.referencesBlurb())}</p>
					{fromFilters.length > 0 && (
						<div className="flex items-center gap-2 flex-wrap">
							<Label className={Typo.Label}>{tr.text(F_Msgs.referencingFiltersLabel())}</Label>
							{fromFilters.map((ref) => (
								<FilterReferenceBadge key={ref.filterId} filterId={ref.filterId} />
							))}
						</div>
					)}
					{fromPools.length > 0 && (
						<div className="flex items-center gap-2 flex-wrap">
							<Label className={Typo.Label}>{tr.text(F_Msgs.referencingPoolsLabel())}</Label>
							{fromPools.map((ref) => (
								<PoolReferenceBadge key={`${ref.serverId}:${ref.key}:${ref.via.join('>')}`} reference={ref} />
							))}
						</div>
					)}
				</>
			)}
		</section>
	)
}

function FilterReferenceBadge(props: { filterId: F.FilterEntityId }) {
	const filter = FilterEntityClient.useFilterEntities().get(props.filterId)
	return (
		<Link to="/filters/$filterId" params={{ filterId: props.filterId }}>
			<Badge variant="secondary">{filter?.name ?? props.filterId}</Badge>
		</Link>
	)
}

function PoolReferenceBadge(props: { reference: Extract<FR.Reference, { type: 'pool-config' }> }) {
	const serverName = Zus.useStore(
		SettingsClient.PublicSettingsStore,
		(settings) => settings?.servers.find((entry) => entry.id === props.reference.serverId)?.displayName,
	)
	const via = props.reference.via
	return (
		<Link to="/servers/$serverId" params={{ serverId: props.reference.serverId }}>
			<Badge variant="secondary" className="gap-1">
				<span>{serverName ?? props.reference.serverId}</span>
				<Icons.Dot className="h-3 w-3" />
				<span>{tr.text(F_Msgs.poolConfigKeyNames[props.reference.key])}</span>
				{via.length > 0 && <span className="font-normal opacity-70">{tr.text(F_Msgs.referenceVia(via.join(' -> ')))}</span>}
			</Badge>
		</Link>
	)
}

// the count as it appears on a filter's card in the index, silent when nothing references the filter
export function FilterReferenceCount(props: { filterId: F.FilterEntityId; className?: string }) {
	const references = FilterEntityClient.useFilterReferences().get(props.filterId) ?? []
	if (references.length === 0) return null
	const inPool = references.some((ref) => ref.type === 'pool-config')
	return (
		<Badge variant="secondary" className={cn('flex items-center gap-1.5', props.className)}>
			{inPool ? <Icons.Layers className="h-3 w-3" /> : <Icons.Link className="h-3 w-3" />}
			<span>{tr.text(F_Msgs.referenceCount(references.length))}</span>
		</Badge>
	)
}
