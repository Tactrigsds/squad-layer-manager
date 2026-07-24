import { renderTemplate } from '@/lib/templating'
import { formatHumanTime } from '@/lib/zod'
import * as ZusUtils from '@/lib/zustand'
import * as AAR from '@/models/admin-action-reasons.models'
import type * as RBAC from '@/rbac.models'
import * as SettingsClient from '@/systems/settings.client'
import React from 'react'
import ComboBox from './combo-box/combo-box'
import { PermissionDeniedTooltip } from './permission-denied-tooltip'
import type { MenuSlots } from './player-context-menu-options'
import { Input } from './ui/input'
import { Label } from './ui/label'

// the Warn menu entry: a flat item when no warn presets are configured (which leaves only the custom path),
// otherwise a sub-menu offering Custom (the warn box) or Preset Reason (the warn dialog)
export function WarnReasonsSub(props: {
	slots: MenuSlots
	denied: RBAC.PermissionDeniedResponse | null
	disabled?: boolean
	label?: string
	onCustom: () => void
	onPreset: () => void
}) {
	const { Item, Separator, Sub, SubTrigger, SubContent } = props.slots
	const hasReasons = ZusUtils.useStore(
		SettingsClient.PublicSettingsStore,
		s => !!s && AAR.reasonsForAction(s.adminActionReasons, 'warn').length > 0,
	)
	const label = props.label ?? 'Warn'
	const disabled = !!props.denied || props.disabled

	if (!hasReasons) {
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
					<Item onClick={props.onPreset}>Preset Reason</Item>
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
	// for timeouts: the currently-entered duration, so the preview can resolve {{duration}} live
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
				<ComboBox
					title="Reason"
					className="w-full"
					value={selected}
					// configured order, with Custom/None pinned first
					sort={false}
					options={[
						{ value: CUSTOM, label: allowCustom ? 'Custom' : 'None' },
						...reasons.map(reason => ({
							value: reason.label,
							keywords: reason.aliases,
							description: AAR.reasonText(props.action, reason),
						})),
					]}
					onSelect={value => {
						const next = value ?? CUSTOM
						setSelected(next)
						props.presetRef.current = next === CUSTOM ? '' : next
					}}
				/>
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
// reason preview. reason (a selected preset) takes precedence over customText (free-text). For timeouts {{duration}}
// resolves to the entered duration (empty while it's unparseable, so {{#duration}} sections drop out); other
// {{variables}} come from the configured Message Variables. Renders nothing until there's some text to show.
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
	if (props.action === 'timeout') vars.duration = props.durationMs && props.durationMs > 0 ? formatHumanTime(props.durationMs) : ''
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
