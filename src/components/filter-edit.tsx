import * as AR from '@/app-routes.ts'
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import useAppParams from '@/hooks/use-app-params'
import { useToast } from '@/hooks/use-toast'
import { assertNever } from '@/lib/type-guards'
import * as Typography from '@/lib/typography'
import { cn } from '@/lib/utils'
import * as F from '@/models/filter.models'
import * as L from '@/models/layer'
import * as LQY from '@/models/layer-queries.models'
import * as USR from '@/models/users.models'
import * as RBAC from '@/rbac.models'
import { ToggleFilterContributorInput } from '@/server/systems/filter-entity'
import * as FilterEntityClient from '@/systems.client/filter-entity.client'
import * as RbacClient from '@/systems.client/rbac.client'
import * as UsersClient from '@/systems.client/users.client'
import { trpc } from '@/trpc.client'
import * as ReactRx from '@react-rxjs/core'
import * as Form from '@tanstack/react-form'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import deepEqual from 'fast-deep-equal'
import * as Icons from 'lucide-react'
import { useState } from 'react'
import React from 'react'
import Markdown from 'react-markdown'
import { useNavigate } from 'react-router-dom'
import { z } from 'zod'
import FilterCard from './filter-card'
import FullPageSpinner from './full-page-spinner'
import LayerTable from './layer-table'
import { Alert, AlertDescription, AlertTitle } from './ui/alert'
import { Badge } from './ui/badge'
import { CardContent, CardDescription, CardHeader, CardTitle } from './ui/card'
import { Command, CommandInput, CommandItem, CommandList } from './ui/command'
import { Label } from './ui/label'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'
import { Separator } from './ui/separator'
import { Textarea } from './ui/textarea'

export default function FilterWrapper() {
	// could also be /filters/new, in which case we're creating a new filter and id is undefined
	const editParams = useAppParams('/filters/:id')
	const { toast } = useToast()
	const loggedInUser = UsersClient.useLoggedInUser()
	const navigate = useNavigate()
	const filterEntity = ReactRx.useStateObservable(FilterEntityClient.filterEntities$).get(editParams.id)

	// -------- set title --------
	React.useEffect(() => {
		if (!filterEntity?.name) return
		document.title = `SLM - ${filterEntity?.name}`
	}, [filterEntity?.name])

	React.useEffect(() => {
		const sub = FilterEntityClient.filterMutation$.subscribe((mutation) => {
			if (!mutation || mutation.key !== editParams.id) return
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
					navigate(AR.route('/filters'))
					break
				}
				default:
					assertNever(mutation.type)
			}
			return () => sub.unsubscribe()
		})
	}, [editParams.id, navigate, toast, loggedInUser?.username])
	const userRes = UsersClient.useUser(filterEntity?.owner)
	const filterContributorRes = FilterEntityClient.useFilterContributors(editParams.id)

	// TODO handle not found
	if (!filterEntity || !userRes.data || !filterContributorRes.data) {
		return <FullPageSpinner />
	}
	let owner: USR.User
	switch (userRes.data.code) {
		case 'err:not-found':
			return <div>Owner not found</div>
		case 'ok':
			owner = userRes.data.user
			break
	}
	return <FilterEdit entity={filterEntity} contributors={filterContributorRes.data} owner={owner} />
}

