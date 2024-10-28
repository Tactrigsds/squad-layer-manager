import { useForm } from '@tanstack/react-form'
import { zodValidator } from '@tanstack/zod-form-adapter'
import deepEqual from 'fast-deep-equal'
import { FormEvent, useCallback, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'

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
import { SetState } from '@/lib/react'
import { capitalize } from '@/lib/text'
import { trpcReact } from '@/lib/trpc.client'
import * as Typography from '@/lib/typography'
import * as M from '@/models.ts'
import { type WatchFilterOutput } from '@/server/systems/filters-entity'

import FilterCard from './filter-card'
import FullPageSpinner from './full-page-spinner'
import LayerTable from './layer-table'
import { Alert, AlertDescription, AlertTitle } from './ui/alert'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from './ui/dialog'
import { Label } from './ui/label'
import { Textarea } from './ui/textarea'

const defaultFilter: M.EditableFilterNode = EFB.and()

export default function FilterEdit() {
	const { id } = useAppParams(AR.exists('/filters/:id/edit'))
	// fix refetches wiping out edited state, probably via fast deep equals or w/e
	const { toast } = useToast()
	// the unedited filter entity from the server
	const [filterEntity, setFilterEntity] = useState<M.FilterEntity | undefined>(undefined)
	const [editedFilter, setEditedFilter] = useState(defaultFilter as M.EditableFilterNode)
	const editedFilterModified = useMemo(() => !deepEqual(filterEntity?.filter, editedFilter), [filterEntity?.filter, editedFilter])
	const userRes = trpcReact.getLoggedInUser.useQuery()
	const navigate = useNavigate()
	const onWatchFilterData = useCallback(
		(e: WatchFilterOutput) => {
			if (e.code === 'initial-value') {
				setFilterEntity(e.entity)
				setEditedFilter(e.entity.filter as M.EditableFilterNode)
				return
			}
			if (e.code === 'mutation') {
				if (e.mutation.type === 'delete') {
					toast({ title: `Filter ${e.mutation.value.name} was deleted by ${e.mutation.username}` })
					navigate(AR.exists('/filters'))
					return
				}
				if (e.mutation.type === 'update') {
					if (!userRes.data?.username || userRes.data.username !== e.mutation.username)
						toast({ title: `Filter ${e.mutation.value.name} was updated by ${e.mutation.username}` })
					else if (userRes.data?.username && userRes.data.username === e.mutation.username) {
						toast({ title: `Updated ${e.mutation.value.name}` })
					}

					setFilterEntity(e.mutation.value)
					setEditedFilter(e.mutation.value.filter as M.EditableFilterNode)
				}
			}
		},
		[setFilterEntity, setEditedFilter, toast, userRes.data?.username, navigate]
	)
	trpcReact.filters.watchFilter.useSubscription(id, { onData: onWatchFilterData })
	const [pageIndex, setPageIndex] = useState(0)
	const validFilter = useMemo(() => {
		return editedFilter && M.isValidFilterNode(editedFilter) ? editedFilter : undefined
	}, [editedFilter])
	const updateFilterMutation = trpcReact.filters.updateFilter.useMutation()
	const deleteFilterMutation = trpcReact.filters.deleteFilter.useMutation()
	const canSaveFilter = editedFilterModified && !!validFilter && !updateFilterMutation.isPending

	if (!editedFilter || !filterEntity) {
		return <FullPageSpinner />
	}

	async function saveFilter() {
		if (!canSaveFilter) return
		const res = await updateFilterMutation.mutateAsync([filterEntity!.id, { filter: validFilter }])
		if (res.code === 'err:not-found') {
			toast({
				title: 'Unable to save: Filter Not Found',
			})
			return
		}
		if (res.code !== 'ok') {
			toast({ title: 'Unable to save: Unknown Error Occured' })
			return
		}
		toast({
			title: 'Filter saved',
		})
	}

	async function onDelete() {
		if (!filterEntity) {
			return
		}
		const res = await deleteFilterMutation.mutateAsync(filterEntity.id)
		if (res.code === 'ok') {
			toast({
				title: `Filter "${filterEntity.name}" deleted`,
			})
			navigate(AR.link('/filters', []))
		} else {
			toast({
				title: `Failed to delete filter "${filterEntity.name}"`,
			})
		}
	}

	return (
		<div className="container mx-auto py-10">
			<div className="w-full flex justify-center items-center">
				<h3 className={Typography.H3 + ' m-auto'}>{filterEntity.name}</h3>
			</div>
			<div className="flex space-x-2">
				<FilterCard
					node={editedFilter}
					setNode={setEditedFilter as SetState<M.EditableFilterNode | undefined>}
					validNode={validFilter}
					filterId={filterEntity.id}
					resetFilter={() => {
						setEditedFilter(filterEntity.filter as M.EditableFilterNode)
					}}
				/>
				<div className="flex flex-col space-y-2">
					<Button disabled={!canSaveFilter} onClick={saveFilter}>
						Save
					</Button>
					<EditFilterDetailsDialog entity={filterEntity}>
						<Button variant="secondary">Edit Details</Button>
					</EditFilterDetailsDialog>
					<DeleteFilterDialog onDelete={onDelete}>
						<Button variant="destructive">Delete</Button>
					</DeleteFilterDialog>
				</div>
			</div>
			<LayerTable filter={validFilter} pageIndex={pageIndex} setPageIndex={setPageIndex} />
		</div>
	)
}

function EditFilterDetailsDialog(props: { children: React.ReactNode; entity: M.FilterEntity }) {
	const updateFiltersMutation = trpcReact.filters.updateFilter.useMutation()
	const [isOpen, _setIsOpen] = useState(false)
	function setIsOpen(isOpen: boolean) {
		if (isOpen) {
			nameRef.current?.focus()
		} else {
			form.reset()
		}
		_setIsOpen(isOpen)
	}

	const toast = useToast()
	const form = useForm({
		defaultValues: {
			name: props.entity.name,
			description: props.entity.description,
		},
		validatorAdapter: zodValidator(),
		onSubmit: async ({ value, formApi }) => {
			const res = await updateFiltersMutation.mutateAsync([props.entity.id, value])
			if (res.code === 'ok') {
				toast.toast({
					title: 'Filter updated',
				})
			} else if (res.code === 'err:not-found') {
				formApi.setErrorMap({ onSubmit: 'Not Found' })
				return
			}
			setIsOpen(false)
		},
	})
	// useEffect(() => {
	// 	form.setFieldValue('name', props.entity.name)
	// 	form.setFieldValue('description', props.entity.description)
	// }, [props.entity.name, props.entity.description, form])

	function onSubmit(e: FormEvent) {
		e.preventDefault()
		e.stopPropagation()
		form.handleSubmit()
	}
	const fieldClasses = 'flex flex-col space-y-2'
	const nameRef = useRef<HTMLInputElement>(null)

	return (
		<Dialog open={isOpen} onOpenChange={setIsOpen}>
			<DialogTrigger asChild>{props.children}</DialogTrigger>
			<DialogContent className="items-center flex flex-col">
				<DialogHeader>
					<DialogTitle>Submit New Filter</DialogTitle>
				</DialogHeader>
				<form onSubmit={onSubmit} className="flex flex-col space-y-4">
					<div className="flex items-center space-x-2">
						<form.Field
							name="name"
							validators={{ onChange: M.FilterUpdateSchema.shape.name }}
							children={(field) => {
								return (
									<div className={fieldClasses}>
										<Label htmlFor={field.name}>{capitalize(field.name)}</Label>
										<Input
											ref={nameRef}
											id={field.name}
											name={field.name}
											value={field.state.value}
											onBlur={field.handleBlur}
											onChange={(e) => field.setValue(e.target.value)}
										/>
									</div>
								)
							}}
						/>
						<div className={fieldClasses}>
							<Label htmlFor="id">Id</Label>
							<Input disabled value={props.entity.id} />
						</div>
					</div>
					<form.Field
						name="description"
						validators={{ onChange: M.FilterUpdateSchema.shape.description }}
						children={(field) => {
							return (
								<div className={fieldClasses}>
									<Label htmlFor={field.name}>{capitalize(field.name)}</Label>
									<Textarea
										id={field.name}
										name={field.name}
										onBlur={field.handleBlur}
										onChange={(e) => field.handleChange(e.target.value)}
									/>
								</div>
							)
						}}
					/>
					{form.state.errors.length > 0 && (
						<Alert variant="destructive">
							<AlertTitle>Errors:</AlertTitle>
							<AlertDescription>{form.state.errors.join(', ')}</AlertDescription>
						</Alert>
					)}
					<div className="flex items-center justify-end">
						<Button type="submit">Save</Button>
					</div>
				</form>
			</DialogContent>
		</Dialog>
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
