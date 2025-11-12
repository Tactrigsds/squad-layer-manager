import _StaticFactionunitConfigs from '$root/assets/factionunit-configs.json'
import _StaticLayerComponents from '$root/assets/layer-components.json'
import * as Obj from '@/lib/object'
import { assertNever } from '@/lib/type-guards'
import * as LC from '@/models/layer-columns'
import * as SLL from '@/models/squad-layer-list.models'
import { KnownPublicKeys } from 'ssh2'
import * as z from 'zod'
import { getAllLayerIds } from './layer-queries.models'

export let StaticLayerComponents = _StaticLayerComponents as unknown as LC.LayerComponentsJson

// lock static layer components so we can verify that we're not using them while preprocessing
export function lockStaticLayerComponents() {
	Object.keys(StaticLayerComponents).forEach(key => {
		Object.defineProperty(StaticLayerComponents, key as keyof typeof StaticLayerComponents, {
			get() {
				throw new Error(`Static layer component '${key}' was accessed after being cleared`)
			},
			configurable: true,
		})
	})
}

export function setStaticLayerComponents(components: LC.LayerComponentsJson) {
	StaticLayerComponents = components
}

export const StaticFactionunitConfigs = _StaticFactionunitConfigs as unknown as FactionUnitConfigMapping

// lock Factionunit Configs so we can verify that they aren't being used while preprocessing
export function lockStaticFactionUnitConfigs() {
	Object.keys(StaticFactionunitConfigs).forEach(key => {
		Object.defineProperty(StaticFactionunitConfigs, key as keyof typeof StaticFactionunitConfigs, {
			get() {
				throw new Error(`Static factionunit config '${key}' was accessed after being cleared`)
			},
			configurable: true,
		})
	})
}

export const ASYMM_GAMEMODES = ['Invasion', 'Destruction', 'Insurgency']

export type KnownLayer = {
	id: string
	Map: string
	Size: string
	Layer: string
	Gamemode: string
	LayerVersion: string | null
	Faction_1: string
	Faction_2: string
	Unit_1: string
	Unit_2: string
	Alliance_1: string
	Alliance_2: string
}

export type LayerColumnKey = keyof KnownLayer

export type LayerIdArgs = {
	Map: string
	Gamemode: string
	LayerVersion: string | null
	Faction_1: string
	Unit_1?: string
	Faction_2: string
	Unit_2?: string
}

// we almost always can extract a Layer string
export type RawLayer = UnvalidatedLayer & {
	id: `RAW:${string}`
}

export const LayerIdSchema = z.string().min(1).max(255)

export function createLayerIdSchema(components = StaticLayerComponents) {
	return LayerIdSchema.refine(id => {
		if (id.startsWith('RAW:')) return true
		const res = parseLayerId(id, components)
		if (res.code !== 'ok') {
			return false
		}
		return res.code === 'ok'
	}, {
		message: 'Is valid layer id',
	})
}

export type LayerId = z.infer<typeof LayerIdSchema>

export type UnvalidatedLayer = Partial<KnownLayer> & { Layer: string; id: string }

const knownLayerIdRegex =
	/^(?<mapPart>[A-Za-z]+)-(?<gamemodePart>[A-Za-z]+)(?:-(?<versionPart>[A-Z0-9]+))?:(?<faction1>[A-Za-z]+)(?:-(?<unit1Abbr>[A-Za-z]+))?:(?<faction2>[A-Za-z]+)(?:-(?<unit2Abbr>[A-Za-z]+))?$/

// these two schemas should probably be kept internal to this module
const LayerIdArgsSchema = z.object({
	Map: z.string(),
	Gamemode: z.string(),
	LayerVersion: z.string().nullable(),
	Faction_1: z.string(),
	Faction_2: z.string(),
	Unit_1: z.string(),
	Unit_2: z.string(),
})

const KnownLayerSchema = z.object({
	// known layers can now have raw layer ids
	id: z.string(),
	...LayerIdArgsSchema.shape,
	Alliance_1: z.string(),
	Alliance_2: z.string(),
})

