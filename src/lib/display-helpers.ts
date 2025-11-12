import * as Typo from '@/lib/typography'
import * as L from '@/models/layer'
import * as LQY from '@/models/layer-queries.models'
import { z } from 'zod'

export function toShortUnit(unit: string | null) {
	if (unit === null) return ''
	return L.StaticLayerComponents.unitShortNames[unit] ?? unit
}

export const NULL_DISPLAY = ' - '
export const MISSING_DISPLAY = ' - '

export const LAYER_DISPLAY_PROP = z.enum(['map', 'gamemode', 'layer', 'factions', 'units'])
export type LayerDisplayProp = z.infer<typeof LAYER_DISPLAY_PROP>

export function displayLayer(_possibleUnknown: L.UnvalidatedLayer | L.LayerId, you?: 1 | 2, displayProps?: LayerDisplayProp[]) {
	const possibleUnknown = typeof _possibleUnknown === 'string' ? L.fromPossibleRawId(_possibleUnknown) : _possibleUnknown
	if (L.isKnownLayer(possibleUnknown)) {
		return toShortLayerName(possibleUnknown, you, displayProps)
	}

	return possibleUnknown.id.slice('RAW:'.length)
}

export type LayerDisplayPropsStatuses = Record<LayerDisplayProp, boolean>

export function toDisplayPropStatuses(displayProps: LayerDisplayProp[]): LayerDisplayPropsStatuses {
	const statuses = {} as LayerDisplayPropsStatuses
	for (const prop of LAYER_DISPLAY_PROP.options) {
		statuses[prop] = displayProps.includes(prop)
	}
	return statuses
}

export function fromDisplayPropStatuses(statuses: LayerDisplayPropsStatuses): LayerDisplayProp[] {
	const displayProps: LayerDisplayProp[] = []
	for (const prop of LAYER_DISPLAY_PROP.options) {
		if (statuses[prop]) {
			displayProps.push(prop)
		}
	}
	return displayProps
}

export function toFormattedNormalizedTeam(team: 'A' | 'B' | 'teamA' | 'teamB') {
	if (team.startsWith('t')) team = team.slice(team.length - 1) as ('A' | 'B')
	if (team === 'A') return 'Team A'
	return 'Team B'
}

export function toFullLayerName(layer: L.KnownLayer, you?: 1 | 2, displayProps?: LayerDisplayProp[]) {
	// If no display props specified, show everything
	if (!displayProps || displayProps.length === 0) {
		const subfaction1 = layer.Unit_1 ? ` ${layer.Unit_1}` : ''
		const subfaction2 = layer.Unit_2 ? ` ${layer.Unit_2}` : ''
		const youMarker1 = you === 1 ? ' (you)' : ''
		const youMarker2 = you === 2 ? ' (you)' : ''
		return `${layer.Layer} - ${layer.Faction_1}${subfaction1}${youMarker1} vs ${layer.Faction_2}${subfaction2}${youMarker2}`
	}

	const showLayer = displayProps.includes('layer') || displayProps.includes('map') || displayProps.includes('gamemode')
	const showFactions = displayProps.includes('factions')
	const showUnits = displayProps.includes('units')

	let parts: string[] = []

	if (showLayer) {
		parts.push(layer.Layer)
	}

	let teamsDisplay = ''
	if (showFactions || showUnits) {
		const youMarker1 = you === 1 ? ' (you)' : ''
		const youMarker2 = you === 2 ? ' (you)' : ''

		if (showFactions && showUnits) {
			// Show both factions and units
			const subfaction1 = layer.Unit_1 ? ` ${layer.Unit_1}` : ''
			const subfaction2 = layer.Unit_2 ? ` ${layer.Unit_2}` : ''
			teamsDisplay = `${layer.Faction_1}${subfaction1}${youMarker1} vs ${layer.Faction_2}${subfaction2}${youMarker2}`
		} else if (showFactions) {
			// Show only factions
			teamsDisplay = `${layer.Faction_1}${youMarker1} vs ${layer.Faction_2}${youMarker2}`
		} else if (showUnits) {
			// Show only units without factions
			const unit1 = layer.Unit_1 || ''
			const unit2 = layer.Unit_2 || ''
			if (unit1 || unit2) {
				teamsDisplay = `${unit1}${youMarker1} vs ${unit2}${youMarker2}`.trim()
			}
		}

		if (teamsDisplay) {
			parts.push(teamsDisplay)
		}
	}

	return parts.join(' - ')
}

export function toFullLayerNameFromId(id: string, you?: 1 | 2, displayProps?: LayerDisplayProp[]) {
	const layer = L.toLayer(id)
	if (L.isKnownLayer(layer)) return toFullLayerName(layer, you, displayProps)
	return layer.id.slice('RAW:'.length)
}

