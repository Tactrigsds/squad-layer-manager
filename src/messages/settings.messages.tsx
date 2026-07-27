// Only the client renders these today, but a messages module is one import away from a build that transpiles JSX
// with the classic runtime, where a missing React is a runtime error rather than a type error (see
// teamswaps.messages.tsx).
import * as React from 'react'

import * as Msgs from '@/messages/shared'
import type * as SETTINGS from '@/models/settings.models'

// -------- section names --------
// A settings section is named in the table of contents, in its own card header and in the save panel's change
// list, so each name is one message rather than three literals that drift.

export const managedServers = Msgs.def(() => ({ text: () => 'Managed Servers' }))

export const globalSettings = Msgs.def(() => ({ text: () => 'Global Settings' }))

export const newManagedServer = Msgs.def(() => ({ text: () => 'New Managed Server' }))

export const serverSettings = Msgs.def(() => ({ text: () => 'Server Settings' }))

// -------- the settings page --------

export const pageTitle = Msgs.def(() => ({ text: () => 'SLM - Settings' }))

export const noAccess = Msgs.def(() => ({ text: () => `You don't have permission to access settings.` }))

export const noGlobalAccess = Msgs.def(() => ({ text: () => `You don't have permission to view global settings.` }))

export const globalSettingsBlurb = Msgs.def(() => ({ text: () => 'Edit the global settings for this SLM instance.' }))

export const readOnly = Msgs.def(() => ({ text: () => 'Read-only' }))

// the grantable paths follow, rendered as code by the caller
export const onlyModifiable = Msgs.def(() => ({ text: () => 'You can only modify:' }))

export const loading = Msgs.def(() => ({ text: () => 'Loading…' }))

export const loadingEditor = Msgs.def(() => ({ text: () => 'Loading editor…' }))

export const loadFailed = Msgs.def((reason: string) => ({ text: () => `Failed to load settings: ${reason}` }))

// the GUI/JSON switch, one per section, each named so a screen reader (or a test) can tell them apart
export const serverEditorModeLabel = Msgs.def(() => ({ text: () => 'Server settings editor mode' }))

export const newServerEditorModeLabel = Msgs.def(() => ({ text: () => 'New server editor mode' }))

export const globalEditorModeLabel = Msgs.def(() => ({ text: () => 'Global settings editor mode' }))

// -------- the table of contents --------

export const searchSettings = Msgs.def(() => ({ text: () => 'Search settings…' }))

export const noMatches = Msgs.def(() => ({ text: () => 'No matches.' }))

// on the pencil marker beside a section the user may write to; shown only when something on the page is not
export const writableMarker = Msgs.def(() => ({ text: () => 'Contains settings you can modify' }))

// -------- the server registry --------

export const noServersConfigured = Msgs.def(() => ({ text: () => 'No servers configured.' }))

export const selectServer = Msgs.def(() => ({ text: () => 'Select a server to configure it.' }))

export const addManagedServer = Msgs.def(() => ({ text: () => 'Add Managed Server' }))

export const deleteManagedServer = Msgs.def(() => ({ text: () => 'Delete managed server' }))

export const defaultServer = Msgs.def(() => ({ text: () => 'Default' }))

export const serverBroken = Msgs.def(() => ({ text: () => 'Settings failed validation and need repair' }))

// what a row's status dot says. `starting`/`stopping` are the windows the enable/disable RPCs are in flight for,
// which is exactly how long the transition takes.
export type ServerLifecycleState = 'running' | 'stopped' | 'starting' | 'stopping' | 'broken'

export const serverLifecycleLabels: Record<ServerLifecycleState, string> = {
	running: 'Connected',
	stopped: 'Disconnected',
	starting: 'Connecting…',
	stopping: 'Disconnecting…',
	broken: 'Broken',
}

// the row's connect/disconnect button; the hints are its tooltip, which is where the choice outliving a restart
// is spelled out
export const connectServer = Msgs.def(() => ({ text: () => 'Connect' }))

export const connectServerHint = Msgs.def(() => ({ text: () => 'Connect to the server. It will also connect automatically with SLM.' }))

export const disconnectServer = Msgs.def(() => ({ text: () => 'Disconnect' }))

export const disconnectServerHint = Msgs.def(() => ({
	text: () => 'Disconnect from the server. It stays disconnected across SLM restarts.',
}))

