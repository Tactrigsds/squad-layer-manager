import LayerComponents from '$root/assets/layer-components.json'
import * as M from '@/models'

// TODO use layer-components.json instead
export const LEVEL_SHORT_NAMES: Record<M.Layer['Level'], string> = LayerComponents.levelShortNames

export function toShortLevel(level: M.Layer['Level']) {
	return LayerComponents.levelShortNames[level as keyof typeof LayerComponents.levelShortNames]
}

export function toShortSubfaction(subfaction: string | null) {
	if (subfaction === null) return ''
	// @ts-expect-error idc
	return LayerComponents.subfactionShortNames[subfaction] ?? subfaction
}

export const NULL_DISPLAY = ' <empty> '
export const MISSING_DISPLAY = ' - '

export function displayUnvalidatedLayer(possibleUnknown: M.UnvalidatedMiniLayer) {
	switch (possibleUnknown.code) {
		case 'parsed':
			return toShortLayerName(possibleUnknown.layer)
		case 'raw':
			return possibleUnknown.id.slice('RAW:'.length)
	}
}

export function toFullLayerName(layer: M.MiniLayer) {
	const subfaction1 = layer.SubFac_1 ? ` ${layer.SubFac_1}` : ''
	const subfaction2 = layer.SubFac_2 ? ` ${layer.SubFac_2}` : ''
	const layerVersion = layer.LayerVersion ? ` ${layer.LayerVersion} ` : ''

	return `${layer.Level} ${layer.Gamemode}${layerVersion} - ${layer.Faction_1}${subfaction1} vs ${layer.Faction_2}${subfaction2}`
}

export function toFullLayerNameFromId(id: string) {
	const res = M.getUnvalidatedLayerFromId(id)
	if (res.code === 'parsed') return toFullLayerName(res.layer)
	return res.id.slice('RAW:'.length)
}

export function toShortLayerName(layer: M.MiniLayer) {
	const subfaction1 = toShortSubfaction(layer.SubFac_1)
	const subFaction2 = toShortSubfaction(layer.SubFac_2)
	const layerVersion = layer.LayerVersion ? ` ${layer.LayerVersion} ` : ''
	let txt = `${LEVEL_SHORT_NAMES[layer.Level]} `
	txt += `${layer.Gamemode}${layerVersion}`
	txt += ' '
	txt += `- ${layer.Faction_1}${subfaction1 ? ` ${subfaction1}` : ''}`.trim()
	txt += ' vs '
	txt += `${layer.Faction_2}${subFaction2 ? ` ${subFaction2}` : ''}`.trim()
	return txt
}
export function toShortLayerNameFromId(id: string) {
	const res = M.getUnvalidatedLayerFromId(id)
	return displayUnvalidatedLayer(res)
}
