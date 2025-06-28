import * as AR from '@/app-routes.ts'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useToast } from '@/hooks/use-toast'
import { assertNever } from '@/lib/type-guards'
import * as EFB from '@/models/editable-filter-builders.ts'
import * as F from '@/models/filter.models'
import * as L from '@/models/layer'
import { useFilterCreate } from '@/systems.client/filter-entity.client.ts'
import { invalidateLoggedInUser } from '@/systems.client/users.client'
import * as Form from '@tanstack/react-form'
import { useState } from 'react'
import React from 'react'
import { useNavigate } from 'react-router-dom'
import { z } from 'zod'
import FilterCard from './filter-card'
import LayerTable from './layer-table'
import { Alert, AlertDescription, AlertTitle } from './ui/alert'
import { Label } from './ui/label'
import { Textarea } from './ui/textarea'

const DEFAULT_FILTER: F.EditableFilterNode = EFB.and()

export default function FilterNew() {
	// -------- set title --------
	React.useEffect(() => {
		document.title = 'SLM - New Filter'
	}, [])

	const { toast } = useToast()
	const navigate = useNavigate()
	const createFilterMutation = useFilterCreate()

	const [editedFilter, _setEditedFilter] = useState<F.EditableFilterNode>(DEFAULT_FILTER)
	const [validFilter, setValidFilter] = useState<F.FilterNode | null>(null)
	const setEditedFilter: React.Dispatch<React.SetStateAction<F.EditableFilterNode | undefined>> = (update) => {
		_setEditedFilter((filter) => {
			const newFilter = typeof update === 'function' ? update(filter) : update
			if (!newFilter) return DEFAULT_FILTER
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

	const form = Form.useForm({
		defaultValues: {
			id: '',
			name: '',
			description: '',
		},
		onSubmit: async ({ value }) => {
			const description = value.description?.trim() || null
			const validFilter = F.isValidFilterNode(editedFilter) ? editedFilter : null

			if (!validFilter) {
				toast({ title: 'Invalid filter', description: 'Please check filter configuration' })
				return
			}

			const res = await createFilterMutation.mutateAsync({
				...value,
				description,
				filter: validFilter,
			})

			switch (res.code) {
				case 'ok':
					invalidateLoggedInUser()
					toast({ title: 'Filter created' })
					navigate(AR.link(`/filters/:id`, value.id))
					break

				default:
					assertNever(res.code)
			}
		},
	})

	const [pageIndex, setPageIndex] = useState(0)

	const [selectedLayers, setSelectedLayers] = React.useState([] as L.LayerId[])
	const submitBtn = (
		<form.Subscribe>
			{(f) => (
				<Button onClick={form.handleSubmit} disabled={!f.canSubmit || !validFilter}>
					Create
				</Button>
			)}
		</form.Subscribe>
	)
	return (
		<div className="container mx-auto py-10">
			<div className="flex w-full space-x-2">
				<div className="flex flex-col space-y-4">
					<form.Field name="name" validators={{ onChange: F.NewFilterEntitySchema.shape.name }}>
						{(field) => {
							function handleNameChange(name: string) {
								field.handleChange(name)
								if (!!form.getFieldValue('id').trim() && form.getFieldMeta('id')!.isDirty) return
								form.setFieldValue('id', name.toLowerCase().replace(/\s+/g, '-'), { dontUpdateMeta: true })
								form.setFieldMeta('id', (m) => ({ ...m, errors: [], errorMap: {} }))
							}

							return (
								<div className="flex flex-col space-y-2 max-w-[300px]">
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
											<AlertTitle>Errors for {field.name}</AlertTitle>
											<AlertDescription>{field.state.meta.errors.join(', ')}</AlertDescription>
										</Alert>
									)}
								</div>
							)
						}}
					</form.Field>

					<form.Field name="id" validators={{ onChange: F.NewFilterEntitySchema.shape.id }}>
						{(field) => {
							return (
								<div className="flex flex-col space-y-2 max-w-[300px]">
									<Label htmlFor={field.name}>ID</Label>
									<Input
										id={field.name}
										placeholder="Filter ID"
										defaultValue={field.state.value}
										onBlur={field.handleBlur}
										onChange={(e) => field.handleChange(e.target.value.trim() ?? null)}
									/>
									{field.state.meta.errors.length > 0 && (
										<Alert variant="destructive">
											<AlertTitle>Errors for {field.name}</AlertTitle>
											<AlertDescription>{field.state.meta.errors.join(', ')}</AlertDescription>
										</Alert>
									)}
								</div>
							)
						}}
					</form.Field>
				</div>

				<form.Field name="description" validators={{ onChange: z.union([F.FilterEntityDescriptionSchema, z.string().length(0)]) }}>
					{(field) => (
						<div className="flex space-x-2">
							<div className="flex flex-col space-y-2  min-w-[800px]">
								<Label htmlFor={field.name}>Description</Label>
								<Textarea
									id={field.name}
									placeholder="Description"
									defaultValue={field.state.value ?? ''}
									onBlur={field.handleBlur}
									onChange={(e) => field.setValue(e.target.value)}
									rows={15}
								/>
							</div>
							{field.state.meta.errors.length > 0 && (
								<Alert variant="destructive">
									<AlertTitle>Errors for {field.name}</AlertTitle>
									<AlertDescription>{field.state.meta.errors.join(', ')}</AlertDescription>
								</Alert>
							)}
						</div>
					)}
				</form.Field>
			</div>
			<FilterCard
				node={editedFilter}
				setNode={setEditedFilter}
				resetFilter={() => {
					setEditedFilter(DEFAULT_FILTER)
				}}
			>
				{submitBtn}
			</FilterCard>

			<LayerTable
				selected={selectedLayers}
				setSelected={setSelectedLayers}
				queryContext={{
					constraints: validFilter
						? [{ type: 'filter-anon', filter: validFilter, applyAs: 'where-condition', id: 'filter-new' }]
						: undefined,
				}}
				pageIndex={pageIndex}
				setPageIndex={setPageIndex}
			/>
		</div>
	)
}
