// see settings.messages.tsx on why a messages module with a react target keeps React in scope
import * as React from 'react'

import * as Msgs from '@/messages/shared'

// The layer table's clipboard receipts. Unlike SM_Msgs.copiedToClipboard these put what was copied in the
// toast itself rather than in a description, and only the history-entry one pluralizes.
export const copiedSetNextCommand = Msgs.def(() => ({
	toast: () => [Msgs.t('Copied AdminSetNextLayer Command')],
}))

export const copiedLayerIds = Msgs.def(() => ({
	toast: () => [Msgs.t('Copied Layer ID')],
}))

export const copiedHistoryEntryIds = Msgs.def((count: number) => ({
	toast: () => [`Copied History Entry ID${count > 1 ? 's' : ''}`],
}))

// -------- the layer table --------

export const showLayerInfo = Msgs.def('Show layer info')

export const copyLayerId = Msgs.def('Copy layer id')

export const copyHistoryEntryId = Msgs.def('Copy history entry id')

// the sort direction badge on a numeric column header, where the sort is by magnitude
export const sortByMagnitude = Msgs.def('|x|')

export const layerIndicatorsColumn = Msgs.def('Layer Indicators')

export const focusLayer = Msgs.def('Focus Layer')

export const focusLayerShortcut = Msgs.def('Ctrl+Click')

export const columnPicker = Msgs.def('Column')

export const toggleColumns = Msgs.def('Toggle Columns')

export const showSelected = Msgs.def('Show Selected')

export const resetSelectedLayers = Msgs.def('Reset Selected Layers')

export const selectedCount = Msgs.def('{count} selected', (count: number) => ({ count }))

export const randomize = Msgs.def('Randomize')

export const randomizeHint = Msgs.def('Randomize layer selection (weighted to preferable layers)')

export const rawLayerPlaceholder = Msgs.def('Ex: Narva_RAAS_v1 RGF USMC or a layer id')

export const layerFound = Msgs.def('Layer exists in the database')

// the count is emphasised, which is part of the sentence; the readout styles `strong` itself
export const matchedLayers = Msgs.def((count: string) => ({
	react: () => (
		<>
			<strong>{count}</strong> matched layers
		</>
	),
}))

export const noLayersMatched = Msgs.def('No layers matched')

export const initializingDatabase = Msgs.def('Initializing layer database...')

export const downloadingLayers = Msgs.def('Downloading layers from server, this may take a few minutes...')

export const loadFailed = Msgs.def('Error loading layers:')

export const loadFailedUnknown = Msgs.def('Unknown error')

// -------- the layer info panel --------

export const copySetNextCommand = Msgs.def('Copy AdminSetNextLayer command')

export const openInPopoutWindow = Msgs.def('Open in popout window')

export const openInSquadCalc = Msgs.def('Open in SquadCalc')

export const detailsTab = Msgs.def('Details')

export const scoresTab = Msgs.def('Scores')

export const scoresUnavailable = Msgs.def('Scores are not available for this layer')

export const noDetails = Msgs.def('No details available')

export const noScores = Msgs.def('No scores available')

// -------- one team's details --------

// A team named for a reader rather than for a slot. Which scheme applies is the caller's: 'A'/'B' are normalized
// across the swap, 1/2 are the raw slot (see docs/architecture.md). The faction rides in parentheses where the
// layer is known.

export const teamName = Msgs.def(
	'{team, select, A {Team A} B {Team B} 1 {Team 1} other {Team 2}}{hasFaction, select, yes { ({faction})} other {}}',
	(team: 'A' | 'B' | 1 | 2, faction?: string | null) => ({ team: String(team), faction, hasFaction: faction ? 'yes' : 'no' }),
)

export const team1 = Msgs.def('Team 1')

export const team2 = Msgs.def('Team 2')

export const team1Vehicles = Msgs.def('Team 1 Vehicles')

export const team2Vehicles = Msgs.def('Team 2 Vehicles')

export const startingTickets = Msgs.def('Starting Tickets:')

// the faction line under a team heading: `<team> (<role>) - <faction> (<unit type>)`
export const teamFactionLine = Msgs.def((team: string, role: string | undefined, faction: string, unitType: string) => ({
	react: () => (
		<>
			<strong>
				{team}
				{role && ` (${role})`}
			</strong>{' '}
			- {faction} ({unitType})
		</>
	),
}))

// the same heading in the score grid, where the unit is named rather than typed
export const teamScoreHeading = Msgs.def((team: string, role: string | undefined, faction: string, unit: string) => ({
	react: () => (
		<>
			<strong>
				{team}
				{role && ` (${role})`}
			</strong>{' '}
			- {faction} {unit}
		</>
	),
}))

export const unknownUnit = Msgs.def('Unknown')

export const vehicleDelayRespawn = Msgs.def('Delay/Respawn (in minutes)')

export const vehicleType = Msgs.def('Vehicle Type')

export const vehicleName = Msgs.def('Name')

// -------- the score bars --------

export const logarithmicScale = Msgs.def('(logarithmic scale)')

export const balanceDifferential = Msgs.def('Balance Differential')

// value carries its own sign where the bar has one cutoff per side
export const poolCutoff = Msgs.def('Pool Cutoff ({value})', (value: string) => ({ value }))

// The number is coloured by which team the difference favours, which no single class on the container can
// express, so the caller renders it and the message positions it.
export const scoreDiff = Msgs.def((value: React.ReactNode) => ({
	react: () => <>(diff: {value})</>,
}))

export const scoreUnavailable = Msgs.def('N/A')

// -------- the layer config summary --------

export const commanderLabel = Msgs.def('Commander:')

export const commanderDisabled = Msgs.def('Disabled')

export const lightingLabel = Msgs.def('Lighting:')

// -------- unparsed layers --------

export const unparsedLayer = Msgs.def('This layer is unknown and was not able to be fully parsed:')

export const unknownLayer = Msgs.def('Layer Was parsed, but is unknown')

// between the two teams in a short layer name
export const versus = Msgs.def('vs')

export const setByLabel = Msgs.def('Set By')

// -------- the layer set dialogs --------

export const multiLayerPlaceholder = Msgs.def('Enter one layer per line (e.g. Narva_RAAS_v1 RGF USMC or a layer id)')

export const addLayers = Msgs.def('{count, plural, =0 {Add Layers} one {Add # Layer} other {Add # Layers}}', (count: number) => ({ count }))

export const editLayerTitle = Msgs.def('Edit Layer')

export const submit = Msgs.def('Submit')
