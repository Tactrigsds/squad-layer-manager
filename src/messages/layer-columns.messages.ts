import * as Msgs from '@/messages/shared'

// The layer-table and layer-generation config editors: how a column's display and a generation pick are described.

// -------- the generation config --------

export const noPicksConfigured = Msgs.def('Add a column or matchup above to give its values weights.')

export const pickOrderHeading = Msgs.def('Pick order')

export const pickOrderHint = Msgs.def(
	'Columns and matchups picked weighted-randomly during generation, in pick order. Each pick narrows the candidates for the ones below it, so the first pick shapes the result the most.',
)

export const emptyPickOrder = Msgs.def('Nothing configured: generation picks layers uniformly.')

export const addPick = Msgs.def('Add pick')

export const unusedWeightsHeading = Msgs.def('Unused weights')

export const unusedWeightsHint = Msgs.def(
	"These have weights but aren't in the pick order, so they have no effect. Add them above to use them.",
	() => ({}),
)

// reads as "<n> weighted"
export const weightedCount = Msgs.def('weighted')

export const discardWeights = Msgs.def('Discard')

// -------- one pick's weights --------

// reads as "<column> weights"
export const weightsHeading = Msgs.def('weights')

export const columnWeightsHint = Msgs.def(
	'Pick {pickOrder}. Unlisted {column} values weigh {defaultWeight}. Shares assume every value is available in the pool.',
	(pickOrder: number, column: string, defaultWeight: number) => ({ pickOrder, column, defaultWeight }),
)

export const matchupWeightsHint = Msgs.def(
	'Pick {pickOrder}. Unlisted pairings weigh {defaultWeight}. Pairings are unordered: the weight applies whichever team fields which side.',
	(pickOrder: number, defaultWeight: number) => ({ pickOrder, defaultWeight }),
)

export const valueColumn = Msgs.def('Value')

export const weightColumn = Msgs.def('Weight')

export const shareColumn = Msgs.def('Share')

export const matchupColumn = Msgs.def('Matchup')

export const removeColumn = Msgs.def('Remove')

// a value the current layer set has no layers for, so it can never be picked
export const unknownValue = Msgs.def('(unknown)')

export const noLayersWithValue = Msgs.def('No layers have this {column} value', (column: string) => ({ column }))

export const noLayersWithMatchup = Msgs.def('No layers have this {matchup}', (matchup: string) => ({ matchup }))

export const removeWeight = Msgs.def('Remove {value}', (value: string) => ({ value }))

export const addValue = Msgs.def('Add {column} value', (column: string) => ({ column }))

export const addMatchup = Msgs.def('Add matchup')

// between the two sides of a matchup
export const versus = Msgs.def('vs')

export const factionForTeam = Msgs.def('Faction (team {team})', (team: number) => ({ team }))

export const unitForTeam = Msgs.def('Unit (team {team})', (team: number) => ({ team }))

export const sideForTeam = Msgs.def('{side} (team {team})', (side: string, team: number) => ({ side, team }))

// -------- the layer-table config --------

export const columnsHeading = Msgs.def('Columns')

export const columnsHint = Msgs.def('Order and default visibility of columns in the layer table. Drag to reorder; order is top to bottom.')

export const noColumnsConfigured = Msgs.def('No columns configured.')

export const addColumn = Msgs.def('Add column')

export const columnPicker = Msgs.def('Column')

export const dragToReorder = Msgs.def('Drag to reorder')

export const visibleByDefault = Msgs.def('visible')

export const defaultSortHeading = Msgs.def('Default sort')

export const defaultSortHint = Msgs.def('How the layer table is sorted before any user-applied sort.')

export const sortRandom = Msgs.def('Random')

export const sortColumn = Msgs.def('Column')

export const seedPlaceholder = Msgs.def('seed (optional)')

export const extraMenuItemsHeading = Msgs.def('Extra menu items')

export const extraMenuItemsHint = Msgs.def("Extra comparison controls added to the layer table's filter menu.")

export const noExtraMenuItems = Msgs.def('None.')

export const addMenuItem = Msgs.def('Add menu item')
