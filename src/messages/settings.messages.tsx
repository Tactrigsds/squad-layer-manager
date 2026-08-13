// Only the client renders these today, but a messages module is one import away from a build that transpiles JSX
// with the classic runtime, where a missing React is a runtime error rather than a type error (see
// teamswaps.messages.tsx).
import * as React from 'react'

import { def, join, raw, rt, t, type TString } from '@/models/messages.models'
import type * as SETTINGS from '@/models/settings.models'

// -------- section names --------
// A settings section is named in the table of contents, in its own card header and in the save panel's change
// list, so each name is one message rather than three literals that drift.

export const managedServers = def('Managed Servers')

export const globalSettings = def('Global Settings')

export const newManagedServer = def('New Managed Server')

export const serverSettings = def('Server Settings')

// -------- the settings page --------

export const pageTitle = def('SLM - Settings')

export const noAccess = def("You don't have permission to access settings.")

export const noGlobalAccess = def("You don't have permission to view global settings.")

export const globalSettingsBlurb = def('Edit the global settings for this SLM instance.')

export const readOnly = def('Read-only')

// the grantable paths follow, rendered as code by the caller
export const onlyModifiable = def('You can only modify:')

export const loading = def('Loading…')

export const loadingEditor = def('Loading editor…')

export const loadFailed = def('Failed to load settings: {reason}', (reason: string) => ({ reason }))

// the GUI/YAML switch, one per section, each named so a screen reader (or a test) can tell them apart
export const serverEditorModeLabel = def('Server settings editor mode')

export const newServerEditorModeLabel = def('New server editor mode')

export const globalEditorModeLabel = def('Global settings editor mode')

// -------- the table of contents --------

export const searchSettings = def('Search settings…')

export const noMatches = def('No matches.')

// on the pencil marker beside a section the user may write to; shown only when something on the page is not
export const writableMarker = def('Contains settings you can modify')

// -------- the server registry --------

export const noServersConfigured = def('No servers configured.')

export const selectServer = def('Select a server to configure it.')

export const addManagedServer = def('Add Managed Server')

export const deleteManagedServer = def('Delete managed server')

export const defaultServer = def('Default')

export const serverBroken = def('Settings failed validation and need repair')

// what a row's status dot says. `starting`/`stopping` are the windows the enable/disable RPCs are in flight for,
// which is exactly how long the transition takes.
export type ServerLifecycleState = 'running' | 'stopped' | 'starting' | 'stopping' | 'broken'

export const serverLifecycleLabels: Record<ServerLifecycleState, TString> = {
	running: t('Connected'),
	stopped: t('Disconnected'),
	starting: t('Connecting…'),
	stopping: t('Disconnecting…'),
	broken: t('Broken'),
}

// the row's connect/disconnect button; the hints are its tooltip, which is where the choice outliving a restart
// is spelled out
export const connectServer = def('Connect')

export const connectServerHint = def('Connect to the server. It will also connect automatically with SLM.')

export const disconnectServer = def('Disconnect')

export const disconnectServerHint = def('Disconnect from the server. It stays disconnected across SLM restarts.')

// -------- the new-server form --------

export const newServerBlurb = def('Configure a new server. Save from the panel below, or cancel.')

export const cancel = def('Cancel')

export const serverIdLabel = def('Server ID')

export const serverIdPlaceholder = def('my-server-1')

export const invalidServerId = def('Invalid server id')

export const displayNameLabel = def('Display Name')

export const displayNamePlaceholder = def('My Squad Server')

// -------- the save panel and the yaml toolbar --------

export const save = def('Save')

export const saving = def('Saving…')

export const reset = def('Reset')

export const format = def('Format')

// the out-of-grant paths follow, rendered as code by the caller
export const notPermittedToModify = def('Not permitted to modify:')

export const previousError = def('Previous error')

export const nextError = def('Next error')

export const previousDeniedChange = def('Previous denied change')

export const nextDeniedChange = def('Next denied change')

export const deniedChangesHint = def("These changes are outside the settings you're allowed to modify")

