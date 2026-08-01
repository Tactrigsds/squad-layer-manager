// see settings.messages.tsx on why a messages module with a react target keeps React in scope
import * as React from 'react'

import { def, rt, t } from '@/models/messages.models'

// The layer table's clipboard receipts. Unlike SM_Msgs.copiedToClipboard these put what was copied in the
// toast itself rather than in a description, and only the history-entry one pluralizes.
export const copiedSetNextCommand = def(() => ({
	toast: [t('Copied AdminSetNextLayer Command')],
}))

export const copiedLayerIds = def(() => ({
	toast: [t('Copied Layer ID')],
}))

export const copiedHistoryEntryIds = def((count: number) => ({
	toast: [t('{count, plural, one {Copied History Entry ID} other {Copied History Entry IDs}}', { count })],
}))

// -------- the layer table --------

// names the layer actions where they share a menu with actions on something else, e.g. a match history row
export const layerSub = def('Layer')

export const showDetails = def('Show details')

export const showScores = def('Show scores')

export const copySub = def('Copy...')

export const copyLayerId = def('Copy layer id')

export const copyHistoryEntryId = def('Copy history entry id')

// the sort direction badge on a numeric column header, where the sort is by magnitude
export const sortByMagnitude = def('|x|')

export const layerIndicatorsColumn = def('Layer Indicators')

export const focusLayer = def('Focus Layer')

export const focusLayerShortcut = def('Ctrl+Click')

export const columnPicker = def('Column')

export const toggleColumns = def('Toggle Columns')

export const showSelected = def('Show Selected')

export const resetSelectedLayers = def('Reset Selected Layers')

export const selectedCount = def('{count} selected', (count: number) => ({ count }))

export const randomize = def('Randomize')

export const randomizeHint = def('Randomize layer selection (weighted to preferable layers)')

export const rawLayerPlaceholder = def('Ex: Narva_RAAS_v1 RGF USMC or a layer id')

export const layerFound = def('Layer exists in the database')

// the count is emphasised, which is part of the sentence; the readout styles `strong` itself
export const matchedLayers = def((count: string) => ({
	richText: rt('<strong>{count}</strong> matched layers', { count }),
}))

export const noLayersMatched = def('No layers matched')

export const initializingDatabase = def('Initializing layer database...')

export const downloadingLayers = def('Downloading layers from server, this may take a few minutes...')

export const loadFailed = def('Error loading layers:')

export const loadFailedUnknown = def('Unknown error')

// -------- the layer info panel --------

export const copySetNextCommand = def('Copy AdminSetNextLayer command')

export const openInPopoutWindow = def('Open in popout window')

export const openInSquadCalc = def('Open in SquadCalc')

export const detailsTab = def('Details')

export const scoresTab = def('Scores')

export const scoresUnavailable = def('Scores are not available for this layer')

export const noDetails = def('No details available')

export const noScores = def('No scores available')

// -------- one team's details --------

// A team named for a reader rather than for a slot. Which scheme applies is the caller's: 'A'/'B' are normalized
// across the swap, 1/2 are the raw slot (see docs/architecture.md). The faction rides in parentheses where the
// layer is known, since a slot name alone does not say who the reader is looking at. `isCurrent` qualifies it as
// the faction of the match in progress, which a surface spanning several matches has to say out loud.
//
// The rich surface tags the two pieces that name the team, the slot and the faction, leaving the parenthetical
// glue between them untagged. Which words those are is the message's; what a caller does with them is not. The
// slot rides in an arg called `slot` because a tag and an arg of the same name would collide in ICU's namespace.

export const teamName = def((team: 'A' | 'B' | 1 | 2, faction?: string | null, isCurrent?: boolean) => {
	const args = { slot: String(team), faction, hasFaction: faction ? 'yes' : 'no', isCurrent: isCurrent ? 'yes' : 'no' }
	return {
		text: t(
			'{slot, select, A {Team A} B {Team B} 1 {Team 1} other {Team 2}}{hasFaction, select, yes {({isCurrent, select, yes {current } other {}}{faction})} other {}}',
			args,
		),
		richText: rt(
			'<team>{slot, select, A {Team A} B {Team B} 1 {Team 1} other {Team 2}}</team>{hasFaction, select, yes {({isCurrent, select, yes {current } other {}}<team>{faction}</team>)} other {}}',
			args,
		),
	}
})

export const team1 = def('Team 1')

export const team2 = def('Team 2')

export const team1Vehicles = def('Team 1 Vehicles')

export const team2Vehicles = def('Team 2 Vehicles')

export const startingTickets = def('Starting Tickets:')

// the faction line under a team heading: `<team> (<role>) - <faction> (<unit type>)`
export const teamFactionLine = def((team: string, role: string | undefined, faction: string, unitType: string) => ({
	richText: rt('<strong>{team}{hasRole, select, yes { ({role})} other {}}</strong> - {faction} ({unitType})', {
		team,
		role,
		hasRole: role ? 'yes' : 'no',
		faction,
		unitType,
	}),
}))

// the same heading in the score grid, where the unit is named rather than typed
export const teamScoreHeading = def((team: string, role: string | undefined, faction: string, unit: string) => ({
	richText: rt('<strong>{team}{hasRole, select, yes { ({role})} other {}}</strong> - {faction} {unit}', {
		team,
		role,
		hasRole: role ? 'yes' : 'no',
		faction,
		unit,
	}),
}))

export const unknownUnit = def('Unknown')

export const vehicleDelayRespawn = def('Delay/Respawn (in minutes)')

export const vehicleType = def('Vehicle Type')

export const vehicleName = def('Name')

// -------- the score bars --------

export const logarithmicScale = def('(logarithmic scale)')

export const balanceDifferential = def('Balance Differential')

// value carries its own sign where the bar has one cutoff per side
export const poolCutoff = def('Pool Cutoff ({value})', (value: string) => ({ value }))

// The number is coloured by which team the difference favours, which no single class on the container can
// express, so the caller renders it and the message positions it.
export const scoreDiff = def((value: React.ReactNode) => ({
	richText: rt('(diff: {value})', { value }),
}))

export const scoreUnavailable = def('N/A')

// -------- the layer config summary --------

export const commanderLabel = def('Commander:')

export const commanderDisabled = def('Disabled')

export const lightingLabel = def('Lighting:')

// -------- unparsed layers --------

export const unparsedLayer = def('This layer is unknown and was not able to be fully parsed:')

export const unknownLayer = def('Layer Was parsed, but is unknown')

// between the two teams in a short layer name
export const versus = def('vs')

export const setByLabel = def('Set By')

// -------- the layer set dialogs --------

export const multiLayerPlaceholder = def('Enter one layer per line (e.g. Narva_RAAS_v1 RGF USMC or a layer id)')

export const addLayers = def('{count, plural, =0 {Add Layers} one {Add # Layer} other {Add # Layers}}', (count: number) => ({ count }))

export const editLayerTitle = def('Edit Layer')

export const submit = def('Submit')
