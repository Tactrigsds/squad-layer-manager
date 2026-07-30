import { def, t } from '@/models/messages.models'

export const added = def((parts: string[], ownCount: number, evictedCount: number) => ({
	warn: t(
		'Layer request queued: {parts}. You have {ownCount, plural, one {# request} other {# requests}} queued{evictedCount, plural, =0 {.} one { (your oldest request was dropped to make room).} other { (your oldest # requests were dropped to make room).}}',
		{ parts: parts.join(', '), ownCount, evictedCount },
	),
}))

export const noSolutions = def('No layers in the current pool match "{request}".', (request: string) => ({ request }))

export const backburnerFull = def('The layer request list is full (max {max}).', (max: number) => ({ max }))

export const removed = def((description: string) => ({
	warn: t('Removed layer request: {description}', { description }),
}))

export const empty = def('No layer requests queued.')

export const cannotCombine = def(() => ({
	toast: [t('Cannot combine these requests: a filter is applied normally on one and inverted on the other')],
}))

export const emptyRequest = def(() => ({
	toast: [t('Empty request'), { description: t('Pick at least one of layer, map, gamemode, version, matchup or a filter') }],
}))

// -------- the layer requests panel --------

export const heading = def('Layer Requests ({count})', (count: number) => ({ count }))

export const unsavedBadge = def('unsaved')

export const panelHelp = def(
	'"Layer Requests" will be made part of the layer generation process if the layer queue runs out of explicitely set layers.',
)

export const commandExampleLabel = def('Ingame command example:')

export const revertToSaved = def('Revert to saved')

export const requestLayer = def('Request layer')

export const toggleForceSaveHint = def('Toggle force save (save even if others are still editing)')

export const editRequests = def('Edit layer requests')

export const startEditing = def('Start Editing')

export const noRequests = def('No layer requests queued.')

// -------- one request row --------

export const cloneRequest = def('Clone request')

export const cloneRequestHint = def('Clone this request as your own')

export const editRequest = def('Edit request')

export const removeRequest = def('Remove request')

export const requestedBy = def('Requested By')

// a request made in chat by a player with no linked discord account, and no steam id recorded either
export const unknownRequester = def('unknown')

// -------- the request editor --------

export const addRequestedLayerTitle = def('Add requested layer')

export const editRequestTitle = def('Edit layer request')

export const newRequestTitle = def('Request a layer')

export const cancel = def('Cancel')

export const applyRequest = def('Apply')

export const addRequest = def('Add request')

export const componentsTab = def('Components')

export const specificLayerTab = def('Specific layer')

export const matchupLabel = def('Matchup')

// names the parts of an existing request the components editor does not surface, so an edit cannot silently drop them
export const alsoConstrainedBy = def('Also constrained by {extras} (kept as-is).', (extras: string) => ({ extras }))

export const filtersHeading = def('Filters')

export const addFilter = def('Add filter')

export const filterPicker = def('filter')

export const selectFilter = def('Select filter...')

export const clearOtherConstraints = def('Remove all other constraints and select this one')