export const errorCount = def('{count, plural, one {# error} other {# errors}}', (count: number) => ({ count }))

export const deniedCount = def('{count} not permitted', (count: number) => ({ count }))

// the count is emphasised, which is part of the sentence; the panel styles `strong` itself
export const changedCount = def((count: number) => ({
	richText: rt('<strong>{count}</strong> {count, plural, one {setting} other {settings}} changed', { count }),
}))

// -------- the pool filter --------

export const poolFilter = def('Pool Filter')

export const poolFilterBlurb = def("The single filter deciding which layers are in the server's layer pool")

export const noPoolFilter = def('No pool filter configured: every layer is in the pool.')

export const aboutPoolFilter = def('About the pool filter')

export const poolFilterHelpMembership = def(
	'Out-of-pool layers are hidden behind the pool toggle during layer selection, and only users with the queue:force-write permission can queue them. Saving one warns the editor, and in-game admins are warned when one is about to be played. Autogenerated layers always come from the pool.',
)

export const poolFilterHelpToggle = def(
	'The toggle in front of the filter flips it between including its matching layers in the pool and excluding them from it.',
)

export const poolFilterHelpIndicators = def(
	"The filter's match indicators (emoji and alert message, plus the inverted pair for misses) are what mark a layer as in or out of the pool across the app, so the pool filter needs all of them configured.",
)

// what the pool filter's invert toggle means in each position
export const poolFilterInvertLabels = { regular: 'Matching layers are in the pool', inverted: 'Matching layers are excluded from the pool' }

// the four filter-entity fields an indicator renders from. Declared here because their wording is the only thing
// keyed by them: the panel reports which are unset, and this module is what turns that into a sentence.
export type IndicatorField = 'match-emoji' | 'match-alert' | 'miss-emoji' | 'miss-alert'

const indicatorFieldNames: Record<IndicatorField, TString> = {
	'match-emoji': t('match emoji'),
	'match-alert': t('match alert message'),
	'miss-emoji': t('miss emoji'),
	'miss-alert': t('miss alert message'),
}

const indicatorKindNames = { match: 'match', miss: 'miss' }

export const missingIndicator = def(
	"This filter's {kind} indicator won't display: it has no {missing} configured. Click to edit the filter.",
	(kind: 'match' | 'miss', missing: readonly IndicatorField[]) => ({
		kind: indicatorKindNames[kind],
		missing: join(
			missing.map((field) => indicatorFieldNames[field]),
			' or ',
		),
	}),
)

export const poolFilterMissingIndicators = def(
	'The pool filter must have match and miss indicators configured. Missing: {missing}.',
	(missing: readonly IndicatorField[]) => ({
		missing: join(
			missing.map((field) => indicatorFieldNames[field]),
			', ',
		),
	}),
)

// -------- the secondary filter lists --------

// names the language picker on a server's settings, whose options are the languages themselves
export const localePicker = def('Language')

export const secondaryFilters = def('Secondary Filters')

export const aboutSecondaryFilters = def('About secondary filters')

export const secondaryFiltersHelpBehavior = def(
	'Secondary filters never decide what is in the pool; they add behavior on top of it: displaying match or miss indicators on layers, being offered during layer selection, warning when a matching layer is queued or about to be played, and further constraining autogeneration.',
)

export const secondaryFiltersHelpReuse = def('A filter can appear in several of these lists at once.')

export const secondaryListTitles: Record<SETTINGS.SecondaryListKey, TString> = {
	indicateMatches: t('Indicate matches for'),
	indicateMisses: t('Indicate misses for'),
	defaultSelectable: t('Default selectable filters'),
	warnFor: t('Warn for'),
	constrainGeneration: t('Constrain generated pool for'),
}

export const secondaryListBlurbs: Record<SETTINGS.SecondaryListKey, TString> = {
	indicateMatches: t("Layers matching these filters display the filter's match emoji"),
	indicateMisses: t("Layers NOT matching these filters display the filter's miss emoji"),
	defaultSelectable: t('Offered during layer selection; the checkbox is the state they start in'),
	warnFor: t('Warn when a layer in the configured state is queued or about to be played'),
	constrainGeneration: t('Autogenerated layers are constrained by these filters, on top of the pool filter'),
}

