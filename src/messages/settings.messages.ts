import * as Msgs from '@/messages/shared'
import type * as SETTINGS from '@/models/settings.models'

// The pool-config panels. Tooltips on the tri-state checkbox for a default-selectable filter, which is offered
// during layer selection in whichever state it names.
export const selectableStateTitles: Record<SETTINGS.SelectableFilterApplyAs, string> = {
	disabled: 'Offered but not applied by default (Ctrl+Click to invert)',
	regular: 'Applied by default (Ctrl+Click to invert)',
	inverted: 'Applied inverted by default',
}

// Tooltip on the applied-filters panel's pool checkbox, which is the same tri-state read against the live query
// rather than against the saved config.
export const poolStateTitles: Record<SETTINGS.SelectableFilterApplyAs, string> = {
	regular: 'Only pool layers are shown (Ctrl+Click to show only layers outside the pool)',
	inverted: 'Only layers outside the pool are shown; they cannot be selected without the queue:force-write permission',
	disabled: 'The pool does not constrain the query: all layers are shown (Ctrl+Click to invert)',
}

// Descriptions for these come from the schema, so only the labels live here.
export const nextLayerLabels: Record<SETTINGS.NextLayerSettingKey, string> = {
	overrideAdminSetNextLayer: 'Override the next layer when it is set outside SLM',
	warnOnNextLayerChange: 'Warn admins when the next layer changes',
}

export const saved = Msgs.def(() => ({ toast: () => ['Settings saved'] }))

export const serverSettingsSaved = Msgs.def(() => ({ toast: () => ['Server settings saved'] }))

export const serverCreated = Msgs.def(() => ({ toast: () => ['Server created'] }))

// reason is the server's own account of which field failed
export const invalid = Msgs.def((reason: string) => ({
	toast: () => ['Invalid settings', { description: reason }],
}))

export const serverNotFound = Msgs.def(() => ({ toast: () => ['Server not found'] }))

export const serverIdTaken = Msgs.def(() => ({ toast: () => ['A server with that ID already exists'] }))

// the save panel saves every dirty section at once, so it names none of them in the title; the change list
// below it is what says which sections are involved
export const confirmSaveAll = Msgs.def(() => ({
	confirm: () => ({ title: 'Save settings?', confirmLabel: 'Save' }),
}))

// displayName is absent for the global settings, which belong to no server
export const confirmSave = Msgs.def((displayName?: string) => ({
	confirm: () => ({
		title: displayName === undefined ? 'Save global settings?' : `Save ${displayName} settings?`,
		confirmLabel: 'Save',
	}),
}))

export const confirmDeleteServer = Msgs.def((displayName: string, serverId: string) => ({
	confirm: () => ({
		title: 'Delete Managed Server',
		description: `Delete managed server "${displayName}" (${serverId})? This cannot be undone.`,
		confirmLabel: 'Delete',
	}),
}))

// the browser's own confirm(), which takes a bare string
export const unsavedChanges = Msgs.def(() => ({
	text: () => 'You have unsaved settings changes. Are you sure you want to leave?',
}))
