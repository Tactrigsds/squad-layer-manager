import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type * as EditFrame from '@/frames/filter-editor.frame.ts'
import { getFrameState, useFrameStore } from '@/frames/frame-manager'
import { useToast } from '@/hooks/use-toast'
import { assertNever } from '@/lib/type-guards'
import * as Typography from '@/lib/typography'
import { cn } from '@/lib/utils'
import * as F from '@/models/filter.models'
import type * as USR from '@/models/users.models'
import * as RPC from '@/orpc.client'
import * as RBAC from '@/rbac.models'
import * as FilterEntityClient from '@/systems/filter-entity.client'
import * as RbacClient from '@/systems/rbac.client'
import * as UsersClient from '@/systems/users.client'
import * as Form from '@tanstack/react-form'
import { useMutation } from '@tanstack/react-query'
import { useBlocker } from '@tanstack/react-router'
import { useNavigate } from '@tanstack/react-router'
import * as Icons from 'lucide-react'
import { useState } from 'react'
import React from 'react'
import Markdown from 'react-markdown'

import { useShallow } from 'zustand/react/shallow'
import EmojiDisplay from './emoji-display'
import { EmojiPickerPopover } from './emoji-picker-popover'
import FilterCard from './filter-card'
import { FilterValidationErrorDisplay } from './filter-extra-errors'
import LayerTable from './layer-table'
import { Alert, AlertDescription, AlertTitle } from './ui/alert'
import { Badge } from './ui/badge'
import { CardContent, CardDescription, CardHeader, CardTitle } from './ui/card'
import { Command, CommandInput, CommandItem, CommandList } from './ui/command'
import { Label } from './ui/label'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'
import { Separator } from './ui/separator'
import { Textarea } from './ui/textarea'