// expects and backwards compat mappings to be applied already
export function isKnownLayer(layer: UnvalidatedLayer | LayerId, components = StaticLayerComponents): layer is KnownLayer {
	layer = toLayer(layer, components)
	if (!KnownLayerSchema.safeParse(layer).success) return false
	const mapping = {
		Map: components.maps,
		Size: components.size,
		Layer: components.layers,
		Gamemode: components.gamemodes,
		LayerVersion: components.versions,
		Faction_1: components.factions,
		Faction_2: components.factions,
		Unit_1: components.units,
		Unit_2: components.units,
		Alliance_1: components.alliances,
		Alliance_2: components.alliances,
	}

	for (const [key] of Obj.objEntries(mapping)) {
		// @ts-expect-error idgaf
		if (!mapping[key].includes(layer[key])) {
			return false
		}
	}
	return true
}

export function areLayerIdArgsValid(layer: LayerIdArgs, components = StaticLayerComponents) {
	if (!LayerIdArgsSchema.safeParse(layer).success) {
		return false
	}
	if (!components.mapAbbreviations[layer.Map] && !Object.values(components.mapAbbreviations).includes(layer.Map)) {
		return false
	}

	if (!components.gamemodeAbbreviations[layer.Gamemode] && !Object.values(components.gamemodeAbbreviations).includes(layer.Gamemode)) {
		return false
	}

	if (!components.factions.includes(layer.Faction_1)) {
		return false
	}
	if (!components.factions.includes(layer.Faction_2)) {
		return false
	}
	return true
}

export function getLayerString(details: Pick<KnownLayer, 'Map' | 'Gamemode' | 'LayerVersion' | 'Faction_1' | 'Faction_2'>) {
	if (details.Gamemode === 'Training') {
		return `${details.Map}_${details.Faction_1}-${details.Faction_2}`
	}
	let layer = `${details.Map}_${details.Gamemode}`
	if (details.LayerVersion) layer += `_${details.LayerVersion.toLowerCase()}`
	return layer
}

export function lookupDefaultUnit(layer: string, faction: string, components = StaticLayerComponents) {
	if (!components.layerFactionAvailability[layer]) {
		throw new Error(`Layer '${layer}' is missing in layerFactionAvailability`)
	}
	return components.layerFactionAvailability[layer]!.find(l => {
		return l.isDefaultUnit && l.Faction === faction
	})?.Unit
}

export function getLayerIdTeamString(faction: string, unit: string, components = StaticLayerComponents) {
	const unitAbbr = components.unitAbbreviations[unit]
	return `${faction}-${unitAbbr}`
}

export function getKnownLayerId(layer: LayerIdArgs, components = StaticLayerComponents) {
	if (!areLayerIdArgsValid(layer, components)) {
		return null
	}
	const mapPart = components.mapAbbreviations[layer.Map] ?? layer.Map
	const gamemodePart = components.gamemodeAbbreviations[layer.Gamemode] ?? layer.Gamemode
	let mapLayer = `${mapPart}-${gamemodePart}`
	layer = { ...layer }
	if (layer.LayerVersion) mapLayer += `-${layer.LayerVersion.toUpperCase()}`
	for (const prop of ['1', '2'] as const) {
		const unitProp = `Unit_${prop}` as const
		if (!layer[unitProp]) {
			const factionProp = `Faction_${prop}` as const
			layer[unitProp] = lookupDefaultUnit(getLayerString(layer), layer[factionProp], components)
			if (!layer[unitProp]) {
				return null
			}
		}

		// Validate unit exists
		if (!components.unitAbbreviations[layer[unitProp]!]) {
			return null
		}
	}

	const team1 = getLayerIdTeamString(layer.Faction_1, layer.Unit_1!, components)
	const team2 = getLayerIdTeamString(layer.Faction_2, layer.Unit_2!, components)
	return `${mapLayer}:${team1}:${team2}`
}
export function getKnownLayer(layer: LayerIdArgs, components = StaticLayerComponents): KnownLayer | null {
	const id = getKnownLayerId(layer, components)
	if (id === null) return null

	// TODO kind of wasteful, could implement separate routine based directly on `layer`
	const res = parseLayerId(id, components)
	if (res.code !== 'ok') return null
	return res.layer
}

export function isRawLayer(layer: UnvalidatedLayer | LayerId): layer is RawLayer {
	const id = typeof layer === 'string' ? layer : layer.id
	return id !== undefined && id.startsWith('RAW:')
}
export function isRawLayerId(layerId: LayerId) {
	return layerId.startsWith('RAW:')
}