export function FilterEdit(props: { entity: F.FilterEntity; contributors: { users: USR.User[]; roles: string[] }; owner: USR.User }) {
	// fix refetches wiping out edited state, probably via fast deep equals or w/e
	const { toast } = useToast()

	const navigate = useNavigate()

	const [editedFilter, _setEditedFilter] = useState<F.EditableFilterNode>(props.entity.filter)
	const [validFilter, setValidFilter] = useState<F.FilterNode | null>(props.entity.filter)
	const setEditedFilter: React.Dispatch<React.SetStateAction<F.EditableFilterNode | undefined>> = (update) => {
		_setEditedFilter((filter) => {
			const newFilter = typeof update === 'function' ? update(filter) : update
			if (!newFilter) return props.entity.filter
			if (newFilter && F.isEditableBlockNode(newFilter) && newFilter.children.length === 0) {
				setValidFilter(null)
			} else if (newFilter && F.isValidFilterNode(newFilter)) {
				setValidFilter(newFilter)
			} else {
				setValidFilter(null)
			}
			setPageIndex(0)
			return newFilter
		})
	}

	const updateFilterMutation = FilterEntityClient.useFilterUpdate()
	const deleteFilterMutation = FilterEntityClient.useFilterDelete()

	const [editingDetails, setEditingDetails] = useState(false)
	const form = Form.useForm({
		defaultValues: {
			name: props.entity.name,
			description: props.entity.description,
		},
		onSubmit: async ({ value, formApi }) => {
			const description = value.description?.trim() || null

			const res = await updateFilterMutation.mutateAsync([props.entity.id, { ...value, description, filter: validFilter ?? undefined }])
			switch (res.code) {
				case 'err:permission-denied':
					RbacClient.handlePermissionDenied(res)
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

	const [selectedLayers, setSelectedLayers] = React.useState([] as L.LayerId[])
	const loggedInUser = UsersClient.useLoggedInUser()

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
			let blurb: string
			switch (res.code) {
				case 'err:permission-denied':
					blurb = 'You do not have permission to delete this filter'
					break
				case 'err:cannot-delete-pool-filter':
					blurb = 'Cannot delete a filter that is currently in use by the layer pool'
					break
				case 'err:filter-in-use':
					blurb = 'Filter is in use by ' + res.referencingFilters.join(', ')
					break
				case 'err:filter-not-found':
					blurb = 'Filter not found'
					break
				default:
					assertNever(res)
			}

			toast({
				title: `Failed to delete filter "${props.entity.name} : ${blurb}"`,
			})
		}
	}

	const loggedInUserRole: 'owner' | 'contributor' | 'none' | 'write-all' = (() => {
		if (!loggedInUser) return 'none'
		for (const perm of loggedInUser.perms) {
			if (perm.type === 'filters:write' && perm.args!.filterId === props.entity.id && perm.allowedByRoles.includes('filter-owner')) {
				return 'owner'
			}
		}

		for (const perm of loggedInUser.perms) {
			if (
				perm.type === 'filters:write' && perm.args!.filterId === props.entity.id
				&& (perm.allowedByRoles.includes('filter-user-contributor')
					|| perm.allowedByRoles.some(r => typeof r !== 'string' && r.type === 'filter-role-contributor'))
			) {
				return 'contributor'
			}
		}
		for (const perm of loggedInUser.perms) {
			if (perm.type === 'filters:write-all') {
				return 'write-all'
			}
		}

		return 'none'
	})()

	const queryContext: LQY.LayerQueryContext | undefined = React.useMemo(() =>
		validFilter
			? ({
				constraints: [LQY.getEditedFilterConstraint(validFilter)],
			})
			: undefined, [validFilter])

	const saveBtn = (
		<form.Subscribe selector={(v) => [v.canSubmit, v.isDirty]}>
			{([canSubmit, isDirty]) => {
				const filterModified = !deepEqual(props.entity.filter, editedFilter)
				return (
					<Button
						onClick={() => form.handleSubmit()}
						disabled={!canSubmit || !validFilter || (!filterModified && !isDirty) || loggedInUserRole == 'none'}
					>
						Save
					</Button>
				)
			}}
		</form.Subscribe>
	)
	const deleteBtn = (
		<DeleteFilterDialog onDelete={onDelete}>
			<Button variant="destructive">Delete</Button>
		</DeleteFilterDialog>
	)

	return (
		<div className="container mx-auto pt-2">
			<div className="flex justify-between">
				{!editingDetails
					? (
						<div className="flex w-full flex-col space-y-2">
							<div className="flex items-center justify-between">
								<span className="flex items-center space-x-4">
									<h3 className={Typography.H3}>{props.entity.name}</h3>
									<Icons.Dot />
									<small className="font-light">Owner: {props.owner.username}</small>
									<Icons.Dot />
									<Button disabled={loggedInUserRole === 'none'} onClick={() => setEditingDetails(true)} variant="ghost" size="icon">
										<Icons.Edit />
									</Button>
								</span>
								<span className="flex h-min items-center space-x-2 self-end">
									{loggedInUserRole === 'owner' && (
										<Badge variant="outline" className="text-nowrap border-2 border-primary">
											You are the owner of this filter
										</Badge>
									)}
									{loggedInUserRole === 'contributor' && (
										<Badge variant="outline" className="text-nowrap border-2 border-info">
											You are a contributor
										</Badge>
									)}
									{loggedInUserRole === 'none' && (
										<Badge variant="outline" className="text-nowrap border-2 border-destructive">
											You don't have permission to modify this filter
										</Badge>
									)}
									{loggedInUserRole === 'write-all' && (
										<Badge variant="outline" className="border-success text-nowrap border-2">
											You have write access to all filters
										</Badge>
									)}
									<FilterContributors filterId={props.entity.id} contributors={props.contributors}>
										<Button disabled={loggedInUserRole === 'none'} variant="outline">
											Show Contributors
										</Button>
									</FilterContributors>
								</span>
							</div>
							<Separator orientation="horizontal" />
							<DescriptionDisplay description={props.entity.description} />
						</div>
					)
					: (
						<div className="flex space-x-2">
							<div className="flex flex-col space-y-2">
								<form.Field name="name" validators={{ onChange: F.NewFilterEntitySchema.shape.name }}>
									{(field) => {
										return (
											<div className="flex flex-col space-y-2">
												<Label htmlFor={field.name}>Name</Label>
												<Input
													id={field.name}
													placeholder="Filter name"
													defaultValue={field.state.value}
													onBlur={field.handleBlur}
													onChange={(e) => field.handleChange(e.target.value)}
												/>
												{field.state.meta.errors.length > 0 && (
													<Alert variant="destructive">
														<AlertTitle>Name:</AlertTitle>
														<AlertDescription>{field.state.meta.errors.join(', ')}</AlertDescription>
													</Alert>
												)}
											</div>
										)
									}}
								</form.Field>
								<form.Field name="description" validators={{ onChange: z.union([F.FilterEntityDescriptionSchema, z.string().length(0)]) }}>
									{(field) => (
										<div className="flex flex-grow space-x-2">
											<div className="flex min-w-[900px] flex-col space-y-1">
												<Label htmlFor={field.name}>Description</Label>
												<Textarea
													id={field.name}
													placeholder="Description"
													defaultValue={field.state.value ?? ''}
													onBlur={field.handleBlur}
													onChange={(e) => field.handleChange(e.target.value)}
													rows={15}
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
							</div>
							<Button
								className="ml-4 self-end"
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
					)}
			</div>
			<div className="mt-2 flex space-x-2">
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
				queryContext={queryContext}
				pageIndex={pageIndex}
				setPageIndex={setPageIndex}
			/>
		</div>
	)
}

function FilterContributors(props: {
	filterId: F.FilterEntityId
	contributors: { users: USR.User[]; roles: string[] }
	children: React.ReactNode
}) {
	const { toast } = useToast()
	const queryClient = useQueryClient()
	const addMutation = useMutation({
		mutationFn: async (input: ToggleFilterContributorInput) => {
			return trpc.filters.addFilterContributor.mutate(input)
		},
		onSuccess: (res) => {
			switch (res.code) {
				case 'err:permission-denied':
					return RbacClient.handlePermissionDenied(res)
				case 'err:already-exists':
					return toast({ title: 'Contributor already added' })
				case 'ok':
					break
				default:
					assertNever(res)
			}
			queryClient.invalidateQueries({ queryKey: FilterEntityClient.getFilterContributorQueryKey(props.filterId) })
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
					return RbacClient.handlePermissionDenied(res)
				case 'err:not-found':
					return toast({ title: 'Contributor not found' })
				case 'ok':
					break
				default:
					assertNever(res)
			}
			queryClient.invalidateQueries({ queryKey: FilterEntityClient.getFilterContributorQueryKey(props.filterId) })
		},
	})
	function addUser(user: USR.User) {
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
						<div className="flex items-center space-x-2">
							<h4 className="leading-none">Users</h4>
							<SelectUserPopover selectUser={addUser}>
								<Button variant="outline" size="icon">
									<Icons.Plus />
								</Button>
							</SelectUserPopover>
						</div>
						<ul>
							{props.contributors.users.map((user) => (
								<li key={user.discordId} className="flex items-center space-x-1">
									<Icons.Minus
										onClick={() => removeMutation.mutate({ filterId: props.filterId, userId: user.discordId })}
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
								<li key={role} className="flex items-center space-x-1">
									<Icons.Minus
										onClick={() => removeMutation.mutate({ filterId: props.filterId, role })}
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

function SelectUserPopover(props: { children: React.ReactNode; selectUser: (user: USR.User) => void }) {
	const usersRes = UsersClient.useUsers()
	const [isOpen, setIsOpen] = useState(false)
	function onSelect(user: USR.User) {
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
						{usersRes.data?.code === 'ok'
							&& usersRes.data.users.map((user) => (
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

function DescriptionDisplay({ description }: { description?: string | null }) {
	const [expanded, setExpanded] = useState(false)
	if (!description) return null
	description = description.trim()
	let truncatedDescription = description.split('\n')[0]
	if (truncatedDescription.length > 128) truncatedDescription = truncatedDescription.slice(0, 128) + '...'
	const truncated = truncatedDescription !== description

	return (
		<div>
			<div>
				<Markdown components={markdownComponents}>{expanded ? description : truncatedDescription}</Markdown>
			</div>
			{truncated && (
				<Button variant="link" className={Typography.Muted} onClick={() => setExpanded(!expanded)}>
					{expanded ? 'Hide' : ' Show More'}
				</Button>
			)}
		</div>
	)
}

const markdownComponents = {
	h1: ({ ...props }: React.ComponentPropsWithoutRef<'h1'>) => (
		<h1 {...props} className={cn('text-xl font-semibold mt-4 mb-2', Typography.H3)} />
	),
	h2: ({ ...props }: React.ComponentPropsWithoutRef<'h2'>) => (
		<h2 {...props} className={cn('text-lg font-medium mt-3 mb-2', Typography.H3)} />
	),
	h3: ({ ...props }: React.ComponentPropsWithoutRef<'h3'>) => (
		<h3 {...props} className={cn('text-lg font-medium mt-3 mb-2', Typography.H3)} />
	),
	h4: ({ ...props }: React.ComponentPropsWithoutRef<'h4'>) => (
		<h4 {...props} className={cn('text-base font-medium mt-2 mb-1', Typography.H4)} />
	),
	p: ({ ...props }: React.ComponentPropsWithoutRef<'p'>) => <p {...props} className="py-2" />,
	ul: ({ ...props }: React.ComponentPropsWithoutRef<'ul'>) => <ul {...props} className="list-disc pl-6 py-2" />,
	ol: ({ ...props }: React.ComponentPropsWithoutRef<'ol'>) => <ol {...props} className="list-decimal pl-6 py-2" />,
	li: ({ ...props }: React.ComponentPropsWithoutRef<'li'>) => <li {...props} className="my-1" />,
	blockquote: ({ ...props }: React.ComponentPropsWithoutRef<'blockquote'>) => (
		<blockquote {...props} className={cn('border-l-4 border-gray-300 py-2 pl-4 italic', Typography.Blockquote)} />
	),
	code: ({ inline, ...props }: React.ComponentPropsWithoutRef<'code'> & { inline?: boolean }) =>
		inline
			? <code {...props} className="rounded bg-gray-100 px-1 py-0.5 font-mono text-sm dark:bg-gray-800" />
			: <code {...props} className="my-3 block overflow-x-auto rounded-md bg-gray-100 p-3 font-mono text-sm dark:bg-gray-800" />,
	a: ({ ...props }: React.ComponentPropsWithoutRef<'a'>) => <a {...props} className="text-blue-600 hover:underline dark:text-blue-400" />,
	hr: ({ ...props }: React.ComponentPropsWithoutRef<'hr'>) => <hr {...props} className="my-6 border-gray-300 dark:border-gray-700" />,
	img: ({ ...props }: React.ComponentPropsWithoutRef<'img'>) => <img {...props} className="my-4 h-auto max-w-full rounded-md" />,
	table: ({ ...props }: React.ComponentPropsWithoutRef<'table'>) => (
		<div className="my-4 overflow-x-auto">
			<table {...props} className="min-w-full divide-y divide-gray-300 dark:divide-gray-700" />
		</div>
	),
	thead: ({ ...props }: React.ComponentPropsWithoutRef<'thead'>) => <thead {...props} className="bg-gray-100 dark:bg-gray-800" />,
	tbody: ({ ...props }: React.ComponentPropsWithoutRef<'tbody'>) => (
		<tbody {...props} className="divide-y divide-gray-200 dark:divide-gray-800" />
	),
	tr: ({ ...props }: React.ComponentPropsWithoutRef<'tr'>) => <tr {...props} className="hover:bg-gray-50 dark:hover:bg-gray-900" />,
	th: ({ ...props }: React.ComponentPropsWithoutRef<'th'>) => <th {...props} className="px-4 py-3 text-left text-sm font-semibold" />,
	td: ({ ...props }: React.ComponentPropsWithoutRef<'td'>) => <td {...props} className="px-4 py-3 text-sm" />,
}
