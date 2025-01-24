import * as Form from '@tanstack/react-form'
import deepEqual from 'fast-deep-equal'
import * as RbacClient from '@/systems.client/rbac.client'
import * as Messages from '@/messages'
import { useMemo, useState } from 'react'
import * as Icons from 'lucide-react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import * as Users from '@/systems.client/users.client'
import { ToggleFilterContributorInput } from '@/server/systems/filters-entity'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'
import { Command, CommandInput, CommandItem, CommandList } from './ui/command'

import * as AR from '@/app-routes.ts'
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
import { Input } from '@/components/ui/input'
import useAppParams from '@/hooks/use-app-params'
import { useToast } from '@/hooks/use-toast'
import * as EFB from '@/lib/editable-filter-builders.ts'
import * as Typography from '@/lib/typography'
import * as M from '@/models.ts'

import FilterCard from './filter-card'
import FullPageSpinner from './full-page-spinner'
import LayerTable from './layer-table'
import { Alert, AlertDescription, AlertTitle } from './ui/alert'
import { Label } from './ui/label'
import { Textarea } from './ui/textarea'
import React from 'react'
import { useLoggedInUser } from '@/systems.client/logged-in-user'
import { assertNever } from '@/lib/typeGuards'
import {
	filterUpdate$ as getFilterUpdate$,
	getFilterEntity$,
	useFilterUpdate,
	useFilterDelete,
	useFilterContributors,
	getFilterContributorQueryKey,
} from '@/hooks/filters'
import { useUser } from '@/systems.client/users.client'
import { cn } from '@/lib/utils'
import { CardContent, CardDescription, CardHeader, CardTitle } from './ui/card'
import { Badge } from './ui/badge'
import { trpc } from '@/lib/trpc.client'
import { Subscribe, useStateObservable } from '@react-rxjs/core'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'
import { isDirty } from 'zod'
import { Separator } from '@radix-ui/react-separator'

// https://4.bp.blogspot.com/_7G6ciJUMuAk/TGOJCxnXBYI/AAAAAAAABY8/drhyu0NLBdY/w1200-h630-p-k-no-nu/yo+dawg+1.jpg
export default function FilterWrapperWrapper() {
	const editParams = useAppParams('/filters/:id/edit')
	return (
		<Subscribe source$={getFilterEntity$(editParams.id)}>
			<FilterWrapper />
		</Subscribe>
	)
}
export function FilterWrapper() {
	// could also be /filters/new, in which case we're creating a new filter and id is undefined
	const editParams = useAppParams('/filters/:id/edit')
	const { toast } = useToast()
	const loggedInUser = useLoggedInUser()
	const navigate = useNavigate()
	const filterEntity = useStateObservable(getFilterEntity$(editParams.id))
	React.useEffect(() => {
		const sub = getFilterUpdate$(editParams.id).subscribe((update) => {
			if (!update) return
			switch (update.code) {
				case 'err:not-found':
					toast({ title: 'Filter not found' })
					navigate(AR.exists('/filters'))
					return
				case 'initial-value':
					return
				case 'mutation':
					break
				default:
					assertNever(update)
			}
			const mutation = update.mutation
			switch (mutation.type) {
				case 'add':
					break
				case 'update': {
					if (mutation.username === loggedInUser?.username) return
					toast({
						title: `Filter ${mutation.value.name} was updated by ${mutation.username}`,
					})
					break
				}
				case 'delete': {
					if (mutation.username === loggedInUser?.username) return
					toast({
						title: `Filter ${mutation.value.name} was deleted by ${mutation.username}`,
					})
					navigate(AR.exists('/filters'))
					break
				}
				default:
					assertNever(mutation.type)
			}
			return () => sub.unsubscribe()
		})
	}, [editParams.id, navigate, toast, loggedInUser?.username])
	const userRes = Users.useUser(filterEntity?.owner)
	const filterContributorRes = useFilterContributors(editParams.id)

	// TODO handle not found
	if (!filterEntity || !userRes.data || !filterContributorRes.data) {
		return <FullPageSpinner />
	}
	let owner: M.User
	switch (userRes.data.code) {
		case 'err:permission-denied':
			return <div>{Messages.WARNS.permissionDenied(userRes.data)}</div>
		case 'err:not-found':
			return <div>Owner not found</div>
		case 'ok':
			owner = userRes.data.user
			break
	}
	return <FilterEdit entity={filterEntity} contributors={filterContributorRes.data} owner={owner} />
}

