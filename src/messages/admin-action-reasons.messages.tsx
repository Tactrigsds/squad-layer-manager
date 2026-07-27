// see settings.messages.tsx: a messages module with a react target keeps React in scope so a build using the
// classic JSX runtime can render it
import * as React from 'react'

import * as Msgs from '@/messages/shared'

// The preset reasons an admin picks from when warning, kicking or timing a player out. Each carries one text per
// action it applies to, plus the keywords that select it in chat.

export const labelColumn = Msgs.def('Label')

export const textsColumn = Msgs.def('Texts')

export const keywordsColumn = Msgs.def('Keywords')

export const labelPlaceholder = Msgs.def('Label')

// a reason is offered per action, so one with no text at all is offered nowhere
export const noActionTexts = Msgs.def('Add text for at least one action, otherwise this reason can never be used.')

export const removeActionText = Msgs.def(
	(action: string) => `Remove ${action} text (this reason will no longer be available for that action)`,
)

export const actionTextPlaceholder = Msgs.def((action: string) => `Sent when performing ${action}`)

export const addActionText = Msgs.def('Add action text…')

// keywords are space or comma separated, and the placeholder is two of them
export const keywordsPlaceholder = Msgs.def('tk afk')

// -------- the delivered-message preview --------

export const previewTitle = Msgs.def('Preview the delivered in-game messages')

export const previewBlurb = Msgs.def(
	() =>
		'In-game text delivered for each applicable action (timeouts shown with a 2h sample duration, and as re-delivered once it has ' +
		'run out).',
)

// what each preview entry is labelled with. The plain actions are named by the action itself; these are the
// contexts that render one action more than one way.
export const previewWarn = Msgs.def('Warn')

export const previewWarnSquad = Msgs.def('Warn squad')

export const previewTimeout = Msgs.def('Timeout')

export const previewTimeoutExpired = Msgs.def('Timeout (expired)')

// stand-ins so the preview shows the message shape while a row is still being written
export const previewMissingLabel = Msgs.def('<label>')

export const previewMissingActionText = Msgs.def('<action text>')

// The reference is Mustache's, not Handlebars': the two share {{variable}} and {{#section}}, but Handlebars' block
// helpers are not available here. Which words are the link is part of the prose; how it looks is not, so the
// caller styles `a`.
export const templateSyntaxHint = Msgs.def((docUrl: string) => ({
	react: () => (
		<>
			Supports{' '}
			<a href={docUrl} target="_blank" rel="noopener noreferrer">
				Mustache {'{{variable}}'} syntax
			</a>
			.
		</>
	),
}))

// -------- the reason field, wherever an action or a flag asks for one --------

// Whether a reason is required is coloured differently in each case, which no single class on the container can
// express, so the caller renders the qualifier and the message positions it.
export const reasonLabel = Msgs.def((qualifier: React.ReactNode) => ({
	react: () => <>Reason {qualifier}</>,
}))

export const reasonRequired = Msgs.def('(required)')

export const reasonOptional = Msgs.def('(optional)')

export const customReason = Msgs.def('Custom')

export const noReason = Msgs.def('None')

export const presetReasonItem = Msgs.def('Preset Reason')

export const reasonPicker = Msgs.def('Reason')

export const enterReason = Msgs.def('Enter a reason')

export const messagePreview = Msgs.def('Message preview')

export const noReasonsConfigured = Msgs.def(
	(actionName: string) =>
		`A reason is required for ${actionName}, but no reasons are configured for it (see Admin Action Reasons in settings).`,
)

export const presetReasonPicker = Msgs.def('Preset reason')

export const searchReasons = Msgs.def('Search reasons...')

export const noReasonsFound = Msgs.def('No reasons found.')

export const fillWithPresetReason = Msgs.def('Fill the box with a preset reason')

export const fillWithPresetBroadcast = Msgs.def('Fill the box with a preset broadcast')
