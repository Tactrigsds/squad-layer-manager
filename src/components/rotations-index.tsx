import { Link } from '@tanstack/react-router'
import * as dateFns from 'date-fns'
import * as Icons from 'lucide-react'
import React from 'react'

import { PermissionDeniedTooltip } from '@/components/permission-denied-tooltip'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '@/components/ui/context-menu'
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useDebounced } from '@/hooks/use-debounce'
import * as DH from '@/lib/display-helpers'
import { toast } from '@/lib/toast'
import * as Typo from '@/lib/typography'
import { cn, STRETCHED_LINK } from '@/lib/utils'
import * as Zus from '@/lib/zustand'
import * as EIDX_Msgs from '@/messages/entity-index.messages'
import * as ROT_Msgs from '@/messages/rotations.messages'
import type * as LTag from '@/models/layer-tags.models'
import * as ROT from '@/models/rotations.models'
import * as RBAC from '@/rbac.models'
import * as FilterEntityClient from '@/systems/filter-entity.client'
import { tr } from '@/systems/messages.client'
import * as RbacClient from '@/systems/rbac.client'
import * as RotationClient from '@/systems/rotation.client'
import * as SettingsClient from '@/systems/settings.client'

import { MatchSnippet, OwnerFilter, SortControl } from './entity-index'
import { DeleteRotationDialog, RotationFormDialog, type RotationFormMode } from './rotation-dialogs'

const PREVIEW_ITEMS = 3

type Props = {
	search: ROT.IndexSearch
	onSearchChange: (search: ROT.IndexSearch) => void
}

export default function RotationsIndex(props: Props) {
	const { search, onSearchChange } = props
	const rotations = Zus.useStore(RotationClient.Store, RotationClient.Sel.rotations)
	const initialized = Zus.useStore(RotationClient.Store, (s) => s.initialized)
	const rotationTags = Zus.useStore(SettingsClient.PublicSettingsStore, (s) => s?.rotationTags ?? [])
	const createDenied = RbacClient.usePermsCheck(RBAC.perm('rotations:create'))
	const [dialog, setDialog] = React.useState<RotationFormMode | null>(null)

	const shown = ROT.searchRotations(rotations.values(), search, DH.toShortLayerNameFromId)
	const searching = !!search.q?.trim()
	let archivedCount = 0
	const tagCounts = new Map<LTag.TagId, number>()
	for (const rotation of rotations.values()) {
		if (rotation.archived) archivedCount++
		for (const tag of rotation.tags) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1)
	}
	const total = search.archived ? rotations.size : rotations.size - archivedCount

	const setSearch = (patch: Partial<ROT.IndexSearch>) => onSearchChange({ ...search, ...patch })
	const setQ = useDebounced({ delay: 200, onChange: (q: string) => setSearch({ q }) })

	return (
		<div className="container mx-auto py-6 px-4 space-y-4">
			<header className="flex flex-wrap items-center gap-3 border-b pb-3">
				<div className="flex min-w-0 flex-[1_1_20rem] flex-col gap-1">
					<h2 className={Typo.H2}>{tr.text(ROT_Msgs.pageTitle())}</h2>
					<p className="max-w-3xl text-sm text-muted-foreground">{tr.text(ROT_Msgs.pageBlurb())}</p>
				</div>
				<span className="flex-1" />
				<PermissionDeniedTooltip denied={createDenied}>
					<Button variant="primary" disabled={!!createDenied} onClick={() => setDialog({ mode: 'new' })}>
						<Icons.Plus />
						{tr.text(ROT_Msgs.newRotation())}
					</Button>
				</PermissionDeniedTooltip>
			</header>

			<div className="flex flex-wrap items-start gap-6">
				<aside className="flex flex-col gap-4 w-56 max-w-full shrink-0" aria-label={tr.text(ROT_Msgs.rotationTags())}>
					<section className="space-y-1.5">
						<h3 className={Typo.Label}>{tr.text(ROT_Msgs.rotationTags())}</h3>
						<ul className="flex flex-col gap-0.5">
							{rotationTags.map((tag) => (
								<li key={tag.id}>
									<TagFilter
										tag={tag}
										count={tagCounts.get(tag.id) ?? 0}
										checked={search.tags?.includes(tag.id) ?? false}
										onCheckedChange={(checked) => {
											const tags = new Set(search.tags ?? [])
											if (checked) tags.add(tag.id)
											else tags.delete(tag.id)
											setSearch({ tags: [...tags] })
										}}
									/>
								</li>
							))}
						</ul>
						<label className="flex items-center gap-2 px-1.5 py-1 text-sm text-muted-foreground">
							<Checkbox checked={!!search.archived} onCheckedChange={(checked) => setSearch({ archived: checked })} />
							{tr.text(ROT_Msgs.showArchived())}
							<span className="text-xs">({archivedCount})</span>
						</label>
					</section>
					<OwnerFilter
						owners={Array.from(rotations.values(), (r) => r.owner)}
						value={search.author}
						onChange={(author) => setSearch({ author })}
					/>
				</aside>

				<main className="flex-[999_1_560px] min-w-0 space-y-3">
					<div className="flex flex-wrap items-center gap-2">
						<Input
							className="flex-[1_1_280px]"
							aria-label={tr.text(ROT_Msgs.searchLabel())}
							placeholder={tr.text(ROT_Msgs.searchPlaceholder())}
							defaultValue={search.q ?? ''}
							onChange={(e) => setQ(e.target.value)}
						/>
						<RotationSortControl search={search} setSearch={setSearch} />
					</div>
					<p className="text-sm text-muted-foreground">{tr.text(ROT_Msgs.shownCount(shown.length, total))}</p>

					{initialized && shown.length === 0 && (
						<p className="text-muted-foreground">{tr.text(rotations.size === 0 ? ROT_Msgs.noRotations() : ROT_Msgs.noMatches())}</p>
					)}
					{searching ? (
						<ul className="flex flex-col divide-y rounded border bg-card">
							{shown.map((rotation) => (
								<RotationRow
									key={rotation.id}
									rotation={rotation}
									query={search.q!.trim()}
									onClone={() => setDialog({ mode: 'clone', source: rotation })}
								/>
							))}
						</ul>
					) : (
						<ul className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(min(100%,26rem),1fr))]">
							{shown.map((rotation) => (
								<RotationCard
									key={rotation.id}
									rotation={rotation}
									onClone={() => setDialog({ mode: 'clone', source: rotation })}
								/>
							))}
						</ul>
					)}
				</main>
			</div>
			{dialog && <RotationFormDialog {...dialog} open onOpenChange={(open) => !open && setDialog(null)} />}
		</div>
	)
}

