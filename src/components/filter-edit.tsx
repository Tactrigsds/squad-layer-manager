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
import { SetState } from '@/lib/react'
import { capitalize } from '@/lib/text'
import { trpcReact } from '@/lib/trpc.client'
import * as Typography from '@/lib/typography'
import * as M from '@/models.ts'
import { useForm } from '@tanstack/react-form'
import { zodValidator } from '@tanstack/zod-form-adapter'
import { FormEvent, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { FilterNodeDisplay } from './filter-card'
import LayerTable from './layer-table'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from './ui/dialog'
import { Label } from './ui/label'
import { Textarea } from './ui/textarea'

const defaultFilter: M.EditableFilterNode = {
	type: 'and',
	children: [],
}

export default function FilterEdit() {
	const { id } = useAppParams(AR.exists('/filters/:id/edit'))
	const filtersReq = trpcReact.getFilters.useQuery()
	const originalFilterEntity = filtersReq.data?.find((f) => f.id === id)
	console.log('originalFilterEntity', originalFilterEntity)
	const { toast } = useToast()

	const [tsLastEdit, setTsLastEdit] = useState(null as null | number)
	const [editedFilter, _setEditedFilter] = useState(defaultFilter as M.EditableFilterNode)
	const [pageIndex, setPageIndex] = useState(0)
	const filterModified = tsLastEdit && tsLastEdit > filtersReq.dataUpdatedAt
	const filter: M.EditableFilterNode | undefined = filterModified
		? editedFilter
		: (originalFilterEntity?.filter as M.EditableFilterNode | undefined)
	const validFilter = useMemo(() => {
		return filter && M.isValidFilterNode(filter) ? filter : undefined
	}, [filter])
	const updateFilterMutation = trpcReact.updateFilter.useMutation()
	const deleteFilterMutation = trpcReact.deleteFilter.useMutation()
	const canSaveFilter = !!filterModified && !!validFilter && !updateFilterMutation.isPending
	const navigate = useNavigate()

	if (!filter) {
		return <div>Loading...</div>
	}
	if (!originalFilterEntity) {
		return <div>Filter not found</div>
	}

	function setEditedFilter(update: (prev: M.EditableFilterNode) => M.EditableFilterNode) {
		if (!filter) {
			console.warn('setEditedFilter called with no filter')
			return
		}
		const newFilter = update(filter)
		if (!editedFilter) {
			_setEditedFilter(newFilter)
			return
		}
		setPageIndex(0)
		setTsLastEdit(Date.now())
		_setEditedFilter(newFilter)
	}
	async function saveFilter() {
		if (!canSaveFilter) return
		const code = await updateFilterMutation.mutateAsync([originalFilterEntity!.id, { filter: validFilter }])
		if (code !== 'success') {
			toast({
				title: 'Failed to save filter',
			})
			return
		}
		toast({
			title: 'Filter saved',
		})
		filtersReq.refetch()
	}
	async function onDelete() {
		if (!originalFilterEntity) {
			return
		}
		const res = await deleteFilterMutation.mutateAsync(originalFilterEntity.id)
		if (res.code === 'ok') {
			toast({
				title: `Filter "${originalFilterEntity.name}" deleted`,
			})
			navigate(AR.link('/filters'))
		} else {
			toast({
				title: `Failed to delete filter "${originalFilterEntity.name}"`,
			})
		}
	}

	return (
		<div className="container mx-auto py-10">
			<div className="w-full flex justify-center items-center">
				<h3 className={Typography.H3 + ' m-auto'}>{originalFilterEntity.name}</h3>
			</div>
			<div className="flex space-x-2">
				<FilterNodeDisplay node={filter} setNode={setEditedFilter as SetState<M.EditableFilterNode | undefined>} depth={0} />
				<div className="flex flex-col space-y-2">
					<Button disabled={!canSaveFilter} onClick={saveFilter}>
						Save
					</Button>
					<EditFilterDetailsDialog entity={originalFilterEntity} onEdited={() => filtersReq.refetch()}>
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

function EditFilterDetailsDialog(props: { children: React.ReactNode; entity: M.FilterEntity; onEdited: () => void }) {
	const updateFiltersMutation = trpcReact.updateFilter.useMutation()
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
		onSubmit: async ({ value }) => {
			const code = await updateFiltersMutation.mutateAsync([props.entity.id, value])
			if (code === 'success') {
				toast.toast({
					title: 'Filter updated',
				})
			} else if (code === 'not-found') {
				toast.toast({
					title: 'Filter not found',
				})
			}
			setIsOpen(false)
			props.onEdited()
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
										value={field.state.value}
										onBlur={field.handleBlur}
										onChange={(e) => field.handleChange(e.target.value)}
									/>
								</div>
							)
						}}
					/>
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