// -------- the new-server form --------

export const newServerBlurb = Msgs.def(() => ({ text: () => 'Configure a new server. Save from the panel below, or cancel.' }))

export const cancel = Msgs.def(() => ({ text: () => 'Cancel' }))

export const serverIdLabel = Msgs.def(() => ({ text: () => 'Server ID' }))

export const serverIdPlaceholder = Msgs.def(() => ({ text: () => 'my-server-1' }))

export const invalidServerId = Msgs.def(() => ({ text: () => 'Invalid server id' }))

export const displayNameLabel = Msgs.def(() => ({ text: () => 'Display Name' }))

export const displayNamePlaceholder = Msgs.def(() => ({ text: () => 'My Squad Server' }))

// -------- the save panel and the json toolbar --------

export const save = Msgs.def(() => ({ text: () => 'Save' }))

export const saving = Msgs.def(() => ({ text: () => 'Saving…' }))

export const reset = Msgs.def(() => ({ text: () => 'Reset' }))

export const format = Msgs.def(() => ({ text: () => 'Format' }))

// the out-of-grant paths follow, rendered as code by the caller
export const notPermittedToModify = Msgs.def(() => ({ text: () => 'Not permitted to modify:' }))

export const previousError = Msgs.def(() => ({ text: () => 'Previous error' }))

export const nextError = Msgs.def(() => ({ text: () => 'Next error' }))

export const previousDeniedChange = Msgs.def(() => ({ text: () => 'Previous denied change' }))

export const nextDeniedChange = Msgs.def(() => ({ text: () => 'Next denied change' }))

export const deniedChangesHint = Msgs.def(() => ({ text: () => `These changes are outside the settings you're allowed to modify` }))

export const errorCount = Msgs.def((count: number) => ({ text: () => `${count} ${count === 1 ? 'error' : 'errors'}` }))

export const deniedCount = Msgs.def((count: number) => ({ text: () => `${count} not permitted` }))

// the count is emphasised, which is part of the sentence; the panel styles `strong` itself
export const changedCount = Msgs.def((count: number) => ({
	react: () => (
		<>
			<strong>{count}</strong> {count === 1 ? 'setting' : 'settings'} changed
		</>
	),
}))

// -------- the pool filter --------

export const poolFilter = Msgs.def(() => ({ text: () => 'Pool Filter' }))

export const poolFilterBlurb = Msgs.def(() => ({ text: () => `The single filter deciding which layers are in the server's layer pool` }))

export const noPoolFilter = Msgs.def(() => ({ text: () => 'No pool filter configured: every layer is in the pool.' }))

export const aboutPoolFilter = Msgs.def(() => ({ text: () => 'About the pool filter' }))

export const poolFilterHelpMembership = Msgs.def(() => ({
	text: () =>
		'Out-of-pool layers are hidden behind the pool toggle during layer selection, and only users with the queue:force-write ' +
		'permission can queue them. Saving one warns the editor, and in-game admins are warned when one is about to be played. ' +
		'Autogenerated layers always come from the pool.',
}))

export const poolFilterHelpToggle = Msgs.def(() => ({
	text: () => 'The toggle in front of the filter flips it between including its matching layers in the pool and excluding them from it.',
}))

export const poolFilterHelpIndicators = Msgs.def(() => ({
	text: () =>
		`The filter's match indicators (emoji and alert message, plus the inverted pair for misses) are what mark a layer as in or ` +
		'out of the pool across the app, so the pool filter needs all of them configured.',
}))

// what the pool filter's invert toggle means in each position
export const poolFilterInvertLabels = { regular: 'Matching layers are in the pool', inverted: 'Matching layers are excluded from the pool' }

// the four filter-entity fields an indicator renders from. Declared here because their wording is the only thing
// keyed by them: the panel reports which are unset, and this module is what turns that into a sentence.
export type IndicatorField = 'match-emoji' | 'match-alert' | 'miss-emoji' | 'miss-alert'

const indicatorFieldNames: Record<IndicatorField, string> = {
	'match-emoji': 'match emoji',
	'match-alert': 'match alert message',
	'miss-emoji': 'miss emoji',
	'miss-alert': 'miss alert message',
}

const indicatorKindNames = { match: 'match', miss: 'miss' }