export function toShortLayerName(layer: L.KnownLayer, you?: 1 | 2, displayProps?: LayerDisplayProp[]) {
	// If no display props specified, show everything
	if (!displayProps || displayProps.length === 0) {
		const subfaction1 = toShortUnit(layer.Unit_1)
		const subFaction2 = toShortUnit(layer.Unit_2)
		let txt = `${layer.Layer}`
		txt += ` - ${layer.Faction_1}${subfaction1 ? ` ${subfaction1}` : ''}${you === 1 ? ' (you)' : ''}`.trimEnd()
		txt += ' vs '
		txt += `${layer.Faction_2}${subFaction2 ? ` ${subFaction2}` : ''}${you === 2 ? ' (you)' : ''}`.trim()
		return txt
	}

	const showMap = displayProps.includes('map')
	const showGamemode = displayProps.includes('gamemode')
	const showLayer = displayProps.includes('layer')
	const showFactions = displayProps.includes('factions')
	const showUnits = displayProps.includes('units')

	const parts: string[] = []

	// Handle map/gamemode/layer display
	if (showLayer) {
		// 'layer' shows the full layer string (map + gamemode + version)
		parts.push(layer.Layer)
	} else {
		// Show individual components as requested
		let layerComponents: string[] = []
		if (showMap) {
			layerComponents.push(layer.Map)
		}
		if (showGamemode) {
			layerComponents.push(layer.Gamemode)
		}
		if (layerComponents.length > 0) {
			parts.push(layerComponents.join(' '))
		}
	}

	let teamsDisplay = ''
	if (showFactions || showUnits) {
		const youMarker1 = you === 1 ? ' (you)' : ''
		const youMarker2 = you === 2 ? ' (you)' : ''

		if (showFactions && showUnits) {
			// Show both factions and units
			const subfaction1 = toShortUnit(layer.Unit_1)
			const subFaction2 = toShortUnit(layer.Unit_2)
			let team1 = `${layer.Faction_1}${subfaction1 ? ` ${subfaction1}` : ''}${youMarker1}`.trim()
			let team2 = `${layer.Faction_2}${subFaction2 ? ` ${subFaction2}` : ''}${youMarker2}`.trim()
			teamsDisplay = `${team1} vs ${team2}`
		} else if (showFactions) {
			// Show only factions
			teamsDisplay = `${layer.Faction_1}${youMarker1} vs ${layer.Faction_2}${youMarker2}`.trim()
		} else if (showUnits) {
			// Show only units without factions
			const subfaction1 = toShortUnit(layer.Unit_1)
			const subFaction2 = toShortUnit(layer.Unit_2)
			if (subfaction1 || subFaction2) {
				let unit1 = `${subfaction1}${youMarker1}`.trim()
				let unit2 = `${subFaction2}${youMarker2}`.trim()
				teamsDisplay = `${unit1} vs ${unit2}`.trim()
			}
		}

		if (teamsDisplay) {
			parts.push(teamsDisplay)
		}
	}

	return parts.join(' - ')
}

export function toShortTeamsDisplay(layer: Partial<L.KnownLayer>, you?: 1 | 2, displayProps?: LayerDisplayProp[]) {
	// If no display props specified, show both factions and units
	const showFactions = !displayProps || displayProps.length === 0 || displayProps.includes('factions')
	const showUnits = !displayProps || displayProps.length === 0 || displayProps.includes('units')

	if (!showFactions && !showUnits) {
		return ''
	}

	const youMarker1 = you === 1 ? ' (you)' : ''
	const youMarker2 = you === 2 ? ' (you)' : ''

	if (showFactions && showUnits) {
		// Show both factions and units
		const subfaction1 = toShortUnit(layer.Unit_1 ?? null)
		const subFaction2 = toShortUnit(layer.Unit_2 ?? null)
		let txt = `${layer.Faction_1}${subfaction1 ? ` ${subfaction1}` : ''}${youMarker1}`.trim()
		txt += ' vs '
		txt += `${layer.Faction_2}${subFaction2 ? ` ${subFaction2}` : ''}${youMarker2}`.trim()
		return txt
	} else if (showFactions) {
		// Show only factions
		let txt = `${layer.Faction_1}${youMarker1}`.trim()
		txt += ' vs '
		txt += `${layer.Faction_2}${youMarker2}`.trim()
		return txt
	} else if (showUnits) {
		// Show only units
		const subfaction1 = toShortUnit(layer.Unit_1 ?? null)
		const subFaction2 = toShortUnit(layer.Unit_2 ?? null)
		let txt = `${subfaction1}${youMarker1}`.trim()
		txt += ' vs '
		txt += `${subFaction2}${youMarker2}`.trim()
		return txt.trim()
	}

	return ''
}

export function toShortLayerNameFromId(id: string, you?: 1 | 2, displayProps?: LayerDisplayProp[]) {
	const res = L.fromPossibleRawId(id)
	return displayLayer(res, you, displayProps)
}

export function toExtraShortLayerNameFromId(id: string, you?: 1 | 2, displayProps?: LayerDisplayProp[]) {
	return toShortLayerNameFromId(id, you, displayProps).replace(' - ', ' ')
}

export function getColumnExtraStyles(
	column: keyof L.KnownLayer,
	teamParity: number | undefined,
	_displayLayersNormalized: boolean,
	descriptors?: LQY.MatchDescriptor[],
) {
	if (!descriptors) return
	const properties = LQY.resolveRepeatedLayerProperties(descriptors, teamParity ?? 0)
	if (properties.has(column)) {
		return Typo.ConstraintViolationDescriptor
	}
}

export function getAllExtraStyles(
	_layer: L.UnvalidatedLayer | L.LayerId,
	teamParity: number | undefined,
	displayLayersNormalized: boolean,
	descriptors?: LQY.MatchDescriptor[],
) {
	const layer = L.toLayer(_layer)
	const extraStyles: Record<string, string | undefined> = {}
	if (!descriptors) return extraStyles
	for (const key of Object.keys(layer)) {
		extraStyles[key] = getColumnExtraStyles(key as keyof L.UnvalidatedLayer, teamParity, displayLayersNormalized, descriptors)
	}
	return extraStyles
}
