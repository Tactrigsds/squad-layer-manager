import * as Msgs from '@/messages/shared'

export const added = Msgs.def((parts: string[], ownCount: number, evictedCount: number) => ({
	warn: (locale?: string) =>
		Msgs.t(
			'Layer request queued: {parts}. You have {ownCount, plural, one {# request} other {# requests}} queued' +
				'{evictedCount, plural, =0 {.} one { (your oldest request was dropped to make room).} ' +
				'other { (your oldest # requests were dropped to make room).}}',
			{ parts: parts.join(', '), ownCount, evictedCount },
			locale,
		),
}))

export const noSolutions = Msgs.def((request: string) => ({
	warn: (locale?: string) => Msgs.t('No layers in the current pool match "{request}".', { request }, locale),
}))

export const backburnerFull = Msgs.def((max: number) => ({
	warn: (locale?: string) => Msgs.t('The layer request list is full (max {max}).', { max }, locale),
}))

export const removed = Msgs.def((description: string) => ({
	warn: (locale?: string) => Msgs.t('Removed layer request: {description}', { description }, locale),
}))

export const empty = Msgs.def(() => ({ warn: (locale?: string) => Msgs.t('No layer requests queued.', undefined, locale) }))

export const cannotCombine = Msgs.def(() => ({
	toast: () => [Msgs.t('Cannot combine these requests: a filter is applied normally on one and inverted on the other')],
}))

export const emptyRequest = Msgs.def(() => ({
	toast: () => [
		Msgs.t('Empty request'),
		{ description: Msgs.t('Pick at least one of layer, map, gamemode, version, matchup or a filter') },
	],
}))

// -------- the layer requests panel --------

export const heading = Msgs.def('Layer Requests ({count})', (count: number) => ({ count }))

export const unsavedBadge = Msgs.def('unsaved')

export const panelHelp = Msgs.def(
	'"Layer Requests" will be made part of the layer generation process if the layer queue runs out of explicitely set layers.',
)

export const commandExampleLabel = Msgs.def('Ingame command example:')

export const revertToSaved = Msgs.def('Revert to saved')

export const requestLayer = Msgs.def('Request layer')

export const toggleForceSaveHint = Msgs.def('Toggle force save (save even if others are still editing)')

export const editRequests = Msgs.def('Edit layer requests')

export const startEditing = Msgs.def('Start Editing')

export const noRequests = Msgs.def('No layer requests queued.')

// -------- one request row --------

export const cloneRequest = Msgs.def('Clone request')

export const cloneRequestHint = Msgs.def('Clone this request as your own')

export const editRequest = Msgs.def('Edit request')

export const removeRequest = Msgs.def('Remove request')

export const requestedBy = Msgs.def('Requested By')

// a request made in chat by a player with no linked discord account, and no steam id recorded either
export const unknownRequester = Msgs.def('unknown')

// -------- the request editor --------

export const addRequestedLayerTitle = Msgs.def('Add requested layer')

export const editRequestTitle = Msgs.def('Edit layer request')

export const newRequestTitle = Msgs.def('Request a layer')

export const cancel = Msgs.def('Cancel')

export const applyRequest = Msgs.def('Apply')

export const addRequest = Msgs.def('Add request')

export const componentsTab = Msgs.def('Components')

export const specificLayerTab = Msgs.def('Specific layer')

export const matchupLabel = Msgs.def('Matchup')

// names the parts of an existing request the components editor does not surface, so an edit cannot silently drop them
export const alsoConstrainedBy = Msgs.def('Also constrained by {extras} (kept as-is).', (extras: string) => ({ extras }))

export const filtersHeading = Msgs.def('Filters')

export const addFilter = Msgs.def('Add filter')

export const filterPicker = Msgs.def('filter')

export const selectFilter = Msgs.def('Select filter...')

export const clearOtherConstraints = Msgs.def('Remove all other constraints and select this one')