export function FilterEdit(props: { entity: M.FilterEntity; contributors: { users: M.User[]; roles: string[] }; owner: M.User }) {
	// fix refetches wiping out edited state, probably via fast deep equals or w/e
	const { toast } = useToast()

	const navigate = useNavigate()

	const [editedFilter, _setEditedFilter] = useState<M.EditableFilterNode>(props.entity.filter)
	const [validFilter, setValidFilter] = useState<M.FilterNode | null>(null)
	const setEditedFilter: React.Dispatch<React.SetStateAction<M.EditableFilterNode | undefined>> = (update) => {
		_setEditedFilter((filter) => {
			const newFilter = typeof update === 'function' ? update(filter) : update
			if (!newFilter) return props.entity.filter
			if (newFilter && M.isEditableBlockNode(newFilter) && newFilter.children.length === 0) {
				setValidFilter(null)
			} else if (newFilter && M.isValidFilterNode(newFilter)) {
				setValidFilter(newFilter)
			} else {
				setValidFilter(null)
			}
			setPageIndex(0)
			return newFilter
		})
	}

	const updateFilterMutation = useFilterUpdate()
	const deleteFilterMutation = useFilterDelete()

	const [editingDetails, setEditingDetails] = useState(false)
	const form = Form.useForm({
		defaultValues: {
			id: props.entity.id,
			name: props.entity.name,
			description: props.entity.description,
		},
		onSubmit: async ({ value, formApi }) => {
			const description = value.description?.trim() || null

			const res = await updateFilterMutation.mutateAsync([value.id, { ...value, description, filter: validFilter }])
			switch (res.code) {
				case 'err:permission-denied':
					RbacClient.showPermissionDenied(res)
					break

				case 'err:not-found':
					toast({ title: 'Unable to save: Filter Not Found' })
					break

				case 'ok':
					toast({ title: 'Filter saved' })
					formApi.reset()
					setEditingDetails(false)

					break

				default:
					assertNever(res)
			}
		},
	})

	const [pageIndex, setPageIndex] = useState(0)
	// const canSave = (editedFilterModified || (isDirty && isValid)) && !!validFilter && !updateFilterMutation.isPending

	const [selectedLayers, setSelectedLayers] = React.useState([] as M.LayerId[])
	const loggedInUser = useLoggedInUser()

	async function onDelete() {
		if (!props.entity) {
			return
		}
		const res = await deleteFilterMutation.mutateAsync(props.entity.id)
		if (res.code === 'ok') {
			toast({
				title: `Filter "${props.entity.name}" deleted`,
			})
			navigate(AR.link('/filters'))
		} else {
			toast({
				title: `Failed to delete filter "${props.entity.name}"`,
			})
		}
	}

	const idEltId = React.useId()
	const ownerEltId = React.useId()
	const loggedInUserIsContributor =
		props.contributors.users.some((u) => u.discordId === loggedInUser?.discordId) ||
		props.contributors.roles.some((role) => loggedInUser?.roles.includes(role))

	const saveBtn = (
		<form.Subscribe selector={(v) => [v.canSubmit, v.isDirty]}>
			{([canSubmit, isDirty]) => {
				const filterModified = !deepEqual(props.entity.filter, editedFilter)
				return (
					<Button onClick={() => form.handleSubmit()} disabled={!canSubmit || (!filterModified && !isDirty) || !validFilter}>
						Save
					</Button>
				)
			}}
		</form.Subscribe>
	)
	const deleteBtn = (
		<Button variant="destructive" onClick={onDelete}>
			Delete
		</Button>
	)

	return (
		<div className="container mx-auto pt-2">
			<div className="flex justify-between">
				{!editingDetails ? (
					<div className="flex flex-col space-y-2 w-full">
						<div className="flex space-x-4 items-center">
							<h3 className={Typography.H3}>{props.entity.name}</h3>
							<Icons.Dot />
							<small className="font-light">Owner: {props.owner.username}</small>
							<Icons.Dot />
							<Button onClick={() => setEditingDetails(true)} variant="ghost" size="icon">
								<Icons.Edit />
							</Button>
						</div>
						<p className={Typography.Blockquote}>{props.entity.description}</p>
					</div>
				) : (
					<div className="flex space-x-2">
						<form.Field name="name" validators={{ onChange: M.NewFilterEntitySchema.shape.name }}>
							{(field) => {
								function handleNameChange(name: string) {
									field.handleChange(name)
									if (!!form.getFieldValue('id').trim() && form.getFieldMeta('id')!.isDirty) return
									form.setFieldValue('id', name.toLowerCase().replace(/\s+/g, '-'), { dontUpdateMeta: true })
									form.setFieldMeta('id', (m) => ({ ...m, errors: [], errorMap: {} }))
								}

								return (
									<div className="flex flex-col space-y-2">
										<Label htmlFor={field.name}>Name</Label>
										<Input
											id={field.name}
											placeholder="Filter name"
											defaultValue={field.state.value}
											onBlur={field.handleBlur}
											onChange={(e) => handleNameChange(e.target.value)}
										/>
										{field.state.meta.errors.length > 0 && (
											<Alert variant="destructive">
												<AlertTitle>Name: </AlertTitle>
												<AlertDescription>{field.state.meta.errors.join(', ')}</AlertDescription>
											</Alert>
										)}
									</div>
								)
							}}
						</form.Field>
						<form.Field name="description" validators={{ onChange: M.FilterDescriptionSchema }}>
							{(field) => (
								<div className="flex space-x-2 flex-grow">
									<div className="flex flex-col space-y-1 min-w-[900px] ">
										<Label htmlFor={field.name}>Description</Label>
										<Textarea
											id={field.name}
											placeholder="Description"
											defaultValue={field.state.value ?? ''}
											onBlur={field.handleBlur}
											onChange={(e) => field.setValue(e.target.value)}
										/>
									</div>
									{field.state.meta.errors.length > 0 && (
										<span>
											<Alert variant="destructive">
												<AlertTitle>Description:</AlertTitle>
												<AlertDescription>{field.state.meta.errors.join(', ')}</AlertDescription>
											</Alert>
										</span>
									)}
								</div>
							)}
						</form.Field>
						<div className="flex flex-col space-y-1">
							<Button
								className="mt-[16px]"
								variant="ghost"
								size="icon"
								onClick={() => {
									form.reset()
									return setEditingDetails(false)
								}}
							>
								<Icons.Trash className="text-destructive" />
							</Button>
						</div>
					</div>
				)}
				<span className="space-x-2 flex h-min items-center self-end">
					{loggedInUserIsContributor && (
						<Badge variant="outline" className="text-nowrap border-info border-2">
							You are a contributor
						</Badge>
					)}
					<FilterContributors filterId={props.entity.id} contributors={props.contributors}>
						<Button variant="outline">Show Contributors</Button>
					</FilterContributors>
				</span>
			</div>
			<div className="flex space-x-2 mt-2">
				<FilterCard
					node={editedFilter}
					setNode={setEditedFilter}
					filterId={props.entity?.id}
					resetFilter={() => {
						setEditedFilter(props.entity.filter)
					}}
					children={
						<>
							{saveBtn} {deleteBtn}
						</>
					}
				/>
			</div>
			<LayerTable
				selected={selectedLayers}
				setSelected={setSelectedLayers}
				filter={validFilter ?? undefined}
				pageIndex={pageIndex}
				setPageIndex={setPageIndex}
			/>
		</div>
	)
}