export function parseLayerId(id: string, components = StaticLayerComponents) {
	const match = knownLayerIdRegex.exec(id)

	if (!match || !match.groups) {
		return { code: 'err:invalid-layer-id' as const, msg: `Invalid layer ID: ${id}` }
	}

	const { mapPart, gamemodePart, versionPart, unit1Abbr, unit2Abbr } = match.groups
	let { faction1, faction2 } = match.groups
	const converted = applyBackwardsCompatMappings({ Faction_1: faction1, Faction_2: faction2 }, components)
	faction1 = converted.Faction_1
	faction2 = converted.Faction_2

	const gamemode = Obj.revLookup(components.gamemodeAbbreviations, gamemodePart) as string | undefined
	const map = Obj.revLookup(components.mapAbbreviations, mapPart) as string | undefined
	const unit1 = Obj.revLookup(components.unitAbbreviations, unit1Abbr) as string | undefined
	const unit2 = Obj.revLookup(components.unitAbbreviations, unit2Abbr) as string | undefined

	const layerVersion = versionPart ? versionPart.toUpperCase() : null
	let layerString: string | undefined
	if (gamemode === 'Training') {
		layerString = `${map}_${faction1}-${faction2}`
		if (!components.layers.includes(layerString)) {
			return {
				code: 'err:unknown-training-layer' as const,
				msg: `Unknown Training layer: ${id}`,
			}
		}
	} else {
		layerString = `${map}_${gamemode}${layerVersion ? `_${layerVersion.toLowerCase()}` : ''}`
	}
	const mapLayer = components.mapLayers.find(l => l.Layer === layerString)

	const layer = {
		id,
		Map: map,
		Layer: layerString,
		Size: mapLayer?.Size,
		Gamemode: gamemode,
		LayerVersion: layerVersion,
		Faction_1: faction1,
		Unit_1: unit1,
		Alliance_1: components.factionToAlliance[faction1],
		Faction_2: faction2,
		Unit_2: unit2,
		Alliance_2: components.factionToAlliance[faction2],
	}

	if (!isKnownLayer(layer, components)) return { code: 'err:unknown-layer' as const, layer }

	return {
		code: 'ok' as const,
		layer,
	}
}

export function swapFactionsInId(id: LayerId) {
	const [layer, faction1, faction2] = id.split(':')
	return `${layer}:${faction2}:${faction1}`
}

export function layersEqual(a: LayerId | UnvalidatedLayer, b: LayerId | UnvalidatedLayer) {
	if (a === b) return true
	if (typeof a === 'string') a = toLayer(a)
	if (typeof b === 'string') b = toLayer(b)
	for (const def of Object.values(LC.BASE_COLUMN_DEFS)) {
		if (def.name === 'id') continue
		if (a[def.name] !== b[def.name]) return false
	}
	return true
}

// try to convert raw layers into known layers where possible
export function normalize<Original extends LayerId | UnvalidatedLayer>(original: Original, components = StaticLayerComponents): Original {
	const layer = toLayer(original, components)

	if (!isRawLayer(layer)) return original
	if (!layer.Map || !layer.Gamemode || !layer.Faction_1 || !layer.Faction_2 || layer.LayerVersion === undefined) return original
	const knownLayer = getKnownLayer(layer as LayerIdArgs, components)
	if (!knownLayer) return original

	return (typeof original === 'string') ? knownLayer.id as Original : knownLayer as Original
}

/**
 * Check if the layers are equal, or at least all parts of the layer partials `toCompare` contains are in targetId
 */
export function areLayersPartialMatch(
	toCompare: LayerId | UnvalidatedLayer,
	target: LayerId | UnvalidatedLayer,
	coalesceFraas: boolean = true,
	components = StaticLayerComponents,
) {
	if (toCompare === target) return true

	const layerRes = typeof toCompare === 'string' ? toLayer(toCompare, components) : toCompare
	const targetLayerRes = typeof target === 'string' ? toLayer(target, components) : target
	if (coalesceFraas) {
		if (layerRes.Layer) layerRes.Layer = layerRes.Layer?.replace('FRAAS', 'RAAS')
		if (targetLayerRes.Layer) targetLayerRes.Layer = targetLayerRes.Layer?.replace('FRAAS', 'RAAS')
		if (layerRes.Gamemode === 'FRAAS') layerRes.Gamemode = 'RAAS'
		if (targetLayerRes.Gamemode === 'FRAAS') targetLayerRes.Gamemode = 'RAAS'
	}

	return Obj.isPartial(layerRes, targetLayerRes, ['id'])
}

