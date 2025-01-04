import LayerComponents from '$root/assets/layer-components.json'
import * as M from '@/models'

// TODO use layer-components.json instead
export const LEVEL_SHORT_NAMES: Record<M.Layer['Level'], string> = {
	AlBasrah: 'Basrah',
	Anvil: 'Anvil',
	Belaya: 'Belaya',
	BlackCoast: 'Coast',
	Chora: 'Chora',
	Fallujah: 'Fallu',
	FoolsRoad: 'Fools',
	GooseBay: 'Goose',
	Gorodok: 'Goro',
	Harju: 'Harju',
	Kamdesh: 'Kamdesh',
	Kohat: 'Kohat',
	Kokan: 'Kokan',
	Lashkar: 'Lashkar',
	Logar: 'Logar',
	Manicouagan: 'Manic',
	Mestia: 'Mestia',
	Mutaha: 'Muta',
	Narva: 'Narva',
	PacificProvingGrounds: 'PPG',
	Sanxian: 'Sanxian',
	Skorpo: 'Skorpo',
	Sumari: 'Sumari',
	Tallil: 'Tallil',
	Yehorivka: 'Yeho',
	JensensRange: 'Jensens',
}

export function toShortLevel(level: M.Layer['Level']) {
	return LayerComponents.levelShortNames[level as keyof typeof LayerComponents.levelShortNames]
}

export function toShortSubfaction(unitType: M.Subfaction | null) {
	if (unitType === null) return ''
	return LayerComponents.subfactionShortNames[unitType]
}

export const NULL_DISPLAY = ' <empty> '
export const MISSING_DISPLAY = ' - '

export function displayPossibleUnknownLayer(possibleUnknown: M.PossibleUnknownMiniLayer) {
	switch (possibleUnknown.code) {
		case 'known':
			return toShortLayerName(possibleUnknown.layer)
		case 'unknown':
			return `${possibleUnknown.layerString} ${possibleUnknown.factionString}`
	}
}

export function toFullLayerName(layer: M.MiniLayer) {
	const subfaction1 = layer.SubFac_1 ? ` ${layer.SubFac_1}` : ''
	const subfaction2 = layer.SubFac_2 ? ` ${layer.SubFac_2}` : ''
	const layerVersion = layer.LayerVersion ? ` ${layer.LayerVersion} ` : ''

	return `${layer.Level} ${layer.Gamemode}${layerVersion} - ${layer.Faction_1}${subfaction1} vs ${layer.Faction_2}${subfaction2}`
}

export function toFullLayerNameFromId(id: string) {
	const layer = M.getMiniLayerFromId(id)
	return toFullLayerName(layer)
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
	const layer = M.getMiniLayerFromId(id)
	return toShortLayerName(layer)
}