function FilterContributors(props: {
	filterId: M.FilterEntityId
	contributors: { users: M.User[]; roles: string[] }
	children: React.ReactNode
}) {
	const { toast } = useToast()
	const queryClient = useQueryClient()
	const addMutation = useMutation({
		mutationFn: async (input: ToggleFilterContributorInput) => {
			console.log('adding', input)
			return trpc.filters.addFilterContributor.mutate(input)
		},
		onSuccess: (res) => {
			switch (res.code) {
				case 'err:permission-denied':
					return RbacClient.showPermissionDenied(res)
				case 'err:already-exists':
					return toast({ title: 'Contributor already added' })
				case 'ok':
					break
				default:
					assertNever(res)
			}
			queryClient.invalidateQueries({ queryKey: getFilterContributorQueryKey(props.filterId) })
		},
		onError: (err) => {
			toast({ title: 'Failed to add contributor', description: err.message })
		},
	})
	const removeMutation = useMutation({
		mutationFn: async (input: ToggleFilterContributorInput) => {
			return trpc.filters.removeFilterContributor.mutate(input)
		},
		onSuccess: (res) => {
			switch (res.code) {
				case 'err:permission-denied':
					return RbacClient.showPermissionDenied(res)
				case 'err:not-found':
					return toast({ title: 'Contributor not found' })
				case 'ok':
					break
				default:
					assertNever(res)
			}
			queryClient.invalidateQueries({ queryKey: getFilterContributorQueryKey(props.filterId) })
		},
	})
	function addUser(user: M.User) {
		addMutation.mutate({ filterId: props.filterId, userId: user.discordId })
	}

	return (
		<Popover>
			<PopoverTrigger asChild>{props.children}</PopoverTrigger>
			<PopoverContent className="p-0">
				<CardHeader>
					<CardTitle>Contributors</CardTitle>
					<CardDescription>Users and Roles that can edit this filter</CardDescription>
				</CardHeader>
				<CardContent>
					<div>
						<div className="flex space-x-2 items-center">
							<h4 className="leading-none">Users</h4>
							<SelectUserPopover selectUser={addUser}>
								<Button variant="outline" size="icon">
									<Icons.Plus />
								</Button>
							</SelectUserPopover>
						</div>
						<ul>
							{props.contributors.users.map((user) => (
								<li key={user.discordId} className="flex space-x-1 items-center">
									<Icons.Minus
										onClick={(e) => removeMutation.mutate({ filterId: props.filterId, userId: user.discordId })}
										className="text-destructive hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
									/>
									<Badge>{user.username}</Badge>
								</li>
							))}
						</ul>
					</div>
					<div id="roles">
						<div>
							<Label htmlFor="roles">Roles</Label>
							<SelectRolePopover selectRole={(role) => addMutation.mutate({ filterId: props.filterId, role })}>
								<Button variant="outline" size="icon">
									<Icons.Plus />
								</Button>
							</SelectRolePopover>
						</div>
						<ul>
							{props.contributors.roles.map((role) => (
								<li key={role} className="flex space-x-1 items-center">
									<Icons.Minus
										onClick={(e) => removeMutation.mutate({ filterId: props.filterId, role })}
										className="text-destructive hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
									/>
									<Badge>{role}</Badge>
								</li>
							))}
						</ul>
					</div>
				</CardContent>
			</PopoverContent>
		</Popover>
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
					<AlertDialogTitle>Delete Filter</AlertDialogTitle>
					<AlertDialogDescription>Are you sure you want to delete this filter?</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogCancel onClick={onCancel}>Cancel</AlertDialogCancel>
					<Button variant="destructive" onClick={onDelete}>
						Delete
					</Button>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	)
}

