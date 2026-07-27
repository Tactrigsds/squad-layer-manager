// see settings.messages.tsx on why a messages module with a react target keeps React in scope
import * as React from 'react'

import * as Msgs from '@/messages/shared'

// The layer table's clipboard receipts. Unlike SM_Msgs.copiedToClipboard these put what was copied in the
// toast itself rather than in a description, and only the history-entry one pluralizes.
export const copiedSetNextCommand = Msgs.def(() => ({
	toast: () => ['Copied AdminSetNextLayer Command'],
}))

export const copiedLayerIds = Msgs.def(() => ({
	toast: () => ['Copied Layer ID'],
}))

export const copiedHistoryEntryIds = Msgs.def((count: number) => ({
	toast: () => [`Copied History Entry ID${count > 1 ? 's' : ''}`],
}))

// -------- the layer table --------

export const showLayerInfo = Msgs.def(() => ({ text: () => 'Show layer info' }))

export const copyLayerId = Msgs.def(() => ({ text: () => 'Copy layer id' }))

export const copyHistoryEntryId = Msgs.def(() => ({ text: () => 'Copy history entry id' }))

// the sort direction badge on a numeric column header, where the sort is by magnitude
export const sortByMagnitude = Msgs.def(() => ({ text: () => '|x|' }))

export const layerIndicatorsColumn = Msgs.def(() => ({ text: () => 'Layer Indicators' }))

export const focusLayer = Msgs.def(() => ({ text: () => 'Focus Layer' }))

export const focusLayerShortcut = Msgs.def(() => ({ text: () => 'Ctrl+Click' }))

export const columnPicker = Msgs.def(() => ({ text: () => 'Column' }))

export const toggleColumns = Msgs.def(() => ({ text: () => 'Toggle Columns' }))

export const showSelected = Msgs.def(() => ({ text: () => 'Show Selected' }))

export const resetSelectedLayers = Msgs.def(() => ({ text: () => 'Reset Selected Layers' }))

export const selectedCount = Msgs.def((count: number) => ({ text: () => `${count} selected` }))

export const randomize = Msgs.def(() => ({ text: () => 'Randomize' }))

export const randomizeHint = Msgs.def(() => ({ text: () => 'Randomize layer selection (weighted to preferable layers)' }))

export const rawLayerPlaceholder = Msgs.def(() => ({ text: () => 'Ex: Narva_RAAS_v1 RGF USMC or a layer id' }))

export const layerFound = Msgs.def(() => ({ text: () => 'Layer exists in the database' }))

// the count is emphasised, which is part of the sentence; the readout styles `strong` itself
export const matchedLayers = Msgs.def((count: string) => ({
	react: () => (
		<>
			<strong>{count}</strong> matched layers
		</>
	),
}))

export const noLayersMatched = Msgs.def(() => ({ text: () => 'No layers matched' }))

export const initializingDatabase = Msgs.def(() => ({ text: () => 'Initializing layer database...' }))

export const downloadingLayers = Msgs.def(() => ({ text: () => 'Downloading layers from server, this may take a few minutes...' }))

export const loadFailed = Msgs.def(() => ({ text: () => 'Error loading layers:' }))

export const loadFailedUnknown = Msgs.def(() => ({ text: () => 'Unknown error' }))

// -------- the layer info panel --------

export const copySetNextCommand = Msgs.def(() => ({ text: () => 'Copy AdminSetNextLayer command' }))

export const openInPopoutWindow = Msgs.def(() => ({ text: () => 'Open in popout window' }))

export const openInSquadCalc = Msgs.def(() => ({ text: () => 'Open in SquadCalc' }))

export const detailsTab = Msgs.def(() => ({ text: () => 'Details' }))

export const scoresTab = Msgs.def(() => ({ text: () => 'Scores' }))

export const scoresUnavailable = Msgs.def(() => ({ text: () => 'Scores are not available for this layer' }))

export const noDetails = Msgs.def(() => ({ text: () => 'No details available' }))

export const noScores = Msgs.def(() => ({ text: () => 'No scores available' }))

// -------- one team's details --------

// A team named for a reader rather than for a slot. Which scheme applies is the caller's: 'A'/'B' are normalized
// across the swap, 1/2 are the raw slot (see docs/architecture.md). The faction rides in parentheses where the
// layer is known.
const normalizedTeamNames: Record<'A' | 'B', string> = { A: 'Team A', B: 'Team B' }
const rawTeamNames: Record<1 | 2, string> = { 1: 'Team 1', 2: 'Team 2' }

export const teamName = Msgs.def((team: 'A' | 'B' | 1 | 2, faction?: string | null) => ({
	text: () => {
		const name = typeof team === 'number' ? rawTeamNames[team] : normalizedTeamNames[team]
		return faction ? `${name} (${faction})` : name
	},
}))

export const team1 = Msgs.def(() => ({ text: () => 'Team 1' }))

export const team2 = Msgs.def(() => ({ text: () => 'Team 2' }))

export const team1Vehicles = Msgs.def(() => ({ text: () => 'Team 1 Vehicles' }))

export const team2Vehicles = Msgs.def(() => ({ text: () => 'Team 2 Vehicles' }))

export const startingTickets = Msgs.def(() => ({ text: () => 'Starting Tickets:' }))

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

export const unknownUnit = Msgs.def(() => ({ text: () => 'Unknown' }))

export const vehicleDelayRespawn = Msgs.def(() => ({ text: () => 'Delay/Respawn (in minutes)' }))

export const vehicleType = Msgs.def(() => ({ text: () => 'Vehicle Type' }))

export const vehicleName = Msgs.def(() => ({ text: () => 'Name' }))

// -------- the score bars --------

export const logarithmicScale = Msgs.def(() => ({ text: () => '(logarithmic scale)' }))

export const balanceDifferential = Msgs.def(() => ({ text: () => 'Balance Differential' }))

// value carries its own sign where the bar has one cutoff per side
export const poolCutoff = Msgs.def((value: string) => ({ text: () => `Pool Cutoff (${value})` }))

// The number is coloured by which team the difference favours, which no single class on the container can
// express, so the caller renders it and the message positions it.
export const scoreDiff = Msgs.def((value: React.ReactNode) => ({
	react: () => <>(diff: {value})</>,
}))

export const scoreUnavailable = Msgs.def(() => ({ text: () => 'N/A' }))

// -------- the layer config summary --------

export const commanderLabel = Msgs.def(() => ({ text: () => 'Commander:' }))

export const commanderDisabled = Msgs.def(() => ({ text: () => 'Disabled' }))

export const lightingLabel = Msgs.def(() => ({ text: () => 'Lighting:' }))

// -------- unparsed layers --------

export const unparsedLayer = Msgs.def(() => ({ text: () => 'This layer is unknown and was not able to be fully parsed:' }))

export const unknownLayer = Msgs.def(() => ({ text: () => 'Layer Was parsed, but is unknown' }))

// between the two teams in a short layer name
export const versus = Msgs.def(() => ({ text: () => 'vs' }))

export const setByLabel = Msgs.def(() => ({ text: () => 'Set By' }))
