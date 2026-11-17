import { useMutation, useQuery } from '@tanstack/react-query'
import { useBlocker } from '@tanstack/react-router'
import { useNavigate } from '@tanstack/react-router'
import * as Icons from 'lucide-react'
import { useState } from 'react'
import React from 'react'

import * as Typo from '@/components/typography'
import {
	AlertDialog,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import * as EditFrame from '@/frames/filter-editor.frame.ts'
import { toast } from '@/lib/toast'
import { assertNever } from '@/lib/type-guards'
import * as Zus from '@/lib/zustand'
import * as F_Msgs from '@/messages/filter.messages'
import * as F from '@/models/filter.models'
import * as UP from '@/models/user-presence.models'
import type * as USR from '@/models/users.models'
import * as RPC from '@/orpc.client'
import * as RBAC from '@/rbac.models'
import * as FilterEntityClient from '@/systems/filter-entity.client'
import { tr } from '@/systems/messages.client'
import * as RbacClient from '@/systems/rbac.client'
import * as UPClient from '@/systems/user-presence.client'
import * as UsersClient from '@/systems/users.client'

import { ContributorsPopover } from './contributors-popover'
import { EditDetailsButton, EditDetailsDialog } from './edit-details-dialog'
import EmojiDisplay from './emoji-display'
import FilterCard from './filter-card'
import { CloneFilterDialog } from './filter-clone-dialog'
import { FilterDetailsForm } from './filter-details-form'
import { FilterProblemCountBadge, FilterValidationErrorDisplay } from './filter-extra-errors'
import { FilterReferences } from './filter-references'
import LayerTable from './layer-table'
import { MarkdownDescription } from './markdown-description'
import { PermissionDeniedTooltip, ReasonTooltip } from './permission-denied-tooltip'
import { Badge } from './ui/badge'
import { Separator } from './ui/separator'
import UserPresencePanel, { sortEditingPresence } from './user-presence-panel'

export function FilterEdit(props: { entity: F.FilterEntity; owner: USR.User | undefined; stores: EditFrame.KeyProp }) {
	const stores = props.stores

	const navigate = useNavigate()

	const [detailsOpen, setDetailsOpen] = useState(false)
	const meta = Zus.useStore(stores.filterEditor, (s) => s.meta)

	const presenceEvent$ = Zus.useStore(stores.filterEditor, (s) => s.presenceEvent$)

	const loggedInUser = UsersClient.useLoggedInUser()

	const onDelete = React.useCallback(async () => {
		if (!props.entity) {
			return
		}
		const res = await FilterEntityClient.deleteFilter(props.entity.id)
		if (res.code === 'ok') {
			toast(...tr.toast(F_Msgs.deleted(props.entity.name)))
			void navigate({ to: '/filters', ignoreBlocker: true })
		} else {
			toast.error(...tr.toast(F_Msgs.deleteFailed(props.entity.name, res)))
		}
	}, [navigate, props.entity])

	const canEditRes = RbacClient.usePermsCheck(RBAC.getWritePermReqForFilterEntity(props.entity.id))
	const permitWriteAll = !RbacClient.usePermsCheck(RBAC.perm('filters:write-all'))?.code
	const loggedInUserRole: 'owner' | 'contributor' | '_none' | 'write-all' = (() => {
		if (!loggedInUser) return '_none'
		if (F.ownerUserId(props.entity.owner) === loggedInUser.discordId) return 'owner'
		return 'contributor'
	})()

	const permitEdit = !canEditRes?.code
	const ownerName = FilterEntityClient.useOwnerName(props.entity.owner, props.owner)

	const [filterValid, filterModified] = Zus.useStore(
		stores.filterEditor,
		Zus.useShallow((state) => [state.valid, state.modified]),
	)

	useBlocker({
		enableBeforeUnload: filterModified,
		shouldBlockFn: () => {
			if (!filterModified) return false

			const shouldLeave = confirm(tr.text(F_Msgs.unsavedChangesConfirm()))
			return !shouldLeave
		},
	})

	const saveBtn = React.useMemo(
		() => (
			<Button variant="primary" onClick={() => EditFrame.Actions.save(stores)} disabled={!filterValid || !filterModified || !permitEdit}>
				<Icons.Save />
				{tr.text(F_Msgs.save())}
			</Button>
		),
		[stores, filterValid, filterModified, permitEdit],
	)

	const referenceCount = FilterEntityClient.useFilterReferences().get(props.entity.id)?.length ?? 0

	const deleteBtn = React.useMemo(
		() => (
			<PermissionDeniedTooltip denied={canEditRes}>
				<ReasonTooltip
					heading={tr.text(F_Msgs.cannotDelete())}
					reason={permitEdit && referenceCount > 0 ? tr.text(F_Msgs.deleteBlockedByReferences()) : null}
				>
					<DeleteFilterDialog onDelete={onDelete}>
						<Button variant="destructive" disabled={!permitEdit || referenceCount > 0}>
							<Icons.Trash />
							{tr.text(F_Msgs.deleteAction())}
						</Button>
					</DeleteFilterDialog>
				</ReasonTooltip>
			</PermissionDeniedTooltip>
		),
		[onDelete, permitEdit, referenceCount, canEditRes],
	)

	const createDenied = RbacClient.useAccess('filters.createFilter')
	const [cloning, setCloning] = React.useState(false)
	const cloneBtn = React.useMemo(
		() => (
			<PermissionDeniedTooltip denied={createDenied}>
				<Button variant="outline" disabled={!!createDenied} onClick={() => setCloning(true)}>
					<Icons.Copy />
					{tr.text(F_Msgs.clone())}
				</Button>
			</PermissionDeniedTooltip>
		),
		[createDenied],
	)

	const filterCard = React.useMemo(
		() => (
			<FilterCard
				stores={stores}
				header={
					<>
						<MarkdownDescription description={meta.description} />
						<FilterReferences filterId={props.entity.id} />
						<FilterValidationErrorDisplay stores={stores} />
					</>
				}
			>
				<FilterProblemCountBadge stores={stores} />
				{saveBtn}
				{cloneBtn}
				{deleteBtn}
			</FilterCard>
		),
		[stores, deleteBtn, saveBtn, cloneBtn, meta.description, props.entity.id],
	)

	const _nodeMapStore = Zus.useStore(stores.filterEditor, (s) => s.nodeMapStore)
	const validationCurrent = Zus.useStore(stores.filterEditor, EditFrame.Sel.validationCurrent)
	const draftEditors = Zus.useStore(UPClient.Store, UPClient.Sel.filterEditingClientCount(props.entity.id))

	return (
		// marked once the warnings below reflect the current draft, and with how many clients presence counts as
		// editing the draft, for anything that has to wait on either. The server discards the draft at zero.
		<div
			className="container mx-auto flex flex-col gap-2"
			data-draft-validated={validationCurrent || undefined}
			data-draft-editors={draftEditors}
		>
			{cloning && <CloneFilterDialog source={props.entity} onClose={() => setCloning(false)} />}
			<div className="flex w-full flex-col space-y-2">
				<div className="flex items-center justify-between">
					<span className="flex items-center space-x-4">
						{meta.emoji && (
							<>
								<EmojiDisplay emoji={meta.emoji} className="text-3xl" />
								<Icons.Dot />
							</>
						)}
						<h3 className={Typo.H3}>{meta.name}</h3>
						<Icons.Dot />
						<small className="font-light">{tr.text(F_Msgs.ownerLine(ownerName ?? ''))}</small>
						<Icons.Dot />
						<EditDetailsButton denied={canEditRes} onClick={() => setDetailsOpen(true)} />
					</span>
					<span className="flex h-min items-center space-x-2 self-end">
						<UserPresencePanel
							sourcePresenceFn={sortEditingPresence}
							matchActivity={UP.Trans.onFilter(props.entity.id).match}
							statusActivities={UP.FILTER_PAGE_ACTIVITIES}
							event$={presenceEvent$}
							className="min-w-0"
						/>
						{loggedInUserRole === 'owner' && permitEdit && (
							<Badge variant="outline" className="text-nowrap border-2 border-primary">
								{tr.text(F_Msgs.accessOwner())}
							</Badge>
						)}
						{loggedInUserRole === 'contributor' && (
							<Badge variant="outline" className="text-nowrap border-2 border-info">
								{tr.text(F_Msgs.accessContributor())}
							</Badge>
						)}
						{!permitEdit && (
							<Badge variant="outline" className="text-nowrap border-2 border-destructive">
								{tr.text(F_Msgs.accessNone())}
							</Badge>
						)}
						{permitWriteAll && (
							<Badge variant="outline" className="border-success text-nowrap border-2">
								{tr.text(F_Msgs.accessAllFilters())}
							</Badge>
						)}
						<FilterContributors filterId={props.entity.id} canManage={permitEdit && (loggedInUserRole === 'owner' || permitWriteAll)}>
							<Button variant="outline">
								<Icons.Users />
								{tr.text(F_Msgs.showContributors())}
							</Button>
						</FilterContributors>
					</span>
				</div>
				<Separator orientation="horizontal" />
			</div>
			<EditDetailsDialog
				open={detailsOpen}
				onOpenChange={setDetailsOpen}
				description={tr.text(F_Msgs.detailsDialogBlurb())}
				className="max-w-5xl"
			>
				<FilterDetailsForm stores={stores} creating={false} onClose={() => setDetailsOpen(false)} />
			</EditDetailsDialog>
			{filterCard}
			<LayerTable stores={{ layerTable: stores.filterEditor }} />
		</div>
	)
}

function FilterContributors(props: {
	filterId: F.FilterEntityId
	// managing contributors is an ownership concern; contributors can view the list but not edit it
	canManage: boolean
	children: React.ReactNode
}) {
	// read live rather than through the route loader, whose data the add/remove mutations cannot invalidate
	const contributorsRes = useQuery(FilterEntityClient.getFilterContributorsBase(props.filterId))
	const contributors = contributorsRes.data
	const addMutation = useMutation(
		RPC.orpc.filters.addFilterContributor.mutationOptions({
			onSuccess: (res) => {
				switch (res.code) {
					case 'err:permission-denied':
						return RbacClient.handlePermissionDenied(res)
					case 'err:already-exists':
						return toast(...tr.toast(F_Msgs.contributorAlreadyAdded()))
					case 'err:not-found':
					case 'err:unknown-user':
						return toast.error(...tr.toast(F_Msgs.addContributorFailed(res.code)))
					case 'ok':
						break
					default:
						assertNever(res)
				}
				FilterEntityClient.invalidateQueriesForFilter(props.filterId)
			},
			onError: (err) => {
				toast.error(...tr.toast(F_Msgs.addContributorFailed(err.message)))
			},
		}),
	)
	const removeMutation = useMutation(
		RPC.orpc.filters.removeFilterContributor.mutationOptions({
			onSuccess: (res) => {
				switch (res.code) {
					case 'err:permission-denied':
						return RbacClient.handlePermissionDenied(res)
					case 'err:not-found':
						return toast(...tr.toast(F_Msgs.contributorNotFound()))
					case 'ok':
						break
					default:
						assertNever(res)
				}
				FilterEntityClient.invalidateQueriesForFilter(props.filterId)
			},
		}),
	)
	return (
		<ContributorsPopover
			contributors={contributors}
			description={tr.text(F_Msgs.contributorsBlurb())}
			canManage={props.canManage}
			onAddUser={(user) => addMutation.mutate({ filterId: props.filterId, userId: user.discordId })}
			onAddRole={(role) => addMutation.mutate({ filterId: props.filterId, roleId: role.type })}
			onRemoveUser={(userId) => removeMutation.mutate({ filterId: props.filterId, userId })}
			onRemoveRole={(roleId) => removeMutation.mutate({ filterId: props.filterId, roleId })}
		>
			{props.children}
		</ContributorsPopover>
	)
}

function DeleteFilterDialog(props: { onDelete: () => void; children: React.ReactNode }) {
	const [isOpen, setIsOpen] = useState(false)
	const onDelete = () => {
		props.onDelete()
		setIsOpen(false)
	}

	const onCancel = () => {
		setIsOpen(false)
	}

	return (
		<AlertDialog open={isOpen} onOpenChange={setIsOpen}>
			<AlertDialogTrigger asChild>{props.children}</AlertDialogTrigger>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle>{tr.text(F_Msgs.confirmDeleteTitle())}</AlertDialogTitle>
					<AlertDialogDescription>{tr.text(F_Msgs.confirmDeleteBlurb())}</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogCancel onClick={onCancel}>{tr.text(F_Msgs.cancel())}</AlertDialogCancel>
					<Button submitChord variant="destructive" onClick={onDelete}>
						<Icons.Trash />
						{tr.text(F_Msgs.deleteAction())}
					</Button>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	)
}
