import { fromJsonCompatible, OneToManyMap, toJsonCompatible } from '@/lib/one-to-many-map'
export type MapConfigLayer = { Layer: string; Map: string; Size: string; Gamemode: string; LayerVersion: string }

type LayerFactionAvailabilityEntry = {
	Layer: string
	Faction: string
	Unit: string
	allowedTeams: (1 | 2)[]
	isDefaultUnit: boolean
}

export type BaseLayerComponents = {
	maps: Set<string>
	alliances: Set<string>
	gamemodes: Set<string>
	layers: Set<string>
	versions: Set<string>
	size: Set<string>
	mapLayers: MapConfigLayer[]
	factions: Set<string>
	units: Set<string>
	allianceToFaction: OneToManyMap<string, string>
	factionToAlliance: Map<string, string>
	factionToUnit: OneToManyMap<string, string>
	factionUnitToUnitFullName: Map<string, string>
	layerFactionAvailability: LayerFactionAvailabilityEntry[]
}

export type BaseLayerComponentsJson = {
	maps: string[]
	alliances: string[]
	gamemodes: string[]
	layers: string[]
	versions: string[]
	size: string[]
	mapLayers: MapConfigLayer[]
	factions: string[]
	units: string[]
	allianceToFaction: Record<string, string[]>
	factionToAlliance: Record<string, string>
	factionToUnit: Record<string, string[]>
	factionUnitToUnitFullName: Record<string, string>
	layerFactionAvailability: LayerFactionAvailabilityEntry[]
}

export type LayerComponents = BaseLayerComponents & {
	mapAbbreviations: Record<string, string>
	unitAbbreviations: Record<string, string>
	unitShortNames: Record<string, string>
	gamemodeAbbreviations: Record<string, string>
}

export type LayerComponentsJson = BaseLayerComponentsJson & {
	mapAbbreviations: Record<string, string>
	unitAbbreviations: Record<string, string>
	unitShortNames: Record<string, string>
	gamemodeAbbreviations: Record<string, string>
}

export function toLayerComponentsJson(components: LayerComponents): LayerComponentsJson {
	return {
		...components,
		size: Array.from(components.size),
		maps: Array.from(components.maps),
		layers: Array.from(components.layers),
		versions: Array.from(components.versions),
		gamemodes: Array.from(components.gamemodes),
		alliances: Array.from(components.alliances),
		factions: Array.from(components.factions),
		units: Array.from(components.units),
		allianceToFaction: toJsonCompatible(components.allianceToFaction),
		factionToAlliance: Object.fromEntries(components.factionToAlliance),
		factionToUnit: toJsonCompatible(components.factionToUnit),
		factionUnitToUnitFullName: Object.fromEntries(components.factionUnitToUnitFullName),
		mapAbbreviations: components.mapAbbreviations,
		unitAbbreviations: components.unitAbbreviations,
		unitShortNames: components.unitShortNames,
		gamemodeAbbreviations: components.gamemodeAbbreviations,
	}
}

export function toLayerComponents(json: LayerComponentsJson): LayerComponents {
	return {
		...json,
		maps: new Set(json.maps),
		layers: new Set(json.layers),
		size: new Set(json.size),
		versions: new Set(json.versions),
		gamemodes: new Set(json.gamemodes),
		alliances: new Set(json.alliances),
		factions: new Set(json.factions),
		units: new Set(json.units),
		allianceToFaction: fromJsonCompatible(json.allianceToFaction),
		factionToAlliance: new Map(Object.entries(json.factionToAlliance)),
		factionToUnit: fromJsonCompatible(json.factionToUnit),
		factionUnitToUnitFullName: new Map(Object.entries(json.factionUnitToUnitFullName)),
		mapAbbreviations: json.mapAbbreviations,
		unitAbbreviations: json.unitAbbreviations,
		unitShortNames: json.unitShortNames,
		gamemodeAbbreviations: json.gamemodeAbbreviations,
	}
}

export const MAP_ABBREVIATIONS = {
	AlBasrah: 'AB',
	Anvil: 'AN',
	Belaya: 'BL',
	BlackCoast: 'BC',
	Chora: 'CH',
	Fallujah: 'FL',
	FoolsRoad: 'FR',
	GooseBay: 'GB',
	Gorodok: 'GD',
	Harju: 'HJ',
	Kamdesh: 'KD',
	Kohat: 'KH',
	Kokan: 'KK',
	Lashkar: 'LK',
	Logar: 'LG',
	Manicouagan: 'MN',
	Mestia: 'MS',
	Mutaha: 'MT',
	Narva: 'NV',
	PacificProvingGrounds: 'PPG',
	Sanxian: 'SX',
	Skorpo: 'SK',
	Sumari: 'SM',
	Tallil: 'TL',
	Yehorivka: 'YH',
	JensensRange: 'JR',
} as Record<string, string>

export const UNIT_ABBREVIATIONS = {
	AirAssault: 'AA',
	Armored: 'AR',
	CombinedArms: 'CA',
	LightInfantry: 'LI',
	Mechanized: 'MZ',
	Motorized: 'MT',
	Support: 'SP',
	AmphibiousAssault: 'AM',
}

export const GAMEMODE_ABBREVIATIONS = {
	RAAS: 'RAAS',
	FRAAS: 'FRAAS',
	AAS: 'AAS',
	TC: 'TC',
	Invasion: 'INV',
	Skirmish: 'SK',
	Destruction: 'DES',
	Insurgency: 'INS',
	'Track Attack': 'TA',
	Seed: 'SD',
	Training: 'TR',
	Tanks: 'TN',
}

export const UNIT_SHORT_NAMES = {
	CombinedArms: 'Combined',
	Armored: 'Armored',
	LightInfantry: 'Light',
	Mechanized: 'Mech',
	Motorized: 'Motor',
	Support: 'Sup',
	AirAssault: 'Air',
	AmphibiousAssault: 'Amphib',
}

export function buildFullLayerComponents(
	components: BaseLayerComponents,
	skipValidate = false,
) {
	if (!skipValidate) {
		for (const mapLayer of components.mapLayers) {
			if (!(mapLayer.Map in MAP_ABBREVIATIONS)) {
				throw new Error(`map ${mapLayer.Map} doesn't have an abbreviation`)
			}
		}
		for (const subfaction of components.units) {
			if (subfaction === null) continue
			if (!(subfaction in UNIT_ABBREVIATIONS)) {
				throw new Error(`subfaction ${subfaction} doesn't have an abbreviation`)
			}
			if (!(subfaction in UNIT_SHORT_NAMES)) {
				throw new Error(`subfaction ${subfaction} doesn't have a short name`)
			}
		}
	}

	const layerComponents: LayerComponents = {
		...components,
		gamemodeAbbreviations: GAMEMODE_ABBREVIATIONS,
		unitAbbreviations: UNIT_ABBREVIATIONS,
		unitShortNames: UNIT_SHORT_NAMES,
		mapAbbreviations: MAP_ABBREVIATIONS,
	}

	return layerComponents
}
