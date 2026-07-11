import { renderTemplate } from '@/lib/templating'
import { formatHumanTime } from '@/lib/zod'
import * as ZusUtils from '@/lib/zustand'
import * as AAR from '@/models/admin-action-reasons.models'
import type * as RBAC from '@/rbac.models'
import * as SettingsClient from '@/systems/settings.client'
import React from 'react'
import { PermissionDeniedTooltip } from './permission-denied-tooltip'
import type { MenuSlots } from './player-context-menu-options'
import { Input } from './ui/input'
import { Label } from './ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select'

// the Warn menu entry: a flat item when no warn presets are configured (today's behavior), otherwise a sub-menu
// with Custom (the flat item's behavior) first, then the configured presets
export function WarnReasonsSub(props: {
	slots: MenuSlots
	denied: RBAC.PermissionDeniedResponse | null
	disabled?: boolean
	label?: string
	onCustom: () => void
	onPreset: (reason: AAR.AdminActionReason) => void
}) {
	const { Item, Separator, Sub, SubTrigger, SubContent } = props.slots
	const reasons = ZusUtils.useStore(
		SettingsClient.PublicSettingsStore,
		s => s ? AAR.reasonsForAction(s.adminActionReasons, 'warn') : [],
	)
	const label = props.label ?? 'Warn'
	const disabled = !!props.denied || props.disabled

	if (reasons.length === 0) {
		return (
			<PermissionDeniedTooltip denied={props.denied}>
				<Item onClick={props.onCustom} disabled={disabled}>
					{label}
				</Item>
			</PermissionDeniedTooltip>
		)
	}

	return (
		<PermissionDeniedTooltip denied={props.denied}>
			<Sub>
				<SubTrigger disabled={disabled}>{label}</SubTrigger>
				<SubContent>
					<Item onClick={props.onCustom}>Custom</Item>
					<Separator />
					{reasons.map(reason => (
						<Item key={reason.label} onClick={() => props.onPreset(reason)}>
							<span title={reason.message}>{reason.label}</span>
						</Item>
					))}
				</SubContent>
			</Sub>
		</PermissionDeniedTooltip>
	)
}

const CUSTOM = '__custom__'

// reason picker for action confirmation dialogs: a preset dropdown, plus (when the action allows free text, i.e.
// `customRef` is passed) a custom-reason input shown only while "Custom" is selected. Writes the chosen preset
// label to `presetRef` and any custom text to `customRef` (refs because the alert dialog unmounts its content on
// confirm). Preset-only actions with no configured presets render nothing.
export function ReasonPicker(props: {
	action: AAR.AdminActionType
	presetRef: React.MutableRefObject<string>
	// pass when free-text reasons are allowed for this action (warn/kill/kick); omit for preset-only actions
	customRef?: React.MutableRefObject<string>
	// when true a reason is mandatory (enforced on submit); reflected in the label
	required?: boolean
	// for kicks: the currently-entered timeout, so the preview can resolve {{duration}} live (undefined = no timeout)
	durationMs?: number
}) {
	const reasons = ZusUtils.useStore(
		SettingsClient.PublicSettingsStore,
		s => s ? AAR.reasonsForAction(s.adminActionReasons, props.action) : [],
	)
	const allowCustom = !!props.customRef
	const [selected, setSelected] = React.useState(() => props.presetRef.current || CUSTOM)
	// mirror the custom input into state so the message preview updates as the admin types
	const [customText, setCustomText] = React.useState(() => props.customRef?.current ?? '')
	if (reasons.length === 0 && !allowCustom) {
		// preset-only action with nothing configured: when a reason is required the dialog can't proceed, so say
		// why instead of silently rendering nothing
		if (props.required) {
			return (
				<p className="text-xs text-destructive">
					A reason is required for{' '}
					{AAR.ADMIN_ACTIONS[props.action].displayName}, but no reasons are configured for it (see Admin Action Reasons in settings).
				</p>
			)
		}
		return null
	}

	const customVisible = allowCustom && (reasons.length === 0 || selected === CUSTOM)
	const selectedReason = selected === CUSTOM ? undefined : reasons.find(r => r.label === selected)
	return (
		<div className="grid gap-2">
			<Label>
				Reason
				{props.required
					? <span className="text-destructive">{' '}(required)</span>
					: <span className="text-muted-foreground">{' '}(optional)</span>}
			</Label>
			{reasons.length > 0 && (
				<Select
					value={selected}
					onValueChange={value => {
						setSelected(value)
						props.presetRef.current = value === CUSTOM ? '' : value
					}}
				>
					<SelectTrigger>
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value={CUSTOM}>{allowCustom ? 'Custom' : 'None'}</SelectItem>
						{reasons.map(reason => (
							<SelectItem key={reason.label} value={reason.label} title={reason.message}>
								{reason.label}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			)}
			{customVisible && (
				<Input
					autoComplete="off"
					placeholder="Enter a reason"
					defaultValue={props.customRef!.current}
					onChange={e => {
						props.customRef!.current = e.target.value
						setCustomText(e.target.value)
					}}
				/>
			)}
			<ReasonMessagePreview
				action={props.action}
				reason={selectedReason}
				customText={customVisible ? customText : undefined}
				durationMs={props.durationMs}
			/>
		</div>
	)
}

// renders the exact in-game text a player will receive for the chosen reason + action, mirroring the settings-page
// reason preview. reason (a selected preset) takes precedence over customText (free-text). {{duration}} resolves to
// the passed kick timeout (empty when none, so {{#duration}} sections drop out); other {{variables}} come from the
// configured Message Variables. Renders nothing until there's some text to show.
export function ReasonMessagePreview(props: {
	action: AAR.AdminActionType
	reason?: AAR.AdminActionReason
	customText?: string
	durationMs?: number
}) {
	const customVars = ZusUtils.useStore(
		SettingsClient.PublicSettingsStore,
		s => Object.fromEntries((s?.messageVariables ?? []).map(v => [v.name, v.value])) as Record<string, string>,
	)
	const custom = props.customText?.trim()
	if (!props.reason && !custom) return null

	const vars: Record<string, string> = { ...customVars }
	if (props.action === 'kick') vars.duration = props.durationMs && props.durationMs > 0 ? formatHumanTime(props.durationMs) : ''
	const text = props.reason
		? AAR.formatAppliedReason(props.action, props.reason, { vars })
		: renderTemplate(custom!, vars)

	return (
		<div className="grid gap-1">
			<span className="text-xs text-muted-foreground">Message preview</span>
			<MessagePreviewBox>{text}</MessagePreviewBox>
		</div>
	)
}

// the amber "this is what gets delivered in-game" box, shared with the settings-page reason preview
export function MessagePreviewBox(props: { children: React.ReactNode }) {
	return <p className="rounded border border-amber-500/40 bg-amber-500/10 p-2 text-xs whitespace-pre-wrap">{props.children}</p>
}