export function areLayersCompatible(
	layer1: LayerId | UnvalidatedLayer,
	layer2: LayerId | UnvalidatedLayer,
	coalesceFraas = true,
	components = StaticLayerComponents,
) {
	return areLayersPartialMatch(layer1, layer2, coalesceFraas, components)
		|| areLayersPartialMatch(layer2, layer1, coalesceFraas, components)
}

export function toLayer(unvalidatedLayerOrId: UnvalidatedLayer | LayerId, components = StaticLayerComponents): UnvalidatedLayer {
	if (typeof unvalidatedLayerOrId === 'string') {
		return fromPossibleRawId(unvalidatedLayerOrId, components)
	}
	return unvalidatedLayerOrId
}

export function fromPossibleRawId(id: string, components = StaticLayerComponents): UnvalidatedLayer {
	if (id.startsWith('RAW:')) {
		return parseRawLayerText(id.slice('RAW:'.length), components)!
	}
	const res = parseLayerId(id, components)
	switch (res.code) {
		case 'ok':
			return res.layer
		case 'err:unknown-layer':
			return res.layer
		case 'err:invalid-layer-id':
		case 'err:unknown-training-layer':
			throw new Error(res.msg)
		default:
			assertNever(res)
	}
}

export function getLayerCommand(
	layerOrId: UnvalidatedLayer | LayerId,
	cmdType: 'set-next' | 'change-layer' | 'none',
	components = StaticLayerComponents,
) {
	const layer = typeof layerOrId === 'string' ? fromPossibleRawId(layerOrId, components) : layerOrId
	function getFactionModifier(faction: LayerId, subFac: LayerId | null) {
		return `${faction}${subFac ? `+${subFac}` : ''}`
	}
	let cmd: string
	switch (cmdType) {
		case 'set-next':
			cmd = 'AdminSetNextLayer'
			break
		case 'change-layer':
			cmd = 'AdminChangeLayer'
			break
		case 'none':
			cmd = ''
			break
		default:
			assertNever(cmdType)
	}

	let commandArgs: string
	if (isRawLayer(layer)) commandArgs = layer.id.slice('RAW:'.length)
	else if (layer.Layer.startsWith('JensensRange')) {
		commandArgs = layer.Layer
	} else {
		commandArgs = layer.Layer
		if (layer.Faction_1) {
			commandArgs += ' '
			commandArgs += getFactionModifier(layer.Faction_1, layer.Unit_1 ?? lookupDefaultUnit(layer.Layer, layer.Faction_1, components)!)
		}
		if (layer.Faction_2) {
			commandArgs += ' '
			commandArgs += getFactionModifier(layer.Faction_2, layer.Unit_2 ?? lookupDefaultUnit(layer.Layer, layer.Faction_2, components)!)
		}
	}
	return `${cmd} ${commandArgs.replace('FRAAS', 'RAAS')}`.trim().replace(/\s+/g, ' ')
}

