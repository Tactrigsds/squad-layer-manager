// Controls shared by the index pages that list saved entities, such as filters and rotations
import * as Icons from 'lucide-react'
import React from 'react'

import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import * as Typo from '@/lib/typography'
import * as EIDX_Msgs from '@/messages/entity-index.messages'
import * as F from '@/models/filter.models'
import * as FilterEntityClient from '@/systems/filter-entity.client'
import { tr } from '@/systems/messages.client'

const ANY_OWNER = '__any__'

// narrows the list to one owner, keyed by F.ownerKey
export function OwnerFilter(props: {
	owners: Iterable<F.FilterOwner>
	value: string | undefined
	onChange: (owner: string | undefined) => void
}) {
	const id = React.useId()
	const owners = new Map<string, F.FilterOwner>()
	for (const owner of props.owners) owners.set(F.ownerKey(owner), owner)
	return (
		<section className="space-y-1.5">
			<Label htmlFor={id} className={Typo.Label}>
				{tr.text(EIDX_Msgs.author())}
			</Label>
			<Select value={props.value ?? ANY_OWNER} onValueChange={(value) => props.onChange(value === ANY_OWNER ? undefined : value)}>
				<SelectTrigger id={id} className="w-full">
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					<SelectItem value={ANY_OWNER}>{tr.text(EIDX_Msgs.anyAuthor())}</SelectItem>
					{Array.from(owners, ([key, owner]) => (
						<OwnerOption key={key} value={key} owner={owner} />
					))}
				</SelectContent>
			</Select>
		</section>
	)
}

function OwnerOption(props: { value: string; owner: F.FilterOwner }) {
	const name = FilterEntityClient.useOwnerName(props.owner) ?? ''
	return <SelectItem value={props.value}>{name}</SelectItem>
}

// picks what the list is ordered by, and which way
export function SortControl<S extends string>(props: {
	options: { value: S; label: string }[]
	sort: S
	dir: 'asc' | 'desc'
	onSortChange: (sort: S) => void
	onDirChange: (dir: 'asc' | 'desc') => void
}) {
	const id = React.useId()
	const dirLabel = tr.text(props.dir === 'asc' ? EIDX_Msgs.ascending() : EIDX_Msgs.descending())
	return (
		<span className="flex items-center gap-1.5">
			<Label htmlFor={id} className={Typo.Label}>
				{tr.text(EIDX_Msgs.sort())}
			</Label>
			<Select value={props.sort} onValueChange={(value) => props.onSortChange(value as S)}>
				<SelectTrigger id={id} className="w-auto min-w-40">
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					{props.options.map((option) => (
						<SelectItem key={option.value} value={option.value}>
							{option.label}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
			<Button
				variant="outline"
				size="icon-sm"
				aria-label={dirLabel}
				title={dirLabel}
				onClick={() => props.onDirChange(props.dir === 'asc' ? 'desc' : 'asc')}
			>
				{props.dir === 'asc' ? <Icons.ArrowUp /> : <Icons.ArrowDown />}
			</Button>
		</span>
	)
}

// a search result's matching part, with the match marked
export function MatchSnippet(props: { prefix?: string; before: string; hit: string; after: string }) {
	return (
		<span className="min-w-0 flex-[1_1_14rem] truncate text-xs">
			<span className={`${Typo.Label} me-1`}>{tr.text(EIDX_Msgs.matchedOn())}</span>
			{props.prefix && <span className="me-1 text-muted-foreground">{props.prefix}</span>}
			{props.before}
			<mark className="rounded-sm bg-primary/30 text-foreground">{props.hit}</mark>
			{props.after}
		</span>
	)
}
