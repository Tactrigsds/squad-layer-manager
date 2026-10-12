import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import * as Icons from 'lucide-react'
import React from 'react'

import { MatchSnippet, OwnerFilter, SortControl } from '@/components/entity-index'
import { CloneFilterDialog } from '@/components/filter-clone-dialog'
import { PermissionDeniedTooltip, ReasonTooltip } from '@/components/permission-denied-tooltip'
import { RequireAccess } from '@/components/require-access'
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '@/components/ui/context-menu'
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { useDebounced } from '@/hooks/use-debounce'
import { toast } from '@/lib/toast'
import * as Typo from '@/lib/typography'
import { cn, STRETCHED_LINK } from '@/lib/utils'
import * as EIDX_Msgs from '@/messages/entity-index.messages'
import * as F_Msgs from '@/messages/filter.messages'
import * as FIDX from '@/models/filter-index.models'
import * as FR from '@/models/filter-references.models'
import * as F from '@/models/filter.models'
import * as RBAC from '@/rbac.models'
import * as FilterEntityClient from '@/systems/filter-entity.client'
import { tr } from '@/systems/messages.client'
import * as PartsSys from '@/systems/parts.client'
import * as RbacClient from '@/systems/rbac.client'

import EmojiDisplay from './emoji-display'
import { FilterPoolFilterFor, FilterReferenceCount } from './filter-references'
import { Avatar, AvatarFallback, AvatarImage } from './ui/avatar'
import { Badge } from './ui/badge'
import { Button, buttonVariants } from './ui/button'
import { Label } from './ui/label'

type MenuSlots = {
	Item: React.FunctionComponent<{ children?: React.ReactNode; className?: string; disabled?: boolean; onClick?: () => void }>
	Separator: React.ComponentType
}

const dropdownSlots: MenuSlots = { Item: DropdownMenuItem, Separator: DropdownMenuSeparator }
const contextSlots: MenuSlots = { Item: ContextMenuItem, Separator: ContextMenuSeparator }

// what can be done to a filter from its card or row: the ellipsis menu and the right-click menu hold the same entries
function FilterMenuItems(props: { filter: F.FilterEntity; slots: MenuSlots; onClone: () => void; onDelete: () => void }) {
	const { Item, Separator } = props.slots
	const writeDenied = RbacClient.usePermsCheck(RBAC.getWritePermReqForFilterEntity(props.filter.id))
	const createDenied = RbacClient.useAccess('filters.createFilter')
	const referenced = (FilterEntityClient.useFilterReferences().get(props.filter.id)?.length ?? 0) > 0
	const copyLink = () => {
		void navigator.clipboard.writeText(new URL(`/filters/${props.filter.id}`, window.location.origin).toString())
		toast(...tr.toast(EIDX_Msgs.linkCopied()))
	}
	return (
		<>
			<PermissionDeniedTooltip denied={createDenied} triggerClassName="block">
				<Item disabled={!!createDenied} onClick={props.onClone}>
					<Icons.Copy />
					{tr.text(F_Msgs.clone())}
				</Item>
			</PermissionDeniedTooltip>
			<Item onClick={copyLink}>
				<Icons.Link />
				{tr.text(EIDX_Msgs.copyLink())}
			</Item>
			<Separator />
			<PermissionDeniedTooltip denied={writeDenied} triggerClassName="block">
				<ReasonTooltip
					heading={tr.text(F_Msgs.cannotDelete())}
					reason={!writeDenied && referenced ? tr.text(F_Msgs.deleteBlockedByReferences()) : null}
					triggerClassName="block"
				>
					<Item disabled={!!writeDenied || referenced} className="text-destructive" onClick={props.onDelete}>
						<Icons.Trash />
						{tr.text(F_Msgs.deleteAction())}
					</Item>
				</ReasonTooltip>
			</PermissionDeniedTooltip>
		</>
	)
}

