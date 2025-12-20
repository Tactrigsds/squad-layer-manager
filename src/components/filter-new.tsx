import { Input } from '@/components/ui/input'
import type * as EditFrame from '@/frames/filter-editor.frame.ts'
import { getFrameState, useFrameStore } from '@/frames/frame-manager'
import { useToast } from '@/hooks/use-toast'
import { assertNever } from '@/lib/type-guards'
import * as F from '@/models/filter.models'
import { useFilterCreate } from '@/systems/filter-entity.client'
import { invalidateLoggedInUser } from '@/systems/users.client'
import * as Form from '@tanstack/react-form'
import { useNavigate } from '@tanstack/react-router'
import React from 'react'
import { z } from 'zod'
import { EmojiPickerPopover } from './emoji-picker-popover'
import FilterCard from './filter-card'
import { FilterValidationErrorDisplay } from './filter-extra-errors'
import LayerTable from './layer-table'
import { Alert, AlertDescription, AlertTitle } from './ui/alert'
import { Button } from './ui/button'
import { Label } from './ui/label'
import { Textarea } from './ui/textarea'

type FormData = {
	id: string
	name: string
	description: string
	alertMessage: string
	emoji: string | null
	invertedAlertMessage: string
	invertedEmoji: string | null
}

export default function FilterNew(props: { frameKey: EditFrame.Key }) {
	const { toast } = useToast()
	const navigate = useNavigate()
	const createFilterMutation = useFilterCreate()

	const form = Form.useForm<FormData>({
		defaultValues: {
			id: '',
			name: '',
			description: '',
			alertMessage: '',
			emoji: null as string | null,
			invertedAlertMessage: '',
			invertedEmoji: null as string | null,
		},
		onSubmit: async ({ value }) => {
			const state = getFrameState(props.frameKey)

			if (!state.validatedFilter) {
				toast({ title: 'Invalid filter', description: 'Please check filter configuration' })
				return
			}

			const res = await createFilterMutation.mutateAsync({
				id: value.id,
				name: value.name,
				description: value.description?.trim() || null,
				emoji: value.emoji ?? null,
				alertMessage: value.alertMessage?.trim() || null,
				invertedEmoji: value.invertedEmoji ?? null,
				invertedAlertMessage: value.invertedAlertMessage?.trim() || null,
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
			<div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
				{/* Left Column - Form Fields */}
				<div className="space-y-6">
					{/* Name and ID Section */}
					<div className="space-y-2">
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
									<div className="flex flex-col space-y-2">
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
									<div className="flex flex-col space-y-2">
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
										<div className="flex flex-col space-y-2 flex-grow">
											<Label htmlFor={field.name}>{label}</Label>
											<Textarea
												id={field.name}
												placeholder={label}
												defaultValue={field.state.value ?? ''}
												onBlur={field.handleBlur}
												onChange={(e) => field.setValue(e.target.value)}
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
								name="invertedAlertMessage"
								validators={{ onChange: z.union([F.AlertMessageSchema, z.string().trim().length(0)]) }}
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
												onChange={(e) => field.setValue(e.target.value)}
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
				<form.Field
					name="description"
					validators={{ onChange: F.DescriptionSchema }}
				>
					{(field) => {
						const label = 'Description'
						return (
							<div className="flex flex-col space-y-2">
								<Label htmlFor={field.name}>{label}</Label>
								<Textarea
									id={field.name}
									placeholder={label}
									defaultValue={field.state.value ?? ''}
									onBlur={field.handleBlur}
									onChange={(e) => field.handleChange(e.target.value?.trim() ?? null)}
									rows={20}
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
			</div>

			<FilterValidationErrorDisplay frameKey={props.frameKey} />
			<div className="mt-6">
				{filterCard}
			</div>
			<LayerTable frameKey={props.frameKey} />
		</div>
	)
}
