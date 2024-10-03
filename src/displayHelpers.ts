import * as M from './models'

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

export function toShortSubfaction(unitType: M.Subfaction) {
	return SUBFACTION_SHORT_NAMES[unitType]
}

export function toShortLayerName(layer: M.MiniLayer) {
	return `${LEVEL_SHORT_NAMES[layer.Level]} ${layer.Gamemode} ${layer.LayerVersion} - ${layer.Faction_1} ${SUBFACTION_SHORT_NAMES[layer.SubFac_1]} vs ${layer.Faction_2} ${SUBFACTION_SHORT_NAMES[layer.SubFac_2]}`
}