// right-clicking a card or row opens the same entries as its ellipsis; the delete confirmation serves both
function FilterMenus(props: { filter: F.FilterEntity; children: (actions: MenuActions) => React.ReactNode }) {
	const [deleting, setDeleting] = React.useState(false)
	const [cloning, setCloning] = React.useState(false)
	const actions: MenuActions = { onClone: () => setCloning(true), onDelete: () => setDeleting(true) }
	const deleteMutation = FilterEntityClient.useFilterDelete()
	const confirmDelete = async () => {
		const res = await deleteMutation.mutateAsync(props.filter.id)
		if (res.code === 'ok') toast(...tr.toast(F_Msgs.deleted(props.filter.name)))
		else toast.error(...tr.toast(F_Msgs.deleteFailed(props.filter.name, res)))
	}
	return (
		<>
			<ContextMenu modal={false}>
				<ContextMenuTrigger asChild>{props.children(actions)}</ContextMenuTrigger>
				<ContextMenuContent>
					<FilterMenuItems filter={props.filter} slots={contextSlots} {...actions} />
				</ContextMenuContent>
			</ContextMenu>
			{cloning && <CloneFilterDialog source={props.filter} onClose={() => setCloning(false)} />}
			<AlertDialog open={deleting} onOpenChange={setDeleting}>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>{tr.text(F_Msgs.confirmDeleteTitle())}</AlertDialogTitle>
						<AlertDialogDescription>{tr.text(F_Msgs.confirmDeleteBlurb())}</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>{tr.text(F_Msgs.cancel())}</AlertDialogCancel>
						<AlertDialogAction variant="destructive" onClick={() => void confirmDelete()}>
							<Icons.Trash />
							{tr.text(F_Msgs.deleteAction())}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</>
	)
}

type MenuActions = { onClone: () => void; onDelete: () => void }

function FilterActions(props: { filter: F.FilterEntity } & MenuActions) {
	return (
		<DropdownMenu modal={false}>
			<DropdownMenuTrigger asChild>
				<Button variant="outline" size="icon-sm" className="relative" aria-label={tr.text(EIDX_Msgs.moreActions())}>
					<Icons.EllipsisVertical />
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end">
				<FilterMenuItems filter={props.filter} slots={dropdownSlots} onClone={props.onClone} onDelete={props.onDelete} />
			</DropdownMenuContent>
		</DropdownMenu>
	)
}

function OwnerBadge(props: { owner: F.FilterOwner }) {
	const ownerUserId = F.ownerUserId(props.owner)
	const user = ownerUserId !== null ? PartsSys.findUser(ownerUserId) : undefined
	const ownerName = FilterEntityClient.useOwnerName(props.owner, user)
	if (user) {
		return (
			<Badge variant="secondary" className="flex items-center gap-1.5">
				<Avatar style={{ backgroundColor: user.displayHexColor ?? undefined }} className="select-none h-5 w-5 shrink-0">
					<AvatarImage src={user.avatarUrl} crossOrigin="anonymous" />
					<AvatarFallback className="text-xs">{user.displayName.slice(0, 2).toUpperCase()}</AvatarFallback>
				</Avatar>
				<span>{user.displayName}</span>
			</Badge>
		)
	}
	return <Badge variant="secondary">{ownerName}</Badge>
}

function FilterTitle(props: { filter: F.FilterEntity }) {
	return (
		<Link
			to="/filters/$filterId"
			params={{ filterId: props.filter.id }}
			className={cn('min-w-0 max-w-full truncate font-bold', STRETCHED_LINK)}
		>
			{props.filter.name}
		</Link>
	)
}

function FilterCard(props: { filter: F.FilterEntity }) {
	const { filter } = props
	const rolesRes = useQuery(FilterEntityClient.getAllFilterRoleContributorsBase())
	const roles = rolesRes.data?.filter((role) => role.filterId === filter.id)
	return (
		<FilterMenus filter={filter}>
			{(actions) => (
				<li className="relative flex gap-3 rounded border bg-card p-3 hover:border-primary/50">
					{filter.emoji && (
						<span className="shrink-0">
							<EmojiDisplay emoji={filter.emoji} />
						</span>
					)}
					<div className="flex min-w-0 flex-1 flex-col gap-2">
						<div className="flex min-w-0 items-start gap-2">
							<div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
								<FilterTitle filter={filter} />
								<span className="relative flex flex-wrap items-center gap-1.5">
									<FilterReferenceCount filterId={filter.id} />
									<FilterPoolFilterFor filterId={filter.id} />
								</span>
							</div>
							<FilterActions filter={filter} {...actions} />
						</div>
						{filter.description && <p className="line-clamp-2 text-sm text-muted-foreground">{filter.description.split('\n')[0]}</p>}
						<div className="flex flex-wrap items-center gap-4">
							<div className="flex items-center gap-2">
								<Label className={Typo.Label}>{tr.text(F_Msgs.ownerLabel())}</Label>
								<OwnerBadge owner={filter.owner} />
							</div>
							{roles && roles.length > 0 && (
								<div className="flex items-center gap-2">
									<Label className={Typo.Label}>{tr.text(F_Msgs.contributorsLabel())}</Label>
									<div className="flex flex-wrap gap-1.5">
										{roles.map((role) => (
											<Badge key={role.roleId} variant="secondary">
												{role.roleId}
											</Badge>
										))}
									</div>
								</div>
							)}
						</div>
					</div>
				</li>
			)}
		</FilterMenus>
	)
}

