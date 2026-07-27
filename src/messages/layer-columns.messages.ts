import * as Msgs from '@/messages/shared'

// The layer-table and layer-generation config editors: how a column's display and a generation pick are described.

// -------- the generation config --------

export const noPicksConfigured = Msgs.def(() => ({ text: () => 'Add a column or matchup above to give its values weights.' }))

export const pickOrderHeading = Msgs.def(() => ({ text: () => 'Pick order' }))

export const pickOrderHint = Msgs.def(() => ({
	text: () =>
		'Columns and matchups picked weighted-randomly during generation, in pick order. Each pick narrows the candidates for the ones ' +
		'below it, so the first pick shapes the result the most.',
}))

export const emptyPickOrder = Msgs.def(() => ({ text: () => 'Nothing configured: generation picks layers uniformly.' }))

export const addPick = Msgs.def(() => ({ text: () => 'Add pick' }))

export const unusedWeightsHeading = Msgs.def(() => ({ text: () => 'Unused weights' }))

export const unusedWeightsHint = Msgs.def(() => ({
	text: () => `These have weights but aren't in the pick order, so they have no effect. Add them above to use them.`,
}))

// reads as "<n> weighted"
export const weightedCount = Msgs.def(() => ({ text: () => 'weighted' }))

export const discardWeights = Msgs.def(() => ({ text: () => 'Discard' }))

// -------- one pick's weights --------

// reads as "<column> weights"
export const weightsHeading = Msgs.def(() => ({ text: () => 'weights' }))

export const columnWeightsHint = Msgs.def((pickOrder: number, column: string, defaultWeight: number) => ({
	text: () => `Pick ${pickOrder}. Unlisted ${column} values weigh ${defaultWeight}. Shares assume every value is available in the pool.`,
}))

export const matchupWeightsHint = Msgs.def((pickOrder: number, defaultWeight: number) => ({
	text: () =>
		`Pick ${pickOrder}. Unlisted pairings weigh ${defaultWeight}. Pairings are unordered: the weight applies whichever team fields ` +
		'which side.',
}))

export const valueColumn = Msgs.def(() => ({ text: () => 'Value' }))

export const weightColumn = Msgs.def(() => ({ text: () => 'Weight' }))

export const shareColumn = Msgs.def(() => ({ text: () => 'Share' }))

export const matchupColumn = Msgs.def(() => ({ text: () => 'Matchup' }))

export const removeColumn = Msgs.def(() => ({ text: () => 'Remove' }))

// a value the current layer set has no layers for, so it can never be picked
export const unknownValue = Msgs.def(() => ({ text: () => '(unknown)' }))

export const noLayersWithValue = Msgs.def((column: string) => ({ text: () => `No layers have this ${column} value` }))

export const noLayersWithMatchup = Msgs.def((matchup: string) => ({ text: () => `No layers have this ${matchup}` }))

export const removeWeight = Msgs.def((value: string) => ({ text: () => `Remove ${value}` }))

export const addValue = Msgs.def((column: string) => ({ text: () => `Add ${column} value` }))

export const addMatchup = Msgs.def(() => ({ text: () => 'Add matchup' }))

// between the two sides of a matchup
export const versus = Msgs.def(() => ({ text: () => 'vs' }))

export const factionForTeam = Msgs.def((team: number) => ({ text: () => `Faction (team ${team})` }))

export const unitForTeam = Msgs.def((team: number) => ({ text: () => `Unit (team ${team})` }))

export const sideForTeam = Msgs.def((side: string, team: number) => ({ text: () => `${side} (team ${team})` }))

// -------- the layer-table config --------

export const columnsHeading = Msgs.def(() => ({ text: () => 'Columns' }))

export const columnsHint = Msgs.def(() => ({
	text: () => 'Order and default visibility of columns in the layer table. Drag to reorder; order is top to bottom.',
}))

export const noColumnsConfigured = Msgs.def(() => ({ text: () => 'No columns configured.' }))

export const addColumn = Msgs.def(() => ({ text: () => 'Add column' }))

export const columnPicker = Msgs.def(() => ({ text: () => 'Column' }))

export const dragToReorder = Msgs.def(() => ({ text: () => 'Drag to reorder' }))

export const visibleByDefault = Msgs.def(() => ({ text: () => 'visible' }))

export const defaultSortHeading = Msgs.def(() => ({ text: () => 'Default sort' }))

export const defaultSortHint = Msgs.def(() => ({ text: () => 'How the layer table is sorted before any user-applied sort.' }))

export const sortRandom = Msgs.def(() => ({ text: () => 'Random' }))

export const sortColumn = Msgs.def(() => ({ text: () => 'Column' }))

export const seedPlaceholder = Msgs.def(() => ({ text: () => 'seed (optional)' }))

export const extraMenuItemsHeading = Msgs.def(() => ({ text: () => 'Extra menu items' }))

export const extraMenuItemsHint = Msgs.def(() => ({ text: () => `Extra comparison controls added to the layer table's filter menu.` }))

export const noExtraMenuItems = Msgs.def(() => ({ text: () => 'None.' }))

export const addMenuItem = Msgs.def(() => ({ text: () => 'Add menu item' }))
