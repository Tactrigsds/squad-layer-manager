import * as Msgs from '@/messages/shared'

export const added = Msgs.def((parts: string[], ownCount: number, evictedCount: number) => {
	const base = `Layer request queued: ${parts.join(', ')}. You have ${ownCount} request${ownCount !== 1 ? 's' : ''} queued`
	return {
		warn: () =>
			evictedCount > 0
				? `${base} (your oldest ${evictedCount === 1 ? 'request was' : `${evictedCount} requests were`} dropped to make room).`
				: `${base}.`,
	}
})

export const noSolutions = Msgs.def((request: string) => ({
	warn: () => `No layers in the current pool match "${request}".`,
}))

export const backburnerFull = Msgs.def((max: number) => ({
	warn: () => `The layer request list is full (max ${max}).`,
}))

export const removed = Msgs.def((description: string) => ({
	warn: () => `Removed layer request: ${description}`,
}))

export const empty = Msgs.def(() => ({ warn: () => 'No layer requests queued.' }))

export const cannotCombine = Msgs.def(() => ({
	toast: () => ['Cannot combine these requests: a filter is applied normally on one and inverted on the other'],
}))

export const emptyRequest = Msgs.def(() => ({
	toast: () => ['Empty request', { description: 'Pick at least one of layer, map, gamemode, version, matchup or a filter' }],
}))

// -------- the layer requests panel --------

export const heading = Msgs.def((count: number) => ({ text: () => `Layer Requests (${count})` }))

export const unsavedBadge = Msgs.def(() => ({ text: () => 'unsaved' }))

export const panelHelp = Msgs.def(() => ({
	text: () => '"Layer Requests" will be made part of the layer generation process if the layer queue runs out of explicitely set layers.',
}))

export const commandExampleLabel = Msgs.def(() => ({ text: () => 'Ingame command example:' }))

export const revertToSaved = Msgs.def(() => ({ text: () => 'Revert to saved' }))

export const requestLayer = Msgs.def(() => ({ text: () => 'Request layer' }))

export const toggleForceSaveHint = Msgs.def(() => ({ text: () => 'Toggle force save (save even if others are still editing)' }))

export const editRequests = Msgs.def(() => ({ text: () => 'Edit layer requests' }))

export const startEditing = Msgs.def(() => ({ text: () => 'Start Editing' }))

export const noRequests = Msgs.def(() => ({ text: () => 'No layer requests queued.' }))

// -------- one request row --------

export const cloneRequest = Msgs.def(() => ({ text: () => 'Clone request' }))

export const cloneRequestHint = Msgs.def(() => ({ text: () => 'Clone this request as your own' }))

export const editRequest = Msgs.def(() => ({ text: () => 'Edit request' }))

export const removeRequest = Msgs.def(() => ({ text: () => 'Remove request' }))

export const requestedBy = Msgs.def(() => ({ text: () => 'Requested By' }))

// a request made in chat by a player with no linked discord account, and no steam id recorded either
export const unknownRequester = Msgs.def(() => ({ text: () => 'unknown' }))

// -------- the request editor --------

export const addRequestedLayerTitle = Msgs.def(() => ({ text: () => 'Add requested layer' }))

export const editRequestTitle = Msgs.def(() => ({ text: () => 'Edit layer request' }))

export const newRequestTitle = Msgs.def(() => ({ text: () => 'Request a layer' }))

export const cancel = Msgs.def(() => ({ text: () => 'Cancel' }))

export const applyRequest = Msgs.def(() => ({ text: () => 'Apply' }))

export const addRequest = Msgs.def(() => ({ text: () => 'Add request' }))

export const componentsTab = Msgs.def(() => ({ text: () => 'Components' }))

export const specificLayerTab = Msgs.def(() => ({ text: () => 'Specific layer' }))

export const matchupLabel = Msgs.def(() => ({ text: () => 'Matchup' }))

// names the parts of an existing request the components editor does not surface, so an edit cannot silently drop them
export const alsoConstrainedBy = Msgs.def((extras: string) => ({ text: () => `Also constrained by ${extras} (kept as-is).` }))

export const filtersHeading = Msgs.def(() => ({ text: () => 'Filters' }))

export const addFilter = Msgs.def(() => ({ text: () => 'Add filter' }))

export const filterPicker = Msgs.def(() => ({ text: () => 'filter' }))

export const selectFilter = Msgs.def(() => ({ text: () => 'Select filter...' }))

export const clearOtherConstraints = Msgs.def(() => ({ text: () => 'Remove all other constraints and select this one' }))