function FilterRow(props: { filter: F.FilterEntity; query: string }) {
	const { filter } = props
	const snippet = FIDX.matchSnippet(filter, props.query)
	return (
		<FilterMenus filter={filter}>
			{(actions) => (
				<li className="relative flex flex-wrap items-center gap-3 px-3 py-2 hover:bg-accent/40">
					<div className="flex min-w-0 flex-[1_1_16rem] items-center gap-2">
						{filter.emoji && <EmojiDisplay emoji={filter.emoji} />}
						<FilterTitle filter={filter} />
					</div>
					{snippet && <MatchSnippet {...snippet} />}
					<OwnerBadge owner={filter.owner} />
					<FilterActions filter={filter} {...actions} />
				</li>
			)}
		</FilterMenus>
	)
}

function NewFilterDenied({ denied }: { denied: RBAC.PermissionDeniedResponse }) {
	return (
		<PermissionDeniedTooltip denied={denied}>
			<span className={cn(buttonVariants({ variant: 'secondary' }), 'pointer-events-none opacity-50')}>
				<Icons.Plus />
				<span>{tr.text(F_Msgs.newFilter())}</span>
			</span>
		</PermissionDeniedTooltip>
	)
}

export default function FiltersIndex(props: { search: FIDX.IndexSearch; onSearchChange: (search: FIDX.IndexSearch) => void }) {
	const { search, onSearchChange } = props
	const filterEntities = FilterEntityClient.useFilterEntities()
	const references = FilterEntityClient.useFilterReferences()
	const isPoolFilter = (filter: F.FilterEntity) => (references.get(filter.id) ?? []).some(FR.isPoolFilterReference)
	const shown = FIDX.searchFilters(filterEntities.values(), search, isPoolFilter)
	const searching = !!search.q?.trim()
	const setSearch = (patch: Partial<FIDX.IndexSearch>) => onSearchChange({ ...search, ...patch })
	const setQ = useDebounced({ delay: 200, onChange: (q: string) => setSearch({ q }) })
	const sortLabels: Record<FIDX.IndexSort, string> = { default: tr.text(F_Msgs.sortDefault()), name: tr.text(F_Msgs.sortName()) }

	return (
		<div className="container mx-auto space-y-4 px-4 py-6">
			<header className="flex flex-wrap items-center gap-3 border-b pb-3">
				<div className="flex min-w-0 flex-[1_1_20rem] flex-col gap-1">
					<h2 className={Typo.H2}>{tr.text(F_Msgs.filtersHeading())}</h2>
					<p className="max-w-3xl text-sm text-muted-foreground">{tr.text(F_Msgs.pageBlurb())}</p>
				</div>
				<RequireAccess page="/_app/filters/new" fallback={NewFilterDenied}>
					<Link className={buttonVariants({ variant: 'secondary' })} to="/filters/new">
						<Icons.Plus />
						<span>{tr.text(F_Msgs.newFilter())}</span>
					</Link>
				</RequireAccess>
			</header>

			<div className="flex flex-wrap items-start gap-6">
				<aside className="flex w-56 max-w-full shrink-0 flex-col gap-4">
					<OwnerFilter
						owners={Array.from(filterEntities.values(), (filter) => filter.owner)}
						value={search.author}
						onChange={(author) => setSearch({ author })}
					/>
				</aside>
				<main className="min-w-0 flex-[999_1_560px] space-y-3">
					<div className="flex flex-wrap items-center gap-2">
						<Input
							className="flex-[1_1_280px]"
							aria-label={tr.text(F_Msgs.searchLabel())}
							placeholder={tr.text(F_Msgs.searchPlaceholder())}
							defaultValue={search.q ?? ''}
							onChange={(e) => setQ(e.target.value)}
						/>
						<SortControl
							options={FIDX.INDEX_SORT.options.map((value) => ({ value, label: sortLabels[value] }))}
							sort={search.sort ?? 'default'}
							dir={search.dir ?? 'asc'}
							onSortChange={(sort) => setSearch({ sort, dir: 'asc' })}
							onDirChange={(dir) => setSearch({ dir })}
						/>
					</div>
					<p className="text-sm text-muted-foreground">{tr.text(F_Msgs.shownCount(shown.length, filterEntities.size))}</p>
					{shown.length === 0 && filterEntities.size > 0 && <p className="text-muted-foreground">{tr.text(F_Msgs.noMatches())}</p>}
					{searching ? (
						<ul className="flex flex-col divide-y rounded border bg-card">
							{shown.map((filter) => (
								<FilterRow key={filter.id} filter={filter} query={search.q!.trim()} />
							))}
						</ul>
					) : (
						<ul className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,24rem),1fr))] gap-3">
							{shown.map((filter) => (
								<FilterCard key={filter.id} filter={filter} />
							))}
						</ul>
					)}
				</main>
			</div>
		</div>
	)
}
