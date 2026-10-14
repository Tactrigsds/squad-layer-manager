import React from 'react'

import * as Templating from '@/lib/templating'
import * as ZodUtils from '@/lib/zod-utils'
import * as Zus from '@/lib/zustand'
import * as AMS_Msgs from '@/messages/admin-message-shorthands.messages'
import * as AMS from '@/models/admin-message-shorthands.models'
import { tr } from '@/systems/messages.client'
import * as SettingsClient from '@/systems/settings.client'

import ComboBox, { type ComboBoxHandle } from './combo-box/combo-box'
import { Input } from './ui/input'
import { Label } from './ui/label'
import { useBlockDialogSubmit } from './ui/lazy-alert-dialog'

const CUSTOM = '__custom__'

// reason picker for action confirmation dialogs: a preset dropdown, plus (when the action allows free text, i.e.
// `customRef` is passed) a custom-reason input shown only while "Custom" is selected. Writes the chosen preset
// label to `presetRef` and any custom text to `customRef` (refs because the alert dialog unmounts its content on
// confirm). Preset-only actions with no configured presets render nothing.
export function ReasonPicker(props: {
	action: AMS.AdminActionType
	presetRef: React.MutableRefObject<string>
	// pass when free-text reasons are allowed for this action (warn/kill/kick); omit for preset-only actions
	customRef?: React.MutableRefObject<string>
	// when true a reason is mandatory: the dialog's action buttons stay disabled until one is given
	required?: boolean
	// for timeouts: the currently-entered duration, so the preview can resolve {{duration}} live
	durationMs?: number
	// for squad-targeted actions: the target squad's name, so the preview can resolve {{squadName}}
	squadName?: string
	// mount with the preset dropdown already open. Off for dialogs whose first field is something else.
	autoOpen?: boolean
}) {
	const reasons = Zus.useStore(SettingsClient.PublicSettingsStore, (s) =>
		s ? AMS.shorthandsForAction(s.adminMessageShorthands, props.action) : [],
	)
	const { presetRef, customRef } = props
	const allowCustom = !!customRef
	const [selected, setSelected] = React.useState(() => presetRef.current || CUSTOM)
	// mirror the custom input into state so the message preview updates as the admin types
	const [customText, setCustomText] = React.useState(() => customRef?.current ?? '')
	const autoOpen = (props.autoOpen ?? true) && reasons.length > 0
	const given = selected !== CUSTOM || (allowCustom && customText.trim().length > 0)
	const comboRef = React.useRef<ComboBoxHandle>(null)
	useBlockDialogSubmit(!!props.required && !given)
	// deferred by a frame: opening during mount loses the popover to the closing context menu's focus restore
	React.useEffect(() => {
		if (!autoOpen) return
		const raf = requestAnimationFrame(() => comboRef.current?.focus())
		return () => cancelAnimationFrame(raf)
	}, [autoOpen])
	if (reasons.length === 0 && !allowCustom) {
		// preset-only action with nothing configured: when a reason is required the dialog can't proceed, so say
		// why instead of silently rendering nothing
		if (props.required) {
			return (
				<p className="text-xs text-destructive">
					{tr.text(AMS_Msgs.noShorthandsConfigured(tr.text(AMS_Msgs.actionNames[props.action])))}
				</p>
			)
		}
		return null
	}

	const customVisible = allowCustom && (reasons.length === 0 || selected === CUSTOM)
	const selectedReason = selected === CUSTOM ? undefined : reasons.find((r) => r.label === selected)
	return (
		<div className="grid gap-2">
			<Label>
				{tr.richText(
					AMS_Msgs.reasonLabel(
						props.required ? (
							<span className="text-destructive">{tr.text(AMS_Msgs.reasonRequired())}</span>
						) : (
							<span className="text-muted-foreground">{tr.text(AMS_Msgs.reasonOptional())}</span>
						),
					),
				)}
			</Label>
			{reasons.length > 0 && (
				<ComboBox
					ref={comboRef}
					title={tr.text(AMS_Msgs.reasonPicker())}
					className="w-full"
					value={selected}
					// configured order, with Custom/None pinned first
					sort={false}
					options={[
						{ value: CUSTOM, label: allowCustom ? tr.text(AMS_Msgs.customReason()) : tr.text(AMS_Msgs.noReason()) },
						...reasons.map((reason) => ({
							value: reason.label,
							keywords: reason.keywords,
							description: AMS.shorthandText(props.action, reason),
						})),
					]}
					onSelect={(value) => {
						const next = value ?? CUSTOM
						setSelected(next)
						presetRef.current = next === CUSTOM ? '' : next
					}}
				/>
			)}
			{customVisible && (
				<Input
					autoComplete="off"
					placeholder={tr.text(AMS_Msgs.enterReason())}
					defaultValue={customRef!.current}
					onChange={(e) => {
						customRef!.current = e.target.value
						setCustomText(e.target.value)
					}}
				/>
			)}
			<ReasonMessagePreview
				action={props.action}
				reason={selectedReason}
				customText={customVisible ? customText : undefined}
				durationMs={props.durationMs}
				squadName={props.squadName}
			/>
		</div>
	)
}

// renders the exact in-game text a player will receive for the chosen reason + action, mirroring the settings-page
// reason preview. reason (a selected preset) takes precedence over customText (free-text). For timeouts {{duration}}
// resolves to the entered duration (empty while it's unparseable, so {{#duration}} sections drop out); other
// {{variables}} come from the configured Message Variables. Renders nothing until there's some text to show.
export function ReasonMessagePreview(props: {
	action: AMS.AdminActionType
	reason?: AMS.AdminMessageShorthand
	customText?: string
	durationMs?: number
	squadName?: string
}) {
	const messageVariables = Zus.useStore(SettingsClient.PublicSettingsStore, (s) => s?.messageVariables ?? [])
	const custom = props.customText?.trim()
	if (!props.reason && !custom) return null

	const base: Record<string, string> = { squadName: props.squadName ?? '' }
	if (props.action === 'timeout')
		base.duration = props.durationMs && props.durationMs > 0 ? ZodUtils.formatHumanTime(props.durationMs) : ''
	const vars = Templating.resolveTemplateVars(messageVariables, base)
	const text = props.reason ? AMS.formatShorthand(props.action, props.reason, { vars }) : Templating.renderTemplate(custom!, vars)

	return (
		<div className="grid gap-1">
			<span className="text-xs text-muted-foreground">{tr.text(AMS_Msgs.messagePreview())}</span>
			<MessagePreviewBox>{text}</MessagePreviewBox>
		</div>
	)
}

// the amber "this is what gets delivered in-game" box, shared with the settings-page reason preview
export function MessagePreviewBox(props: { children: React.ReactNode }) {
	return <p className="rounded border border-amber-500/40 bg-warn/10 p-2 text-xs whitespace-pre-wrap">{props.children}</p>
}