// only the lists whose entries carry a regular/inverted choice have an invert toggle to label
export const secondaryListInvertLabels: Partial<Record<SETTINGS.SecondaryListKey, { regular: string; inverted: string }>> = {
	warnFor: { regular: 'Warn on match', inverted: 'Warn on miss' },
	constrainGeneration: { regular: 'Must match', inverted: 'Must not match' },
}

export const noFilters = def('No filters')

// Tooltips on the tri-state checkbox for a default-selectable filter, which is offered during layer selection in
// whichever state it names.
export const selectableStateTitles: Record<SETTINGS.SelectableFilterApplyAs, TString> = {
	disabled: t('Offered but not applied by default (Ctrl+Click to invert)'),
	regular: t('Applied by default (Ctrl+Click to invert)'),
	inverted: t('Applied inverted by default'),
}

// Tooltip on the applied-filters panel's pool checkbox, which is the same tri-state read against the live query
// rather than against the saved config.
export const poolStateTitles: Record<SETTINGS.SelectableFilterApplyAs, TString> = {
	regular: t('Only pool layers are shown (Ctrl+Click to show only layers outside the pool)'),
	inverted: t('Only layers outside the pool are shown; they cannot be selected without the queue:force-write permission'),
	disabled: t('The pool does not constrain the query: all layers are shown (Ctrl+Click to invert)'),
}

// -------- skip warnings for tags --------

export const skipWarningsFor = def('Skip warnings for')

export const aboutSkipWarnings = def('About skipping warnings')

export const skipWarningsHelpSilenced = def(
	'A queue item carrying any of these tags raises no warnings: none in the save dialog, and none in the admin reminder sent before it is played.',
)

export const skipWarningsHelpStillApplies = def(
	'Out-of-pool layers still need the force-write permission to save, and indicators still display as usual.',
)

// -------- the next-layer panel --------

export const nextLayer = def('Next Layer')

// Descriptions for these come from the schema, so only the labels live here.
export const nextLayerLabels: Record<SETTINGS.NextLayerSettingKey, TString> = {
	overrideAdminSetNextLayer: t('Override the next layer when it is set outside SLM'),
	warnOnNextLayerChange: t('Warn admins when the next layer changes'),
}

// -------- repeat rules --------

export const repeatRules = def('Repeat Rules')

export const addRepeatRule = def('Add Repeat Rule')

export const repeatRuleLabel = def('Label')

export const repeatRuleField = def('Field')

export const repeatRuleWithin = def('Within')

export const repeatRuleTargetValues = def('Target Values')

// the two pickers in a rule row, named for what they pick rather than for the column they sit under
export const repeatRuleFieldPicker = def('Rule')

export const repeatRuleTargetPicker = def('Target')

export const repeatRuleWarn = def('Warn')

export const repeatRuleWarnTitle = def('Warn when a layer violating this rule is queued or about to be played')

export const aboutRepeatRuleWarn = def('About repeat rule warnings')

export const repeatRuleWarnHelp = def(
	'Warn the editor before saving a layer that violates this rule, and in-game admins when one is about to be played',
)

export const repeatRuleAutogen = def('Autogen')

export const repeatRuleAutogenTitle = def('Apply this rule when autogenerating layers')

export const aboutRepeatRuleAutogen = def('About repeat rules during autogeneration')

export const repeatRuleAutogenHelp = def('Also apply this rule when autogenerating layers')

export const repeatRuleCrossTeam = def('Cross-team')

export const repeatRuleCrossTeamTitle = def('Count a value either team played as a repeat for both teams')

export const repeatRuleCrossTeamHelpTitle = def('About cross-team repeat rules')