function TagFilter(props: { tag: LTag.Tag; count: number; checked: boolean; onCheckedChange: (checked: boolean) => void }) {
	return (
		<label className={cn('flex items-center gap-2 rounded px-1.5 py-1 text-sm', props.checked && 'bg-accent')}>
			<Checkbox checked={props.checked} onCheckedChange={(checked) => props.onCheckedChange(checked)} />
			<span className="h-2 w-2 shrink-0 rounded-sm" style={{ backgroundColor: props.tag.color }} />
			<span className="flex-1 truncate">{props.tag.label}</span>
			<span className="text-xs text-muted-foreground">{props.count}</span>
		</label>
	)
}

function RotationSortControl(props: { search: ROT.IndexSearch; setSearch: (patch: Partial<ROT.IndexSearch>) => void }) {
	const sort = props.search.sort ?? 'modified'
	const labels: Record<ROT.IndexSort, string> = {
		modified: tr.text(ROT_Msgs.sortModified()),
		created: tr.text(ROT_Msgs.sortCreated()),
		name: tr.text(ROT_Msgs.sortName()),
	}
	return (
		<SortControl
			options={ROT.INDEX_SORT.options.map((value) => ({ value, label: labels[value] }))}
			sort={sort}
			dir={props.search.dir ?? ROT.defaultDir(sort)}
			onSortChange={(next) => props.setSearch({ sort: next, dir: ROT.defaultDir(next) })}
			onDirChange={(dir) => props.setSearch({ dir })}
		/>
	)
}

function TagChips(props: { tagIds: string[]; dots?: boolean }) {
	const rotationTags = Zus.useStore(SettingsClient.PublicSettingsStore, (s) => s?.rotationTags ?? [])
	const tags = props.tagIds.flatMap((id) => rotationTags.find((t) => t.id === id) ?? [])
	if (props.dots) {
		return (
			<span className="relative inline-flex items-center gap-1">
				{tags.map((tag) => (
					<span key={tag.id} title={tag.label} className="h-2 w-2 rounded-sm" style={{ backgroundColor: tag.color }} />
				))}
			</span>
		)
	}
	return (
		<span className="flex flex-wrap gap-1.5">
			{tags.map((tag) => (
				<span key={tag.id} className="rounded-sm border px-1.5 text-xs" style={{ color: tag.color, borderColor: tag.color }}>
					{tag.label}
				</span>
			))}
		</span>
	)
}

