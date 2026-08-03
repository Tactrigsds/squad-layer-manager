import { def, t, type TString } from '@/models/messages.models'

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

// -------- vehicle classes --------
// The vehicle class codes (SquadLayerList vocabulary) as surfaced by the Vehicle type filter columns.
// Keyed by code so data-driven vocabularies fall back to the raw code for anything unlisted.

export const vehicleTypeLabels: Record<string, TString> = {
	AH: t('Attack helicopter'),
	APC_TRACKED: t('Tracked APC'),
	APC_WHEELED: t('Wheeled APC'),
	APC_OTHER: t('Other APC'),
	BOAT: t('Boat'),
	IFV_TRACKED: t('Tracked IFV'),
	IFV_WHEELED: t('Wheeled IFV'),
	LOGI_TRACKED: t('Tracked logistics'),
	LOGI_WHEELED: t('Wheeled logistics'),
	LOGI_BOAT: t('Logistics boat'),
	LOGI_OTHER: t('Other logistics'),
	LTV: t('Light transport vehicle'),
	MBT: t('Main battle tank'),
	MGS: t('Mobile gun system'),
	MRAP: t('Mine-resistant vehicle'),
	MSV: t('Mobile spawn vehicle'),
	RSV: t('Recon scout vehicle'),
	SPA: t('Self-propelled artillery'),
	SPAA: t('Self-propelled anti-air'),
	TD: t('Tank destroyer'),
	TRAN: t('Transport vehicle'),
	UH: t('Utility helicopter'),
	ULTV: t('Ultralight transport vehicle'),
}

export const vehicleTypeDescriptions: Record<string, TString> = {
	AH: t('Helicopters and gunships built to attack ground targets. Mod close-air-support aircraft land here too.'),
	APC_TRACKED: t('Armored troop carriers on tracks: slower and better protected, and often amphibious.'),
	APC_WHEELED: t('Armored troop carriers on wheels: faster on roads, thinner armor.'),
	APC_OTHER: t('Armored troop carriers on neither tracks nor wheels, such as walkers and repulsorcraft.'),
	BOAT: t('Armed and transport watercraft.'),
	IFV_TRACKED: t('Autocannon-armed carriers on tracks, often with anti-tank missiles.'),
	IFV_WHEELED: t('Autocannon-armed carriers on wheels, often with anti-tank missiles.'),
	LOGI_TRACKED: t('Supply vehicles on tracks: slow, but able to reach ground wheels cannot.'),
	LOGI_WHEELED: t('Supply trucks and pickups, the usual way construction and ammunition reach a FOB.'),
	LOGI_BOAT: t('Supply watercraft, for FOBs a truck cannot reach.'),
	LOGI_OTHER: t('Supply vehicles on neither tracks, wheels nor water.'),
	LTV: t('Armed light vehicles: jeeps, technicals and gun trucks with mounted weapons.'),
	MBT: t('Heavily armored tanks with large-caliber main guns.'),
	MGS: t('Lighter platforms carrying a tank-caliber gun without tank armor.'),
	MRAP: t('Mine-resistant armored cars, usually with a turret or remote weapon station.'),
	MSV: t('Deployable spawn points on wheels or tracks.'),
	RSV: t('Reconnaissance vehicles: fast scouts with good optics and light armament.'),
	SPA: t('Mobile artillery: rocket and gun carriers for indirect fire.'),
	SPAA: t('Mobile anti-aircraft gun platforms.'),
	TD: t('Anti-armor vehicles built around missiles or high-velocity guns.'),
	TRAN: t('Unarmed or lightly armed troop transports.'),
	UH: t('Utility helicopters for troop transport and logistics.'),
	ULTV: t('Motorbikes, quads and other ultralight runabouts.'),
}
