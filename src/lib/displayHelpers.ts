import * as M from '@/models'

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
	return LEVEL_SHORT_NAMES[level]
}

const SUBFACTION_SHORT_NAMES = {
	CombinedArms: 'Combined',
	Armored: 'Armored',
	LightInfantry: 'Light',
	Mechanized: 'Mech',
	Motorized: 'Motor',
	Support: 'Sup',
	AirAssault: 'Air',
} satisfies Record<M.Subfaction, string>

export function toShortSubfaction(unitType: M.Subfaction | null) {
	if (unitType === null) return ''
	return SUBFACTION_SHORT_NAMES[unitType]
}

export const NULL_DISPLAY = ' - '

export function toShortLayerName(layer: M.MiniLayer) {
	const subfaction1 = toShortSubfaction(layer.SubFac_1)
	const subFaction2 = toShortSubfaction(layer.SubFac_2)
	const layerVersion = layer.LayerVersion ? ` ${layer.LayerVersion} ` : ''
	let txt = `${LEVEL_SHORT_NAMES[layer.Level]} `
	txt += `${layer.Gamemode}${layerVersion}`
	txt += `- ${layer.Faction_1} ${subfaction1}`.trim()
	txt += ' vs '
	txt += `${layer.Faction_2} ${subFaction2}`.trim()
	return txt
}
