// this file is mostly here to prevent cyclic dependencies
export const SUBFACTIONS = [
	'CombinedArms',
	'Armored',
	'LightInfantry',
	'Mechanized',
	'Motorized',
	'Support',
	'AirAssault',
	'AmphibiousAssault',
] as const
export type Subfaction = (typeof SUBFACTIONS)[number]