export function FilterEdit(
	props: { entity: F.FilterEntity; contributors: { users: USR.User[]; roles: string[] }; owner: USR.User; frameKey: EditFrame.Key },
) {
	const frameKey = props.frameKey
	// fix refetches wiping out edited state, probably via fast deep equals or w/e
	const { toast } = useToast()
	const frameState = () => getFrameState(frameKey)
	const useFrame = <O,>(selector: (table: EditFrame.FilterEditor) => O) => useFrameStore(frameKey, selector)

	const navigate = useNavigate()

	const updateFilterMutation = FilterEntityClient.useFilterUpdate()
	const deleteFilterMutation = FilterEntityClient.useFilterDelete()

	const [editingDetails, setEditingDetails] = useState(false)
	const form = Form.useForm({
		defaultValues: {
			name: props.entity.name,
			description: props.entity.description,
			alertMessage: props.entity.alertMessage,
			emoji: props.entity.emoji,
			invertedAlertMessage: props.entity.invertedAlertMessage,
			invertedEmoji: props.entity.invertedEmoji,
		},
		onSubmit: async ({ value, formApi }) => {
			const description = value.description?.trim() || null

			const res = await updateFilterMutation.mutateAsync([props.entity.id, {
				...value,
				description,
				emoji: value.emoji ?? null,
				alertMessage: value.alertMessage ?? null,
				invertedEmoji: value.invertedEmoji ?? null,
				invertedAlertMessage: value.invertedAlertMessage ?? null,
				filter: frameState().validatedFilter ?? undefined,
			}])
			switch (res.code) {
				case 'err:permission-denied':
					RbacClient.handlePermissionDenied(res)
					break

				case 'err:not-found':
					toast({ title: 'Unable to save: Filter Not Found' })
					break

				case 'ok':
					toast({ title: 'Filter saved' })
					frameState().reset(res.filter.filter)
					formApi.reset({
						name: res.filter.name,
						description: res.filter.description,
						emoji: res.filter.emoji,
						alertMessage: res.filter.alertMessage,
						invertedEmoji: res.filter.invertedEmoji,
						invertedAlertMessage: res.filter.invertedAlertMessage,
					})
					setEditingDetails(false)

					break

				default:
					assertNever(res)
			}
		},
	})

	const loggedInUser = UsersClient.useLoggedInUser()

	const onDelete = React.useCallback(async () => {
		if (!props.entity) {
			return
		}
		const res = await deleteFilterMutation.mutateAsync(props.entity.id)
		if (res.code === 'ok') {
			toast({
				title: `Filter "${props.entity.name}" deleted`,
			})
			void navigate({ to: '/filters' })
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
	}, [deleteFilterMutation, navigate, props.entity, toast])

	const loggedInUserRole: 'owner' | 'contributor' | 'none' | 'write-all' = (() => {
		if (!loggedInUser) return 'none'
		if (props.entity.owner === loggedInUser.discordId) return 'owner'

		for (const perm of loggedInUser.perms) {
			if (
				perm.type === 'filters:write' && perm.args!.filterId === props.entity.id
				&& perm.allowedByRoles.some(r => RBAC.isInferredRoleType(r) && r.type === 'filter-role-contributor')
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

	const [filterValid, filterModified] = useFrame(
		useShallow((state) => [state.valid, state.modified]),
	)

	useBlocker({
		enableBeforeUnload: filterModified || form.state.isDirty,
		shouldBlockFn: () => {
			if (!filterModified && !form.state.isDirty) return false

			const shouldLeave = confirm('You have unsaved changes. Are you sure you want to leave?')
			return !shouldLeave
		},
	})

	const saveBtn = React.useMemo(() => (
		<form.Subscribe selector={(v) => [v.canSubmit, v.isDirty]}>
			{([canSubmit, isDirty]) => {
				return (
					<Button
						onClick={() => form.handleSubmit()}
						disabled={!canSubmit || !filterValid || (!filterModified && !isDirty) || loggedInUserRole == 'none'}
					>
						Save
					</Button>
				)
			}}
		</form.Subscribe>
	), [form, filterValid, filterModified, loggedInUserRole])

	const deleteBtn = React.useMemo(() => (
		<DeleteFilterDialog onDelete={onDelete}>
			<Button variant="destructive">Delete</Button>
		</DeleteFilterDialog>
	), [onDelete])

	const filterCard = React.useMemo(() => (
		<FilterCard
			frameKey={frameKey}
		>
			{saveBtn}
			{deleteBtn}
		</FilterCard>
	), [frameKey, deleteBtn, saveBtn])

	const _nodeMapStore = useFrame((s) => s.nodeMapStore)

	return (
		<div className="container mx-auto flex flex-col gap-2">
			<div className="flex justify-between">
				{!editingDetails
					? (
						<div className="flex w-full flex-col space-y-2">
							<div className="flex items-center justify-between">
								<span className="flex items-center space-x-4">
									{props.entity.emoji && (
										<>
											<EmojiDisplay emoji={props.entity.emoji} className="text-3xl" />
											<Icons.Dot />
										</>
									)}
									<h3 className={Typography.H3}>{props.entity.name}</h3>
									<Icons.Dot />
									<small className="font-light">Owner: {props.owner.displayName}</small>
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
						<div className="space-y-4 w-full">
							<div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
								{/* Left Column - Form Fields */}
								<div className="space-y-6">
									{/* Name Section */}
									<div className="space-y-2">
										<form.Field name="name" validators={{ onChange: F.NewFilterEntitySchema.shape.name }}>
											{(field) => {
												const label = 'Name'
												return (
													<div className="flex flex-col space-y-2">
														<Label htmlFor={field.name}>{label}</Label>
														<Input
															id={field.name}
															placeholder={label}
															defaultValue={field.state.value}
															onBlur={field.handleBlur}
															onChange={(e) => field.handleChange(e.target.value)}
														/>
														{field.state.meta.errors.length > 0 && (
															<Alert variant="destructive">
																<AlertTitle>{label}:</AlertTitle>
																<AlertDescription>{field.state.meta.errors.join(', ')}</AlertDescription>
															</Alert>
														)}
													</div>
												)
											}}
										</form.Field>
									</div>

									{/* Match Indicator Section */}
									<div className="border rounded-lg p-4 space-y-4">
										<h3 className="font-semibold text-sm">Match Indicator</h3>
										<div className="flex gap-4">
											<form.Field name="emoji">
												{(field) => {
													const label = 'Emoji'
													return (
														<div className="flex flex-col space-y-2">
															<Label htmlFor={field.name}>{label}</Label>
															<EmojiPickerPopover
																value={field.state.value ?? undefined}
																onSelect={(id) => {
																	field.handleChange(id?.trim() ?? null)
																}}
																disabled={false}
															/>
															{field.state.meta.errors.length > 0 && (
																<Alert variant="destructive">
																	<AlertTitle>{label}:</AlertTitle>
																	<AlertDescription>{field.state.meta.errors.join(', ')}</AlertDescription>
																</Alert>
															)}
														</div>
													)
												}}
											</form.Field>
											<form.Field
												name="alertMessage"
												validators={{ onChange: F.AlertMessageSchema.nullable() }}
											>
												{(field) => {
													const label = 'Alert Message'
													return (
														<div className="flex flex-col space-y-2 flex-grow">
															<Label htmlFor={field.name}>{label}</Label>
															<Textarea
																id={field.name}
																placeholder={label}
																defaultValue={field.state.value ?? ''}
																onBlur={field.handleBlur}
																onChange={(e) => field.setValue(e.target.value.trim() ?? null)}
																rows={3}
															/>
															{field.state.meta.errors.length > 0 && (
																<Alert variant="destructive">
																	<AlertTitle>{label}:</AlertTitle>
																	<AlertDescription>{field.state.meta.errors.join(', ')}</AlertDescription>
																</Alert>
															)}
														</div>
													)
												}}
											</form.Field>
										</div>
									</div>

									{/* Miss Indicator Section */}
									<div className="border rounded-lg p-4 space-y-4">
										<h3 className="font-semibold text-sm">Miss Indicator</h3>
										<div className="flex gap-4">
											<form.Field name="invertedEmoji">
												{(field) => {
													const label = 'Emoji'
													return (
														<div className="flex flex-col space-y-2">
															<Label htmlFor={field.name}>{label}</Label>
															<EmojiPickerPopover
																value={field.state.value ?? undefined}
																onSelect={(id) => {
																	field.handleChange(id ?? null)
																}}
																disabled={false}
															/>
															{field.state.meta.errors.length > 0 && (
																<Alert variant="destructive">
																	<AlertTitle>{label}:</AlertTitle>
																	<AlertDescription>{field.state.meta.errors.join(', ')}</AlertDescription>
																</Alert>
															)}
														</div>
													)
												}}
											</form.Field>
											<form.Field
												name="invertedAlertMessage"
												validators={{ onChange: F.AlertMessageSchema.nullable() }}
											>
												{(field) => {
													const label = 'Alert Message'
													return (
														<div className="flex flex-col space-y-2 flex-grow">
															<Label htmlFor={field.name}>{label}</Label>
															<Textarea
																id={field.name}
																placeholder={label}
																defaultValue={field.state.value ?? ''}
																onBlur={field.handleBlur}
																onChange={(e) => field.setValue(e.target.value.trim() ?? null)}
																rows={3}
															/>
															{field.state.meta.errors.length > 0 && (
																<Alert variant="destructive">
																	<AlertTitle>{label}:</AlertTitle>
																	<AlertDescription>{field.state.meta.errors.join(', ')}</AlertDescription>
																</Alert>
															)}
														</div>
													)
												}}
											</form.Field>
										</div>
									</div>
								</div>

								{/* Right Column - Description */}
								<div className="flex gap-2">
									<form.Field
										name="description"
										validators={{ onChange: F.DescriptionSchema.nullable() }}
									>
										{(field) => {
											const label = 'Description'
											return (
												<div className="flex flex-col space-y-2 flex-grow">
													<Label htmlFor={field.name}>{label}</Label>
													<Textarea
														id={field.name}
														placeholder={label}
														defaultValue={field.state.value ?? ''}
														onBlur={field.handleBlur}
														onChange={(e) => field.handleChange(e.target.value?.trim() ?? null)}
														rows={15}
														className="font-mono text-sm flex-grow"
													/>
													{field.state.meta.errors.length > 0 && (
														<Alert variant="destructive">
															<AlertTitle>{label}:</AlertTitle>
															<AlertDescription>{field.state.meta.errors.join(', ')}</AlertDescription>
														</Alert>
													)}
												</div>
											)
										}}
									</form.Field>
									<Button
										className="self-start"
										variant="ghost"
										size="icon"
										onClick={() => {
											form.reset()
											return setEditingDetails(false)
										}}
									>
										<Icons.X />
									</Button>
								</div>
							</div>
						</div>
					)}
			</div>
			<FilterValidationErrorDisplay frameKey={frameKey} />
			{filterCard}
			<LayerTable
				frameKey={frameKey}
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
	const addMutation = useMutation(RPC.orpc.filters.addFilterContributor.mutationOptions({
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
			FilterEntityClient.invalidateQueriesForFilter(props.filterId)
		},
		onError: (err) => {
			toast({ title: 'Failed to add contributor', description: err.message })
		},
	}))
	const removeMutation = useMutation(RPC.orpc.filters.removeFilterContributor.mutationOptions({
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
			FilterEntityClient.invalidateQueriesForFilter(props.filterId)
		},
	}))
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
									<Badge>{user.displayName}</Badge>
								</li>
							))}
						</ul>
					</div>
					<div id="roles">
						<div>
							<Label htmlFor="roles">Roles</Label>
							<SelectUserDefinedRolePopover selectRole={(role) => addMutation.mutate({ filterId: props.filterId, roleId: role.type })}>
								<Button variant="outline" size="icon">
									<Icons.Plus />
								</Button>
							</SelectUserDefinedRolePopover>
						</div>
						<ul>
							{props.contributors.roles.map((role) => (
								<li key={role} className="flex items-center space-x-1">
									<Icons.Minus
										onClick={() => removeMutation.mutate({ filterId: props.filterId, roleId: role })}
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
		<Popover modal open={isOpen} onOpenChange={setIsOpen}>
			<PopoverTrigger asChild>{props.children}</PopoverTrigger>
			<PopoverContent>
				<Command>
					<CommandInput placeholder="Search for a user..." />
					<CommandList>
						{usersRes.data?.code === 'ok'
							&& usersRes.data.users.map((user) => (
								<CommandItem key={user.discordId} onSelect={() => onSelect(user)}>
									{user.displayName}
								</CommandItem>
							))}
					</CommandList>
				</Command>
			</PopoverContent>
		</Popover>
	)
}

export function SelectUserDefinedRolePopover(props: { children: React.ReactNode; selectRole: (role: RBAC.GenericRole) => void }) {
	const rolesRes = RbacClient.useUserDefinedRoles()
	const [isOpen, setIsOpen] = useState(false)
	function onSelect(role: RBAC.Role) {
		props.selectRole(role)
		setIsOpen(false)
	}
	return (
		<Popover open={isOpen} onOpenChange={setIsOpen} modal>
			<PopoverTrigger asChild>{props.children}</PopoverTrigger>
			<PopoverContent>
				<Command>
					<CommandInput placeholder="Search for a role..." />
					<CommandList>
						{rolesRes.data?.map((role) => (
							<CommandItem key={role.type} onSelect={() => onSelect(role)}>
								{role.type}
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