export const missingIndicator = Msgs.def((kind: 'match' | 'miss', missing: readonly IndicatorField[]) => ({
	text: () =>
		`This filter's ${indicatorKindNames[kind]} indicator won't display: it has no ` +
		`${missing.map((f) => indicatorFieldNames[f]).join(' or ')} configured. Click to edit the filter.`,
}))

export const poolFilterMissingIndicators = Msgs.def((missing: readonly IndicatorField[]) => ({
	text: () =>
		`The pool filter must have match and miss indicators configured. Missing: ${missing.map((f) => indicatorFieldNames[f]).join(', ')}.`,
}))

// -------- the secondary filter lists --------

export const secondaryFilters = Msgs.def(() => ({ text: () => 'Secondary Filters' }))

export const aboutSecondaryFilters = Msgs.def(() => ({ text: () => 'About secondary filters' }))

export const secondaryFiltersHelpBehavior = Msgs.def(() => ({
	text: () =>
		'Secondary filters never decide what is in the pool; they add behavior on top of it: displaying match or miss indicators ' +
		'on layers, being offered during layer selection, warning when a matching layer is queued or about to be played, and ' +
		'further constraining autogeneration.',
}))

export const secondaryFiltersHelpReuse = Msgs.def(() => ({ text: () => 'A filter can appear in several of these lists at once.' }))

export const secondaryListTitles: Record<SETTINGS.SecondaryListKey, string> = {
	indicateMatches: 'Indicate matches for',
	indicateMisses: 'Indicate misses for',
	defaultSelectable: 'Default selectable filters',
	warnFor: 'Warn for',
	constrainGeneration: 'Constrain generated pool for',
}

export const secondaryListBlurbs: Record<SETTINGS.SecondaryListKey, string> = {
	indicateMatches: `Layers matching these filters display the filter's match emoji`,
	indicateMisses: `Layers NOT matching these filters display the filter's miss emoji`,
	defaultSelectable: 'Offered during layer selection; the checkbox is the state they start in',
	warnFor: 'Warn when a layer in the configured state is queued or about to be played',
	constrainGeneration: 'Autogenerated layers are constrained by these filters, on top of the pool filter',
}

// only the lists whose entries carry a regular/inverted choice have an invert toggle to label
export const secondaryListInvertLabels: Partial<Record<SETTINGS.SecondaryListKey, { regular: string; inverted: string }>> = {
	warnFor: { regular: 'Warn on match', inverted: 'Warn on miss' },
	constrainGeneration: { regular: 'Must match', inverted: 'Must not match' },
}

export const noFilters = Msgs.def(() => ({ text: () => 'No filters' }))

// Tooltips on the tri-state checkbox for a default-selectable filter, which is offered during layer selection in
// whichever state it names.
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

// -------- skip warnings for tags --------

export const skipWarningsFor = Msgs.def(() => ({ text: () => 'Skip warnings for' }))

export const aboutSkipWarnings = Msgs.def(() => ({ text: () => 'About skipping warnings' }))

export const skipWarningsHelpSilenced = Msgs.def(() => ({
	text: () =>
		'A queue item carrying any of these tags raises no warnings: none in the save dialog, and none in the admin reminder sent ' +
		'before it is played.',
}))

export const skipWarningsHelpStillApplies = Msgs.def(() => ({
	text: () => 'Out-of-pool layers still need the force-write permission to save, and indicators still display as usual.',
}))

// -------- the next-layer panel --------

export const nextLayer = Msgs.def(() => ({ text: () => 'Next Layer' }))

// Descriptions for these come from the schema, so only the labels live here.
export const nextLayerLabels: Record<SETTINGS.NextLayerSettingKey, string> = {
	overrideAdminSetNextLayer: 'Override the next layer when it is set outside SLM',
	warnOnNextLayerChange: 'Warn admins when the next layer changes',
}

// -------- repeat rules --------

export const repeatRules = Msgs.def(() => ({ text: () => 'Repeat Rules' }))

export const addRepeatRule = Msgs.def(() => ({ text: () => 'Add Repeat Rule' }))

export const repeatRuleLabel = Msgs.def(() => ({ text: () => 'Label' }))

export const repeatRuleField = Msgs.def(() => ({ text: () => 'Field' }))

export const repeatRuleWithin = Msgs.def(() => ({ text: () => 'Within' }))

export const repeatRuleTargetValues = Msgs.def(() => ({ text: () => 'Target Values' }))

