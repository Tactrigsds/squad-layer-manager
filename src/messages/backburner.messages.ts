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

export const satisfiableHint = def('This request has matching layers')

export const unsatisfiableHint = def('No layers match this request right now; it stays queued for later')

export const customConditions = def('{count, plural, one {# custom condition} other {# custom conditions}}', (count: number) => ({ count }))

export const noMatchingLayers = def('No layers in the pool match this request')

export const matchingLayers = def('{count, plural, one {# layer matches} other {# layers match}}', (count: number) => ({ count }))

// -------- describing a request --------

export const versus = def('{first} vs {second}', (first: string, second: string) => ({ first, second }))

export const matchupPart = def(
	'{first} vs {second}{locked, select, yes { (locked)} other {}}',
	(first: string, second: string, locked: boolean) => ({
		first,
		second,
		locked: locked ? 'yes' : 'no',
	}),
)

// a matchup side that constrains nothing
export const anySide = def('any')

export const excludedFilter = def('not {name}', (name: string) => ({ name }))

export const extraConditions = def('+{count, plural, one {# custom condition} other {# custom conditions}}', (count: number) => ({ count }))

export const anyLayer = def('any layer')

export const summaryLine = def(
	'{index}. {description}{own, select, yes { (yours)} other {}}',
	(index: number, description: string, own: boolean) => ({
		index,
		description,
		own: own ? 'yes' : 'no',
	}),
)

// -------- resolving a /reqlayer request --------

export const nothingRequested = def('Nothing requested')

export const ambiguousMap = def('"{token}" matches {count} maps', (token: string, count: number) => ({ token, count }))

export const ambiguousFilter = def('"{token}" matches {count} filters', (token: string, count: number) => ({ token, count }))

export const tooManyTeamValues = def(
	'{column, select, Faction {At most two factions can be requested (a matchup)} Alliance {At most two alliances can be requested (a matchup)} other {At most two units can be requested (a matchup)}}',
	(column: 'Faction' | 'Alliance' | 'Unit') => ({ column }),
)

export const tooManyValues = def(
	'{column, select, layer {Only one layer can be requested} map {Only one map can be requested} gamemode {Only one gamemode can be requested} version {Only one version can be requested} collection {Only one collection can be requested} other {Only one size can be requested}}',
	(column: 'layer' | 'map' | 'gamemode' | 'version' | 'collection' | 'size') => ({ column }),
)

export const unknownRequest = def('Unknown request "{token}"', (token: string) => ({ token }))