function SelectUserPopover(props: { children: React.ReactNode; selectUser: (user: M.User) => void }) {
	const usersRes = Users.useUsers()
	const [isOpen, setIsOpen] = useState(false)
	function onSelect(user: M.User) {
		props.selectUser(user)
		setIsOpen(false)
	}
	return (
		<Popover modal={true} open={isOpen} onOpenChange={setIsOpen}>
			<PopoverTrigger asChild>{props.children}</PopoverTrigger>
			<PopoverContent>
				<Command>
					<CommandInput placeholder="Search for a user..." />
					<CommandList>
						{usersRes.data?.code === 'ok' &&
							usersRes.data.users.map((user) => (
								<CommandItem key={user.discordId} onSelect={() => onSelect(user)}>
									{user.username}
								</CommandItem>
							))}
					</CommandList>
				</Command>
			</PopoverContent>
		</Popover>
	)
}

export function SelectRolePopover(props: { children: React.ReactNode; selectRole: (role: string) => void }) {
	const rolesRes = RbacClient.useRoles()
	const [isOpen, setIsOpen] = useState(false)
	function onSelect(role: string) {
		props.selectRole(role)
		setIsOpen(false)
	}
	return (
		<Popover open={isOpen} onOpenChange={setIsOpen} modal={true}>
			<PopoverTrigger asChild>{props.children}</PopoverTrigger>
			<PopoverContent>
				<Command>
					<CommandInput placeholder="Search for a role..." />
					<CommandList>
						{rolesRes.data?.map((role) => (
							<CommandItem key={role} onSelect={() => onSelect(role)}>
								{role}
							</CommandItem>
						))}
					</CommandList>
				</Command>
			</PopoverContent>
		</Popover>
	)
}