type RotationMenuSlots = {
	Item: React.FunctionComponent<{ children?: React.ReactNode; className?: string; disabled?: boolean; onClick?: () => void }>
	Separator: React.ComponentType
}

const dropdownSlots: RotationMenuSlots = { Item: DropdownMenuItem, Separator: DropdownMenuSeparator }
const contextSlots: RotationMenuSlots = { Item: ContextMenuItem, Separator: ContextMenuSeparator }

// what can be done to a rotation from its card or row: the ellipsis menu and the right-click menu hold the same entries
function RotationMenuItems(props: { rotation: ROT.Rotation; slots: RotationMenuSlots; onClone: () => void; onDelete: () => void }) {
	const { rotation } = props
	const { Item, Separator } = props.slots
	const createDenied = RbacClient.usePermsCheck(RBAC.perm('rotations:create'))
	const writeDenied = RbacClient.usePermsCheck(RBAC.getWritePermReqForRotation(rotation.id))
	const manageDenied = RbacClient.usePermsCheck(RBAC.getManagePermReqForRotation(rotation.id))
	const copyLink = () => {
		void navigator.clipboard.writeText(new URL(`/rotations/${rotation.id}`, window.location.origin).toString())
		toast(...tr.toast(EIDX_Msgs.linkCopied()))
	}
	return (
		<>
			<Item disabled={!!createDenied} onClick={props.onClone}>
				<Icons.Copy />
				{tr.text(ROT_Msgs.clone())}
			</Item>
			<Item onClick={copyLink}>
				<Icons.Link />
				{tr.text(EIDX_Msgs.copyLink())}
			</Item>
			<Item
				disabled={!!writeDenied}
				onClick={() => void RotationClient.Actions.updateMeta(rotation.id, { archived: !rotation.archived })}
			>
				<Icons.Archive />
				{tr.text(rotation.archived ? ROT_Msgs.unarchive() : ROT_Msgs.archive())}
			</Item>
			<Separator />
			<Item disabled={!!manageDenied} className="text-destructive" onClick={props.onDelete}>
				<Icons.Trash />
				{tr.text(ROT_Msgs.deleteRotation())}
			</Item>
		</>
	)
}

// right-clicking the card or row opens the same entries as its ellipsis; the delete confirmation serves both
function RotationMenus(props: { rotation: ROT.Rotation; onClone: () => void; children: (onDelete: () => void) => React.ReactNode }) {
	const [deleting, setDeleting] = React.useState(false)
	const onDelete = () => setDeleting(true)
	return (
		<>
			<ContextMenu modal={false}>
				<ContextMenuTrigger asChild>{props.children(onDelete)}</ContextMenuTrigger>
				<ContextMenuContent>
					<RotationMenuItems rotation={props.rotation} slots={contextSlots} onClone={props.onClone} onDelete={onDelete} />
				</ContextMenuContent>
			</ContextMenu>
			<DeleteRotationDialog rotation={props.rotation} open={deleting} onOpenChange={setDeleting} />
		</>
	)
}

function RotationActions(props: { rotation: ROT.Rotation; onClone: () => void; onDelete: () => void }) {
	const createDenied = RbacClient.usePermsCheck(RBAC.perm('rotations:create'))
	return (
		<span className="relative flex shrink-0 items-center gap-1">
			<Tooltip>
				<TooltipTrigger asChild>
					<Button
						variant="outline"
						size="icon-sm"
						aria-label={tr.text(ROT_Msgs.clone())}
						disabled={!!createDenied}
						onClick={props.onClone}
					>
						<Icons.Copy />
					</Button>
				</TooltipTrigger>
				<TooltipContent>{tr.text(ROT_Msgs.clone())}</TooltipContent>
			</Tooltip>
			<DropdownMenu modal={false}>
				<DropdownMenuTrigger asChild>
					<Button variant="outline" size="icon-sm" aria-label={tr.text(EIDX_Msgs.moreActions())}>
						<Icons.EllipsisVertical />
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end">
					<RotationMenuItems rotation={props.rotation} slots={dropdownSlots} onClone={props.onClone} onDelete={props.onDelete} />
				</DropdownMenuContent>
			</DropdownMenu>
		</span>
	)
}

