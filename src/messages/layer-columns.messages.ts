import { def } from '@/models/messages.models'

// The layer-table and layer-generation config editors: how a column's display and a generation pick are described.

// -------- the generation config --------

export const noPicksConfigured = def('Add a column or matchup above to give its values weights.')

export const pickOrderHeading = def('Pick order')

export const pickOrderHint = def(
	'Columns and matchups picked weighted-randomly during generation, in pick order. Each pick narrows the candidates for the ones below it, so the first pick shapes the result the most.',
)

export const emptyPickOrder = def('Nothing configured: generation picks layers uniformly.')

export const addPick = def('Add pick')

export const unusedWeightsHeading = def('Unused weights')

export const unusedWeightsHint = def(
	"These have weights but aren't in the pick order, so they have no effect. Add them above to use them.",
	() => ({}),
)

// reads as "<n> weighted"
export const weightedCount = def('weighted')

export const discardWeights = def('Discard')

// -------- one pick's weights --------

// reads as "<column> weights"
export const weightsHeading = def('weights')

export const columnWeightsHint = def(
	'Pick {pickOrder}. Unlisted {column} values weigh {defaultWeight}. Shares assume every value is available in the pool.',
	(pickOrder: number, column: string, defaultWeight: number) => ({ pickOrder, column, defaultWeight }),
)

export const matchupWeightsHint = def(
	'Pick {pickOrder}. Unlisted pairings weigh {defaultWeight}. Pairings are unordered: the weight applies whichever team fields which side.',
	(pickOrder: number, defaultWeight: number) => ({ pickOrder, defaultWeight }),
)

export const valueColumn = def('Value')

export const weightColumn = def('Weight')

export const shareColumn = def('Share')

export const matchupColumn = def('Matchup')

export const removeColumn = def('Remove')

// a value the current layer set has no layers for, so it can never be picked
export const unknownValue = def('(unknown)')

export const noLayersWithValue = def('No layers have this {column} value', (column: string) => ({ column }))

export const noLayersWithMatchup = def('No layers have this {matchup}', (matchup: string) => ({ matchup }))

export const removeWeight = def('Remove {value}', (value: string) => ({ value }))

export const addValue = def('Add {column} value', (column: string) => ({ column }))

export const addMatchup = def('Add matchup')

// between the two sides of a matchup
export const versus = def('vs')

export const factionForTeam = def('Faction (team {team})', (team: number) => ({ team }))

export const unitForTeam = def('Unit (team {team})', (team: number) => ({ team }))

export const sideForTeam = def('{side} (team {team})', (side: string, team: number) => ({ side, team }))

// -------- the layer-table config --------

export const columnsHeading = def('Columns')

export const columnsHint = def('Order and default visibility of columns in the layer table. Drag to reorder; order is top to bottom.')

export const noColumnsConfigured = def('No columns configured.')

export const addColumn = def('Add column')

export const columnPicker = def('Column')

export const dragToReorder = def('Drag to reorder')

export const visibleByDefault = def('visible')

export const defaultSortHeading = def('Default sort')

export const defaultSortHint = def('How the layer table is sorted before any user-applied sort.')

export const sortRandom = def('Random')

export const sortColumn = def('Column')

export const seedPlaceholder = def('seed (optional)')

export const extraMenuItemsHeading = def('Extra menu items')

export const extraMenuItemsHint = def("Extra comparison controls added to the layer table's filter menu.")

export const noExtraMenuItems = def('None.')

export const addMenuItem = def('Add menu item')
