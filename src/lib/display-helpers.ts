import LayerComponents from '$root/assets/layer-components.json'
import * as M from '@/models'

export function toShortUnit(unit: string | null) {
	if (unit === null) return ''
	// @ts-expect-error idc
	return LayerComponents.unitShortNames[unit] ?? unit
}

export const NULL_DISPLAY = ' <empty> '
export const MISSING_DISPLAY = ' - '

export function displayUnvalidatedLayer(_possibleUnknown: M.UnvalidatedMiniLayer | M.LayerId, you?: 1 | 2) {
	const possibleUnknown = typeof _possibleUnknown === 'string' ? M.getUnvalidatedLayerFromId(_possibleUnknown) : _possibleUnknown
	switch (possibleUnknown.code) {
		case 'parsed':
			return toShortLayerName(possibleUnknown.layer, you)
		case 'raw':
			return possibleUnknown.id.slice('RAW:'.length)
	}
}

export function toFullLayerName(layer: M.MiniLayer, you?: 1 | 2) {
	const subfaction1 = layer.Unit_1 ? ` ${layer.Unit_1}` : ''
	const subfaction2 = layer.Unit_2 ? ` ${layer.Unit_2}` : ''
	const youMarker1 = you === 1 ? ' (you)' : ''
	const youMarker2 = you === 2 ? ' (you)' : ''
	return `${layer.Layer} - ${layer.Faction_1}${subfaction1}${youMarker1} vs ${layer.Faction_2}${subfaction2}${youMarker2}`
}

export function toFullLayerNameFromId(id: string, you?: 1 | 2) {
	const res = M.getUnvalidatedLayerFromId(id)
	if (res.code === 'parsed') return toFullLayerName(res.layer, you)
	return res.id.slice('RAW:'.length)
}

export function toShortLayerName(layer: M.MiniLayer, you?: 1 | 2) {
	const subfaction1 = toShortUnit(layer.Unit_1)
	const subFaction2 = toShortUnit(layer.Unit_2)
	let txt = `${layer.Layer}`
	txt += `- ${layer.Faction_1}${subfaction1 ? ` ${subfaction1}` : ''}${you === 1 ? ' (you)' : ''}`.trim()
	txt += ' vs '
	txt += `${layer.Faction_2}${subFaction2 ? ` ${subFaction2}` : ''}${you === 2 ? ' (you)' : ''}`.trim()
	return txt
}

export function toShortTeamsDisplay(layer: Partial<M.MiniLayer>, you?: 1 | 2) {
	const subfaction1 = toShortUnit(layer.Unit_1 ?? null)
	const subFaction2 = toShortUnit(layer.Unit_2 ?? null)
	let txt = `${layer.Faction_1}${subfaction1 ? ` ${subfaction1}` : ''}${you === 1 ? ' (you)' : ''}`.trim()
	txt += ' vs '
	txt += `${layer.Faction_2}${subFaction2 ? ` ${subFaction2}` : ''}${you === 2 ? ' (you)' : ''}`.trim()
	return txt
}

export function toShortLayerNameFromId(id: string, you?: 1 | 2) {
	const res = M.getUnvalidatedLayerFromId(id)
	return displayUnvalidatedLayer(res, you)
}