export function parseRawLayerText(rawLayerText: string, components = StaticLayerComponents): UnvalidatedLayer | null {
	let knownLayerRes = parseLayerId(rawLayerText, components)
	if (knownLayerRes.code === 'ok') return knownLayerRes.layer
	rawLayerText = rawLayerText.replace(/^(AdminSetNextLayer|AdminChangeLayer)/, '').trim().replace(/\s+/g, ' ')
	const [layerString, faction1String, faction2String] = rawLayerText.split(' ')
	if (!layerString?.trim()) return null
	const parsedLayer = parseLayerStringSegment(layerString)
	let faction1: ParsedFaction | null = null
	let faction2: ParsedFaction | null = null
	if (parsedLayer?.extraFactions) {
		;[faction1, faction2] = parsedLayer.extraFactions.map((f): ParsedFaction => ({ faction: f, unit: 'CombinedArms' }))
	} else {
		;[faction1, faction2] = parseLayerFactions(layerString, faction1String, faction2String, components)
	}
	if (!parsedLayer || !faction1 || !faction2) {
		return {
			id: 'RAW:' + rawLayerText,
			...applyBackwardsCompatMappings({
				Map: parsedLayer?.Map,
				Layer: layerString,
				Gamemode: parsedLayer?.Gamemode,
				LayerVersion: parsedLayer?.LayerVersion ?? null,
				Faction_1: faction1?.faction,
				Unit_1: faction1?.unit ?? undefined,
				Faction_2: faction2?.faction,
				Unit_2: faction2?.unit ?? undefined,
			}, components),
		}
	}
	const {
		Map: map,
		Gamemode: gamemode,
		LayerVersion: version,
	} = parsedLayer

	const layerIdArgs: LayerIdArgs = applyBackwardsCompatMappings({
		Map: map,
		Gamemode: gamemode,
		LayerVersion: version ?? null,
		Faction_1: faction1.faction,
		Unit_1: faction1.unit ?? undefined,
		Faction_2: faction2.faction,
		Unit_2: faction2.unit ?? undefined,
	}, components)

	const id = getKnownLayerId(layerIdArgs, components)
	if (id != null) {
		knownLayerRes = parseLayerId(id, components)
		if (knownLayerRes.code === 'ok') return knownLayerRes.layer
	}
	return {
		id: `RAW:${rawLayerText}`,
		...applyBackwardsCompatMappings({
			Map: map,
			Layer: layerString,
			Gamemode: gamemode,
			LayerVersion: version ?? null,
			Faction_1: faction1.faction,
			Unit_1: faction1.unit ?? undefined,
			Faction_2: faction2.faction,
			Unit_2: faction2.unit ?? undefined,
		}, components),
	}
}

export const LAYER_STRING_PROPERTIES = ['Map', 'Gamemode', 'LayerVersion'] as const satisfies (keyof KnownLayer)[]
export function parseLayerStringSegment(layer: string) {
	const groups = layer.match(/^([A-Za-z0-9]+)_([A-Za-z0-9]+)?_([A-Za-z0-9]+)$/)
	if (!groups) {
		const trainingMaps = ['JensensRange', 'PacificProvingGrounds']
		for (const map of trainingMaps) {
			if (layer.startsWith(map)) {
				const trainingFactions = layer.slice(map.length + 1).split('-') as [string, string]

				return {
					layerType: 'training' as const,
					Map: map,
					Gamemode: 'Training',
					LayerVersion: null,
					extraFactions: trainingFactions,
				}
			}
		}
		return null
	}
	const [map, gamemode, version] = groups.slice(1)
	return {
		layerType: 'normal' as const,
		Map: map,
		Gamemode: gamemode,
		LayerVersion: version?.toUpperCase() ?? null,
	}
}

export function parseTeamString(
	team: string,
	components: typeof StaticLayerComponents = StaticLayerComponents,
): { faction: string; subfac: string | null } {
	const [faction, subfac] = team.split('-')
	return {
		faction,
		subfac: subfac ? Obj.revLookup(components.unitAbbreviations, subfac) : null,
	}
}

export function createLayerStringSegment(details: {
	Map: string
	Gamemode: string
	LayerVersion: string | null
}): string {
	if (details.Map === 'JensensRange') {
		throw new Error('JensensRange is not supported')
	}

	let layerString = `${details.Map}_${details.Gamemode}`
	if (details.LayerVersion) {
		layerString += `_${details.LayerVersion.toLowerCase()}`
	}

	return layerString
}

export function subfacFullNameToAbbr(fullName: string, components = StaticLayerComponents) {
	// @ts-expect-error idc
	return Obj.revLookup(components.subfactionFullNames, fullName)!
}

export type ParsedFaction = {
	faction: string
	unit: string | null
}

function parseLayerFactions(layer: string, faction1String: string, faction2String: string, components = StaticLayerComponents) {
	const parsedFactions: [ParsedFaction | null, ParsedFaction | null] = [null, null]
	for (let i = 0; i < 2; i++) {
		const factionString = i === 0 ? faction1String : faction2String
		if (!factionString) continue
		let [faction, unit] = factionString.split('+').map(s => s.trim())
		// 1/2 doesn't matter with this function application
		const converted = applyBackwardsCompatMappings({ Faction_1: faction, Unit_1: unit }, components)
		faction = converted.Faction_1
		unit = converted.Unit_1
		if (!faction) continue
		parsedFactions[i] = {
			faction: faction.trim(),
			unit: unit?.trim()
				?? components.layerFactionAvailability[layer]?.find(l => l.Faction === faction && l.isDefaultUnit)?.Unit ?? null,
		}
	}
	return parsedFactions
}