export const repeatRuleCrossTeamHelp = def(
	'By default a Faction or Alliance rule compares each team against the same team in earlier matches. Cross-team pools both teams together, so a faction one team played counts as a repeat when the other team plays it. Only applies to Faction and Alliance rules.',
)

// -------- saving --------

export const saved = def(() => ({ toast: [t('Settings saved')] }))

export const serverSettingsSaved = def(() => ({ toast: [t('Server settings saved')] }))

export const serverCreated = def(() => ({ toast: [t('Server created')] }))

// reason is the server's own account of which field failed
export const invalid = def((reason: string) => ({
	toast: [t('Invalid settings'), { description: raw(reason) }],
}))

export const serverNotFound = def(() => ({ toast: [t('Server not found')] }))

export const serverIdTaken = def(() => ({ toast: [t('A server with that ID already exists')] }))

// the save panel saves every dirty section at once, so it names none of them in the title; the change list
// below it is what says which sections are involved
export const confirmSaveAll = def(() => ({
	confirm: { title: t('Save settings?'), confirmLabel: t('Save') },
}))

// displayName is absent for the global settings, which belong to no server
export const confirmSave = def((displayName?: string) => ({
	confirm: {
		title: displayName === undefined ? t('Save global settings?') : t('Save {displayName} settings?', { displayName }),
		confirmLabel: t('Save'),
	},
}))

export const confirmDeleteServer = def((displayName: string, serverId: string) => ({
	confirm: {
		title: t('Delete Managed Server'),
		description: t('Delete managed server "{displayName}" ({serverId})? This cannot be undone.', { displayName, serverId }),
		confirmLabel: t('Delete'),
	},
}))

// the browser's own confirm(), which takes a bare string
export const unsavedChanges = def('You have unsaved settings changes. Are you sure you want to leave?')

// -------- the form shell --------

export const notPermittedToModifySetting = def('You are not permitted to modify this setting')

export const linkToSetting = def('Link to this setting')

export const advanced = def('Advanced')

// a longer explanation folded behind a `?`, so compact editors can drop their inline descriptions
export const help = def('Help')

// only the first few validation errors on a field are listed; the rest are counted
export const moreIssues = def('+{count} more', (count: number) => ({ count }))

// -------- the generic leaf controls --------

export const addItem = def('Add')

export const emptyList = def('Empty.')

export const noEntries = def('No entries.')

export const addEntry = def('Add…')

export const newEntryKey = def('new key')

// the checkbox that puts a nullable field back to null
export const unsetField = def('unset')

export const enumValuePicker = def('Value')

// a duration field with no schema default of its own still wants a format hint
export const durationExample = def('e.g. 30m')

// -------- per-field reset --------

export const defaultHint = def('default: {value}', (value: string) => ({ value }))

export const resetToSaved = def('Reset to saved value')

export const alreadySaved = def('Already matches the saved value')

export const resetToDefault = def('Reset to default ({value})', (value: string) => ({ value }))

export const alreadyDefault = def('Already matches the default')

// how a schema default is spelled in the hint and the reset tooltip, for the values that have no useful literal form
export const defaultValueWords = { unset: 'unset', on: 'on', off: 'off', empty: '(empty)' }

// -------- the server agent token --------

export const passwordPlaceholder = def('Password')

export const serverAgentTokenPlaceholder = def('Server agent token')

export const showToken = def('Show token')

export const hideToken = def('Hide token')

export const copyToken = def('Copy token')

export const generateToken = def('Generate')

export const serverAgentTokenBlurb = def('The server agent authenticates with this token, so treat it like a password.')

export const serverAgentSetupGuide = def('Server agent setup guide')

export const loadingEmojis = def('Loading emojis...')

export const fullscreen = def('Fullscreen')

export const exitFullscreen = def('Exit fullscreen (Esc)')

export const yamlErrors = def('Errors')

// -------- the pool config window --------

export const poolConfigTitle = def('Pool Configuration')

export const readOnlyBadge = def('Read-only')

export const poolFiltersTab = def('Filters')

export const resetChanges = def('Reset changes')

export const saveChanges = def('Save Changes')
