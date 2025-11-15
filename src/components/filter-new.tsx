import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type * as EditFrame from '@/frames/filter-editor.frame.ts'
import { getFrameState, useFrameStore } from '@/frames/frame-manager'
import { useToast } from '@/hooks/use-toast'
import { assertNever } from '@/lib/type-guards'
import * as F from '@/models/filter.models'
import { useFilterCreate } from '@/systems.client/filter-entity.client.ts'
import { invalidateLoggedInUser } from '@/systems.client/users.client'
import * as Form from '@tanstack/react-form'
import { useNavigate } from '@tanstack/react-router'
import React from 'react'
import { z } from 'zod'
import { EmojiPickerPopover } from './emoji-picker-popover'
import FilterCard from './filter-card'
import { FilterValidationErrorDisplay } from './filter-extra-errors'
import LayerTable from './layer-table'
import { Alert, AlertDescription, AlertTitle } from './ui/alert'
import { Label } from './ui/label'
import { Textarea } from './ui/textarea'

export default function FilterNew(props: { frameKey: EditFrame.Key }) {
	const { toast } = useToast()
	const navigate = useNavigate()
	const createFilterMutation = useFilterCreate()

	const form = Form.useForm({
		defaultValues: {
			id: '',
			name: '',
			description: '',
			alertMessage: '',
			emoji: null as string | null,
		},
		onSubmit: async ({ value }) => {
			const description = value.description?.trim() || null
			const state = getFrameState(props.frameKey)

			if (!state.validatedFilter) {
				toast({ title: 'Invalid filter', description: 'Please check filter configuration' })
				return
			}

			const res = await createFilterMutation.mutateAsync({
				...value,
				description,
				emoji: value.emoji ?? null,
				alertMessage: value.alertMessage?.trim() || null,
				filter: state.validatedFilter,
			})

			switch (res.code) {
				case 'ok':
					invalidateLoggedInUser()
					toast({ title: 'Filter created' })
					void navigate({ to: `/filters/$filterId`, params: { filterId: value.id } })
					break

				default:
					assertNever(res.code)
			}
		},
	})

	const isValidFilter = useFrameStore(props.frameKey, s => s.valid)

	const submitBtn = React.useMemo(() => (
		<form.Subscribe>
			{(f) => (
				<Button onClick={form.handleSubmit} disabled={!f.canSubmit || !isValidFilter}>
					Create
				</Button>
			)}
		</form.Subscribe>
	), [form, isValidFilter])

	const filterCard = React.useMemo(() => (
		<FilterCard frameKey={props.frameKey}>
			{submitBtn}
		</FilterCard>
	), [props.frameKey, submitBtn])

	return (
		<div className="container mx-auto py-10">
			<div className="flex w-full space-x-2">
				<div className="flex flex-col space-y-4">
					<form.Field name="name" validators={{ onChange: F.NewFilterEntitySchema.shape.name }}>
						{(field) => {
							const label = 'Name'
							function handleNameChange(name: string) {
								field.handleChange(name)
								if (!!form.getFieldValue('id').trim() && form.getFieldMeta('id')!.isDirty) return
								form.setFieldValue('id', name.toLowerCase().replace(/\s+/g, '-'), { dontUpdateMeta: true })
								form.setFieldMeta('id', (m) => ({ ...m, errors: [], errorMap: {} }))
							}

							return (
								<div className="flex flex-col space-y-2 max-w-[300px]">
									<Label htmlFor={field.name}>{label}</Label>
									<Input
										id={field.name}
										placeholder={label}
										defaultValue={field.state.value}
										onBlur={field.handleBlur}
										onChange={(e) => handleNameChange(e.target.value)}
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

					<form.Field name="id" validators={{ onChange: F.NewFilterEntitySchema.shape.id }}>
						{(field) => {
							const label = 'ID'
							return (
								<div className="flex flex-col space-y-2 max-w-[300px]">
									<Label htmlFor={field.name}>{label}</Label>
									<Input
										id={field.name}
										placeholder={label}
										defaultValue={field.state.value}
										onBlur={field.handleBlur}
										onChange={(e) => field.handleChange(e.target.value.trim() ?? null)}
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

					<form.Field name="emoji">
						{(field) => {
							const label = 'Emoji'
							return (
								<div className="flex flex-col space-y-2 max-w-[300px]">
									<Label htmlFor={field.name}>{label}</Label>
									<EmojiPickerPopover
										value={field.state.value ?? undefined}
										onSelect={(emoji) => field.handleChange(emoji ?? null)}
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
						validators={{ onChange: z.union([F.AlertMessageSchema, z.string().trim().length(0)]) }}
					>
						{(field) => {
							const label = 'Alert Message'
							return (
								<div className="flex flex-col space-y-2 max-w-[300px]">
									<Label htmlFor={field.name}>{label}</Label>
									<Textarea
										id={field.name}
										placeholder={label}
										defaultValue={field.state.value ?? ''}
										onBlur={field.handleBlur}
										onChange={(e) => field.setValue(e.target.value)}
										rows={5}
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
				<form.Field
					name="description"
					validators={{ onChange: F.DescriptionSchema }}
				>
					{(field) => {
						const label = 'Description'
						return (
							<div className="flex flex-grow space-x-2">
								<div className="flex min-w-[900px] flex-col space-y-1">
									<Label htmlFor={field.name}>{label}</Label>
									<Textarea
										id={field.name}
										placeholder={label}
										defaultValue={field.state.value ?? ''}
										onBlur={field.handleBlur}
										onChange={(e) => field.handleChange(e.target.value?.trim() ?? null)}
										rows={15}
									/>
								</div>
								{field.state.meta.errors.length > 0 && (
									<span>
										<Alert variant="destructive">
											<AlertTitle>{label}:</AlertTitle>
											<AlertDescription>{field.state.meta.errors.join(', ')}</AlertDescription>
										</Alert>
									</span>
								)}
							</div>
						)
					}}
				</form.Field>
			</div>
			<FilterValidationErrorDisplay frameKey={props.frameKey} />
			{filterCard}
			<LayerTable frameKey={props.frameKey} />
		</div>
	)
}