export function getFraasVariant(layer: KnownLayer) {
	if (layer.Gamemode !== 'RAAS') throw new Error('Expected RAAS gamemode')
	layer = Obj.deepClone(layer)
	layer.Layer = layer.Layer.replace('RAAS', 'FRAAS')
	layer.id = layer.id.replace('RAAS', 'FRAAS')
	layer.Gamemode = 'FRAAS'
	return layer
}

export const DEFAULT_LAYER_ID = 'GD-RAAS-V1:USA-CA:RGF-CA'

export type LayerFactionAvailabilityEntry = {
	Faction: string
	Unit: string
	allowedTeams: (1 | 2)[]
	isDefaultUnit: boolean
	variants?: {
		boats: boolean
		noHeli: boolean
	}
}

export type FactionUnitConfig = SLL.Unit
export type FactionUnitConfigMapping = Record<string, FactionUnitConfig>
export type LayerDetails = {
	layer: KnownLayer
	layerConfig: LayerConfig
	team1: FactionUnitConfig
	team2: FactionUnitConfig
}

export function resolveLayerDetails(
	layer: KnownLayer,
	factionUnitConfigs = StaticFactionunitConfigs,
	components = StaticLayerComponents,
) {
	const layerConfig = components.mapLayers.find(l => l.Layer === layer.Layer)!
	const factionUnitTeam1 = resolveFactionUnit(layer.Faction_1, layer.Unit_1, 1)
	const factionUnitTeam2 = resolveFactionUnit(layer.Faction_2, layer.Unit_2, 2)
	if (!factionUnitTeam1 || !factionUnitTeam2) return null

	return {
		layer,
		team1: factionUnitConfigs[factionUnitTeam1],
		team2: factionUnitConfigs[factionUnitTeam2],
		layerConfig,
	}

	function resolveFactionUnit(faction: string, unit: string, team: 1 | 2) {
		const entry = components.layerFactionAvailability[layer.Layer].find(e => e.Faction === faction && e.Unit === unit)
		if (!entry) return null
		const teamConfig = layerConfig.teams[team - 1]
		let size: string
		switch (layer.Size) {
			case 'Small':
				size = 'S'
				break
			case 'Medium':
				size = 'M'
				break
			case 'Large':
				size = 'L'
				break
			default:
				console.warn(`Unknown layer size: ${layer.Size}, defaulting to Small`)
				size = 'S'
		}

		let role: string = ''
		if (size !== 'S') {
			switch (teamConfig.role) {
				case 'attack':
					role = 'O'
					break
				case 'defend':
					role = 'D'
					break
				default:
					role = 'O'
			}
		}

		// TODO finish impleementing this
		let id = `${faction}_${size}${role}_${unit}`
		if (layer.Gamemode === 'Seed') id += '_Seed'
		if (entry.variants?.boats) id += '-Boats'
		// what the helly
		if (entry.variants?.noHeli) id += '-NoHeli'
		return id
	}
}

export type LayerConfig = {
	Layer: string
	Map: string
	Size: string
	Gamemode: string
	LayerVersion: string | null
	hasCommander: boolean
	persistentLightingType: string | null
	teams: MapConfigTeam[]
}

export type MapConfigTeam = {
	defaultFaction: string
	tickets: number
	role?: 'attack' | 'defend'
}

export type BackwardsCompatMappings = Record<'factions' | 'units' | 'gamemodes' | 'maps', Record<string, string>>

export function applyBackwardsCompatMappings<T extends Partial<KnownLayer>>(layer: T, components = StaticLayerComponents) {
	const updated = { ...layer }
	const mapping = {
		Faction_1: components.backwardsCompat.factions,
		Faction_2: components.backwardsCompat.factions,
		Gamemode: components.backwardsCompat.gamemodes,
		Map: components.backwardsCompat.maps,
		Unit: components.backwardsCompat.units,
	}
	for (const [_key, value] of Object.entries(updated)) {
		const key = _key as keyof KnownLayer
		if (value === null) continue
		if (key in mapping) {
			// @ts-expect-error idgaf
			updated[key] = mapping[key][value] ?? value
		}
	}
	return updated
}