function RotationMeta(props: { rotation: ROT.Rotation }) {
	const { rotation } = props
	const ownerName = FilterEntityClient.useOwnerName(rotation.owner) ?? ''
	return (
		<span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
			<span>{tr.text(ROT_Msgs.itemCount(rotation.items.length))}</span>
			<span>{tr.text(ROT_Msgs.byOwner(ownerName))}</span>
			<span>{tr.text(ROT_Msgs.modifiedAgo(dateFns.formatDistanceToNow(rotation.updatedAt, { addSuffix: true })))}</span>
			<span>{tr.text(ROT_Msgs.createdOn(dateFns.format(rotation.createdAt, 'd MMM yyyy')))}</span>
		</span>
	)
}

function RotationCard(props: { rotation: ROT.Rotation; onClone: () => void }) {
	const { rotation } = props
	return (
		<RotationMenus rotation={rotation} onClone={props.onClone}>
			{(onDelete) => (
				<li className="relative flex flex-col gap-2 rounded border bg-card p-3 hover:border-primary/50">
					<div className="flex items-center gap-2 min-w-0">
						<Link
							to="/rotations/$rotationId"
							params={{ rotationId: rotation.id }}
							className={cn('min-w-0 truncate text-base font-bold', STRETCHED_LINK)}
						>
							{rotation.name}
						</Link>
						<span className="shrink-0 font-mono text-xs text-muted-foreground">{rotation.id}</span>
						{rotation.archived && <Badge variant="secondary">{tr.text(ROT_Msgs.archivedBadge())}</Badge>}
						<span className="flex-1" />
						<RotationActions rotation={rotation} onClone={props.onClone} onDelete={onDelete} />
					</div>
					{rotation.description && <p className="line-clamp-2 text-sm text-muted-foreground">{rotation.description}</p>}
					<TagChips tagIds={rotation.tags} />
					{rotation.items.length > 0 && (
						<ol className="flex flex-col gap-0.5 rounded bg-background px-2 py-1.5 text-xs">
							{rotation.items.slice(0, PREVIEW_ITEMS).map((item, i) => (
								<li key={item.itemId} className="flex gap-2 truncate">
									<span className="w-4 shrink-0 text-end text-muted-foreground">{i + 1}</span>
									<span className="truncate">{DH.toShortLayerNameFromId(item.layerId)}</span>
								</li>
							))}
							{rotation.items.length > PREVIEW_ITEMS && (
								<li className="ps-6 text-muted-foreground">{tr.text(ROT_Msgs.moreItems(rotation.items.length - PREVIEW_ITEMS))}</li>
							)}
						</ol>
					)}
					<RotationMeta rotation={rotation} />
				</li>
			)}
		</RotationMenus>
	)
}

// the first part of the rotation that matches the query, with the match marked
function matchSnippet(rotation: ROT.Rotation, query: string): { prefix: string; before: string; hit: string; after: string } | null {
	const q = query.toLowerCase()
	const candidates: { prefix: string; text: string }[] = [
		{ prefix: '', text: rotation.name },
		{ prefix: '', text: rotation.description ?? '' },
		...rotation.items.map((item, i) => ({ prefix: `#${i + 1}`, text: DH.toShortLayerNameFromId(item.layerId) })),
	]
	for (const { prefix, text } of candidates) {
		const at = text.toLowerCase().indexOf(q)
		if (at === -1) continue
		return { prefix, before: text.slice(0, at), hit: text.slice(at, at + q.length), after: text.slice(at + q.length) }
	}
	return null
}

function RotationRow(props: { rotation: ROT.Rotation; query: string; onClone: () => void }) {
	const { rotation } = props
	const snippet = matchSnippet(rotation, props.query)
	return (
		<RotationMenus rotation={rotation} onClone={props.onClone}>
			{(onDelete) => (
				<li className="relative flex flex-wrap items-center gap-3 px-3 py-2 hover:bg-accent/40">
					<div className="flex min-w-0 flex-[1_1_16rem] flex-col gap-0.5">
						<span className="flex min-w-0 items-baseline gap-2">
							<Link
								to="/rotations/$rotationId"
								params={{ rotationId: rotation.id }}
								className={cn('truncate font-bold', STRETCHED_LINK)}
							>
								{rotation.name}
							</Link>
							<span className="shrink-0 font-mono text-xs text-muted-foreground">{rotation.id}</span>
							<TagChips tagIds={rotation.tags} dots />
						</span>
						{rotation.description && <span className="truncate text-xs text-muted-foreground">{rotation.description}</span>}
					</div>
					{snippet && <MatchSnippet {...snippet} />}
					<RotationMeta rotation={rotation} />
					<RotationActions rotation={rotation} onClone={props.onClone} onDelete={onDelete} />
				</li>
			)}
		</RotationMenus>
	)
}
