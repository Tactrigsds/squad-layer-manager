import LayerComponents from '$root/assets/layer-components.json'
import * as L from '@/models/layer'

export function toShortUnit(unit: string | null) {
	if (unit === null) return ''
	// @ts-expect-error idc
	return LayerComponents.unitShortNames[unit] ?? unit
}

export const NULL_DISPLAY = ' <empty> '
export const MISSING_DISPLAY = ' - '

export function displayUnvalidatedLayer(_possibleUnknown: L.UnvalidatedLayer | L.LayerId, you?: 1 | 2) {
	const possibleUnknown = typeof _possibleUnknown === 'string' ? L.fromPossibleRawId(_possibleUnknown) : _possibleUnknown
	if (L.isKnownLayer(possibleUnknown)) {
		return toShortLayerName(possibleUnknown, you)
	}

	return possibleUnknown.id.slice('RAW:'.length)
}

export function toFormattedNormalizedTeam(team: 'A' | 'B' | 'teamA' | 'teamB') {
	if (team.startsWith('T')) team = team.slice(team.length - 1) as ('A' | 'B')
	if (team === 'A') return 'Team A'
	return 'Team B'
}

export function toFullLayerName(layer: L.KnownLayer, you?: 1 | 2) {
	const subfaction1 = layer.Unit_1 ? ` ${layer.Unit_1}` : ''
	const subfaction2 = layer.Unit_2 ? ` ${layer.Unit_2}` : ''
	const youMarker1 = you === 1 ? ' (you)' : ''
	const youMarker2 = you === 2 ? ' (you)' : ''
	return `${layer.Layer} - ${layer.Faction_1}${subfaction1}${youMarker1} vs ${layer.Faction_2}${subfaction2}${youMarker2}`
}

export function toFullLayerNameFromId(id: string, you?: 1 | 2) {
	const layer = L.fromPossibleRawId(id)
	if (L.isKnownLayer(layer)) return toFullLayerName(layer, you)
	return layer.id.slice('RAW:'.length)
}

export function toShortLayerName(layer: L.KnownLayer, you?: 1 | 2) {
	const subfaction1 = toShortUnit(layer.Unit_1)
	const subFaction2 = toShortUnit(layer.Unit_2)
	let txt = `${layer.Layer}`
	txt += `- ${layer.Faction_1}${subfaction1 ? ` ${subfaction1}` : ''}${you === 1 ? ' (you)' : ''}`.trim()
	txt += ' vs '
	txt += `${layer.Faction_2}${subFaction2 ? ` ${subFaction2}` : ''}${you === 2 ? ' (you)' : ''}`.trim()
	return txt
}

export function toShortTeamsDisplay(layer: Partial<L.KnownLayer>, you?: 1 | 2) {
	const subfaction1 = toShortUnit(layer.Unit_1 ?? null)
	const subFaction2 = toShortUnit(layer.Unit_2 ?? null)
	let txt = `${layer.Faction_1}${subfaction1 ? ` ${subfaction1}` : ''}${you === 1 ? ' (you)' : ''}`.trim()
	txt += ' vs '
	txt += `${layer.Faction_2}${subFaction2 ? ` ${subFaction2}` : ''}${you === 2 ? ' (you)' : ''}`.trim()
	return txt
}

export function toShortLayerNameFromId(id: string, you?: 1 | 2) {
	const res = L.fromPossibleRawId(id)
	return displayUnvalidatedLayer(res, you)
}
