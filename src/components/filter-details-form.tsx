import * as Form from '@tanstack/react-form'
import React from 'react'

import { EditDetailsForm, FieldErrors, MarkdownHint } from '@/components/edit-details-dialog'
import { EmojiPickerPopover } from '@/components/emoji-picker-popover'
import { MissExemptionEditor } from '@/components/miss-exemption-editor'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import * as EditFrame from '@/frames/filter-editor.frame.ts'
import * as Zus from '@/lib/zustand'
import * as F_Msgs from '@/messages/filter.messages'
import * as UI_Msgs from '@/messages/ui.messages'
import * as F from '@/models/filter.models'
import { tr } from '@/systems/messages.client'

function idFromName(name: string) {
	return name.toLowerCase().replace(/\s+/g, '-')
}

// The fields of a filter's Edit Details dialog. Apply writes them to the filter's draft. A filter that has not been
// created yet also takes its ID here, which follows the name until it is edited by hand.
export function FilterDetailsForm(props: { stores: EditFrame.KeyProp; creating: boolean; onClose: () => void }) {
	const { stores } = props
	const [meta, colConfig, createId] = Zus.useStore(
		stores.filterEditor,
		Zus.useShallow((s) => [s.meta, s.layerTable.colConfig, s.createId] as const),
	)
	const form = Form.useForm({
		defaultValues: {
			id: createId,
			name: meta.name,
			description: meta.description,
			alertMessage: meta.alertMessage,
			emoji: meta.emoji,
			invertedAlertMessage: meta.invertedAlertMessage,
			invertedEmoji: meta.invertedEmoji,
			// unknown: the recursive node type sends the form's field path types into infinite instantiation
			missExemption: meta.missExemption as unknown,
		},
		onSubmit: ({ value }) => {
			const { id, ...rest } = value
			if (props.creating) EditFrame.Actions.setCreateId(stores, id)
			EditFrame.Actions.setMeta(stores, {
				...rest,
				name: rest.name.trim(),
				description: rest.description?.trim() || null,
				emoji: rest.emoji ?? null,
				alertMessage: rest.alertMessage ?? null,
				invertedEmoji: rest.invertedEmoji ?? null,
				invertedAlertMessage: rest.invertedAlertMessage ?? null,
				// the field's validator holds the form back until the exemption is complete
				missExemption: rest.missExemption as F.FilterNode | null,
			})
			props.onClose()
		},
	})

	const idRef = React.useRef<HTMLInputElement>(null)
	const onNameChange = (name: string, setName: (name: string) => void) => {
		const id = form.getFieldValue('id')
		if (props.creating && idRef.current && (id === '' || id === idFromName(form.getFieldValue('name')))) {
			idRef.current.value = idFromName(name)
			form.setFieldValue('id', idRef.current.value)
		}
		setName(name)
	}

	return (
		<form.Subscribe selector={(v) => [v.canSubmit, v.isDirty] as const}>
			{([canSubmit, isDirty]) => (
				<EditDetailsForm
					onSubmit={() => void form.handleSubmit()}
					onCancel={props.onClose}
					submitLabel={tr.text(UI_Msgs.apply())}
					submitDisabled={!canSubmit || !isDirty}
				>
					<div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
						<div className="space-y-6">
							<div className="space-y-2">
								<form.Field name="name" validators={{ onChange: F.NewFilterEntitySchema.shape.name }}>
									{(field) => {
										const label = tr.text(F_Msgs.nameLabel())
										return (
											<div className="flex flex-col space-y-2">
												<Label htmlFor={field.name}>{label}</Label>
												<Input
													id={field.name}
													placeholder={label}
													defaultValue={field.state.value}
													autoFocus
													onBlur={field.handleBlur}
													onChange={(e) => onNameChange(e.target.value, field.handleChange)}
												/>
												<FieldErrors label={label} errors={field.state.meta.errors} />
											</div>
										)
									}}
								</form.Field>
								{props.creating && (
									<form.Field name="id" validators={{ onChange: F.NewFilterEntitySchema.shape.id }}>
										{(field) => {
											const label = tr.text(F_Msgs.idLabel())
											return (
												<div className="flex flex-col space-y-2">
													<Label htmlFor={field.name}>{label}</Label>
													<Input
														id={field.name}
														placeholder={label}
														ref={idRef}
														defaultValue={field.state.value}
														className="font-mono"
														onBlur={field.handleBlur}
														onChange={(e) => field.handleChange(e.target.value.trim())}
													/>
													<FieldErrors label={label} errors={field.state.meta.errors} />
												</div>
											)
										}}
									</form.Field>
								)}
							</div>

							<div className="border rounded-lg p-4 space-y-4">
								<h3 className="font-semibold text-sm">{tr.text(F_Msgs.matchIndicator())}</h3>
								<div className="flex gap-4">
									<form.Field name="emoji">
										{(field) => {
											const label = tr.text(F_Msgs.emojiLabel())
											return (
												<div className="flex flex-col space-y-2">
													<Label htmlFor={field.name}>{label}</Label>
													<EmojiPickerPopover
														value={field.state.value ?? undefined}
														onSelect={(id) => field.handleChange(id?.trim() ?? null)}
														disabled={false}
													/>
													<FieldErrors label={label} errors={field.state.meta.errors} />
												</div>
											)
										}}
									</form.Field>
									<form.Field name="alertMessage" validators={{ onChange: F.AlertMessageSchema.nullable() }}>
										{(field) => {
											const label = tr.text(F_Msgs.alertMessageLabel())
											return (
												<div className="flex flex-col space-y-2 grow">
													<Label htmlFor={field.name}>{label}</Label>
													<Textarea
														id={field.name}
														placeholder={label}
														defaultValue={field.state.value ?? ''}
														onBlur={field.handleBlur}
														onChange={(e) => field.handleChange(e.target.value.trim() || null)}
														rows={3}
													/>
													<FieldErrors label={label} errors={field.state.meta.errors} />
												</div>
											)
										}}
									</form.Field>
								</div>
							</div>

							<div className="border rounded-lg p-4 space-y-4">
								<h3 className="font-semibold text-sm">{tr.text(F_Msgs.missIndicator())}</h3>
								<div className="flex gap-4">
									<form.Field name="invertedEmoji">
										{(field) => {
											const label = tr.text(F_Msgs.emojiLabel())
											return (
												<div className="flex flex-col space-y-2">
													<Label htmlFor={field.name}>{label}</Label>
													<EmojiPickerPopover
														value={field.state.value ?? undefined}
														onSelect={(id) => field.handleChange(id ?? null)}
														disabled={false}
													/>
													<FieldErrors label={label} errors={field.state.meta.errors} />
												</div>
											)
										}}
									</form.Field>
									<form.Field name="invertedAlertMessage" validators={{ onChange: F.AlertMessageSchema.nullable() }}>
										{(field) => {
											const label = tr.text(F_Msgs.alertMessageLabel())
											return (
												<div className="flex flex-col space-y-2 grow">
													<Label htmlFor={field.name}>{label}</Label>
													<Textarea
														id={field.name}
														placeholder={label}
														defaultValue={field.state.value ?? ''}
														onBlur={field.handleBlur}
														onChange={(e) => field.handleChange(e.target.value.trim() || null)}
														rows={3}
													/>
													<FieldErrors label={label} errors={field.state.meta.errors} />
												</div>
											)
										}}
									</form.Field>
								</div>
								<form.Field
									name="missExemption"
									validators={{
										onChange: ({ value }) =>
											value && !F.isValidFilterNode(value as F.EditableFilterNode)
												? tr.text(F_Msgs.missExemptionIncomplete())
												: undefined,
									}}
								>
									{(field) => (
										<div className="flex flex-col gap-2">
											<MissExemptionEditor
												defaultValue={meta.missExemption}
												onChange={field.handleChange}
												colConfig={colConfig}
											/>
											<FieldErrors errors={field.state.meta.errors} />
										</div>
									)}
								</form.Field>
							</div>
						</div>

						<div className="flex flex-col">
							<form.Field name="description" validators={{ onChange: F.DescriptionSchema.nullable() }}>
								{(field) => {
									const label = tr.text(F_Msgs.descriptionLabel())
									return (
										<div className="flex flex-col space-y-2 grow">
											<Label htmlFor={field.name}>{label}</Label>
											<MarkdownHint id={`${field.name}-hint`} />
											<Textarea
												id={field.name}
												aria-describedby={`${field.name}-hint`}
												placeholder={label}
												defaultValue={field.state.value ?? ''}
												onBlur={field.handleBlur}
												onChange={(e) => field.handleChange(e.target.value.trim() || null)}
												rows={15}
												className="font-mono text-sm grow"
											/>
											<FieldErrors label={label} errors={field.state.meta.errors} />
										</div>
									)
								}}
							</form.Field>
						</div>
					</div>
				</EditDetailsForm>
			)}
		</form.Subscribe>
	)
}
