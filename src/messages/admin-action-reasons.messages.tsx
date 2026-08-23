// see settings.messages.tsx: a messages module with a react target keeps React in scope so a build using the
// classic JSX runtime can render it
import * as React from 'react'

import { def, raw, rt } from '@/models/messages.models'

// The preset reasons an admin picks from when warning, kicking or timing a player out. Each carries one text per
// action it applies to, plus the keywords that select it in chat.

export const labelColumn = def('Label')

export const textsColumn = def('Texts')

export const keywordsColumn = def('Keywords')

export const labelPlaceholder = def('Label')

// a reason is offered per action, so one with no text at all is offered nowhere
export const noActionTexts = def('Add text for at least one action, otherwise this reason can never be used.')

export const removeActionText = def('Remove {action} text (this reason will no longer be available for that action)', (action: string) => ({
	action,
}))

export const actionTextPlaceholder = def('Sent when performing {action}', (action: string) => ({ action }))

export const addActionText = def('Add action text…')

// keywords are space or comma separated, and the placeholder is two of them
export const keywordsPlaceholder = def('keywords')

// -------- the delivered-message preview --------

export const previewTitle = def('Preview the delivered in-game messages')

export const previewBlurb = def(
	'In-game text delivered for each applicable action (timeouts shown with a 2h sample duration, and as re-delivered once it has run out).',
)

// what each preview entry is labelled with. The plain actions are named by the action itself; these are the
// contexts that render one action more than one way.
export const previewWarn = def('Warn')

export const previewWarnSquad = def('Warn squad')

export const previewTimeout = def('Timeout')

export const previewTimeoutExpired = def('Timeout (expired)')

// shown only when {{squadName}} makes the squad form of an action render differently
export const previewSquadVariant = def('{action} (squad)', (action: string) => ({ action }))

// Stand-ins so the preview shows the message shape while a row is still being written. Angle brackets are the
// placeholder convention rather than prose, so they are values rather than patterns.
export const previewMissingLabel = def(() => ({ text: raw('<label>') }))

export const previewMissingActionText = def(() => ({ text: raw('<action text>') }))

// The reference is Mustache's, not Handlebars': the two share {{variable}} and {{#section}}, but Handlebars' block
// helpers are not available here. Which words are the link is part of the prose; how it looks is not, so the
// caller styles `a`.
export const templateSyntaxHint = def(rt('Supports <link>Mustache {syntax} syntax</link>.', { syntax: '{{variable}}' }))

// -------- the reason field, wherever an action or a flag asks for one --------

// Whether a reason is required is coloured differently in each case, which no single class on the container can
// express, so the caller renders the qualifier and the message positions it.
export const reasonLabel = def((qualifier: React.ReactNode) => rt('Reason {qualifier}', { qualifier }))

export const reasonRequired = def('(required)')

export const reasonOptional = def('(optional)')

export const customReason = def('Custom')

export const noReason = def('None')

export const presetReasonItem = def('Preset Reason')

export const reasonPicker = def('Reason')

export const enterReason = def('Enter a reason')

export const messagePreview = def('Message preview')

export const noReasonsConfigured = def(
	'A reason is required for {actionName}, but no reasons are configured for it (see Admin Action Reasons in settings).',
	(actionName: string) => ({ actionName }),
)

export const presetReasonPicker = def('Preset reason')

export const searchReasons = def('Search reasons...')

export const noReasonsFound = def('No reasons found.')

export const fillWithPresetReason = def('Fill the box with a preset reason')

export const fillWithPresetBroadcast = def('Fill the box with a preset broadcast')