// the two pickers in a rule row, named for what they pick rather than for the column they sit under
export const repeatRuleFieldPicker = Msgs.def(() => ({ text: () => 'Rule' }))

export const repeatRuleTargetPicker = Msgs.def(() => ({ text: () => 'Target' }))

export const repeatRuleWarn = Msgs.def(() => ({ text: () => 'Warn' }))

export const repeatRuleWarnTitle = Msgs.def(() => ({ text: () => 'Warn when a layer violating this rule is queued or about to be played' }))

export const aboutRepeatRuleWarn = Msgs.def(() => ({ text: () => 'About repeat rule warnings' }))

export const repeatRuleWarnHelp = Msgs.def(() => ({
	text: () => 'Warn the editor before saving a layer that violates this rule, and in-game admins when one is about to be played',
}))

export const repeatRuleAutogen = Msgs.def(() => ({ text: () => 'Autogen' }))

export const repeatRuleAutogenTitle = Msgs.def(() => ({ text: () => 'Apply this rule when autogenerating layers' }))

export const aboutRepeatRuleAutogen = Msgs.def(() => ({ text: () => 'About repeat rules during autogeneration' }))

export const repeatRuleAutogenHelp = Msgs.def(() => ({ text: () => 'Also apply this rule when autogenerating layers' }))

// -------- saving --------

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

// -------- the form shell --------

export const notPermittedToModifySetting = Msgs.def(() => ({ text: () => 'You are not permitted to modify this setting' }))

export const linkToSetting = Msgs.def(() => ({ text: () => 'Link to this setting' }))

export const advanced = Msgs.def(() => ({ text: () => 'Advanced' }))

// a longer explanation folded behind a `?`, so compact editors can drop their inline descriptions
export const help = Msgs.def(() => ({ text: () => 'Help' }))

// only the first few validation errors on a field are listed; the rest are counted
export const moreIssues = Msgs.def((count: number) => ({ text: () => `+${count} more` }))

// -------- the generic leaf controls --------

export const addItem = Msgs.def(() => ({ text: () => 'Add' }))

export const emptyList = Msgs.def(() => ({ text: () => 'Empty.' }))

export const noEntries = Msgs.def(() => ({ text: () => 'No entries.' }))

export const addEntry = Msgs.def(() => ({ text: () => 'Add…' }))

export const newEntryKey = Msgs.def(() => ({ text: () => 'new key' }))

// the checkbox that puts a nullable field back to null
export const unsetField = Msgs.def(() => ({ text: () => 'unset' }))

export const enumValuePicker = Msgs.def(() => ({ text: () => 'Value' }))

// a duration field with no schema default of its own still wants a format hint
export const durationExample = Msgs.def(() => ({ text: () => 'e.g. 30m' }))

// -------- per-field reset --------

export const defaultHint = Msgs.def((value: string) => ({ text: () => `default: ${value}` }))

export const resetToSaved = Msgs.def(() => ({ text: () => 'Reset to saved value' }))

export const alreadySaved = Msgs.def(() => ({ text: () => 'Already matches the saved value' }))

export const resetToDefault = Msgs.def((value: string) => ({ text: () => `Reset to default (${value})` }))

export const alreadyDefault = Msgs.def(() => ({ text: () => 'Already matches the default' }))

// how a schema default is spelled in the hint and the reset tooltip, for the values that have no useful literal form
export const defaultValueWords = { unset: 'unset', on: 'on', off: 'off', empty: '(empty)' }

// -------- the server agent token --------

export const passwordPlaceholder = Msgs.def(() => ({ text: () => 'Password' }))

export const serverAgentTokenPlaceholder = Msgs.def(() => ({ text: () => 'Server agent token' }))

export const showToken = Msgs.def(() => ({ text: () => 'Show token' }))

export const hideToken = Msgs.def(() => ({ text: () => 'Hide token' }))

export const copyToken = Msgs.def(() => ({ text: () => 'Copy token' }))

export const generateToken = Msgs.def(() => ({ text: () => 'Generate' }))

export const serverAgentTokenBlurb = Msgs.def(() => ({
	text: () => 'The server agent authenticates with this token, so treat it like a password.',
}))

export const serverAgentSetupGuide = Msgs.def(() => ({ text: () => 'Server agent setup guide' }))
