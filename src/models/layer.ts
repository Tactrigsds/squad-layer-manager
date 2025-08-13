import _StaticLayerComponents from '$root/assets/layer-components.json'
import * as Obj from '@/lib/object'
import * as LC from '@/models/layer-columns'
import * as z from 'zod'

export let StaticLayerComponents = _StaticLayerComponents as unknown as LC.LayerComponentsJson

// clear out static layer components so we can verify that we're not using them while preprocessing
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

export const LayerIdSchema = z.string().min(1).max(255).refine(id => {
	if (id.startsWith('RAW:')) return true
	const res = parseKnownLayerId(id)
	if (res.code !== 'ok') {
		return false
	}
	return res.code === 'ok'
}, {
	message: 'Is valid layer id',
})

export type LayerId = z.infer<typeof LayerIdSchema>

export type UnvalidatedLayer = Partial<KnownLayer> & { Layer: string; id: string }

function getKnownLayerIdRegex(components = StaticLayerComponents) {
	const mapAbbrs = Object.values(components.mapAbbreviations).join('|')
	const gamemodeAbbrs = Object.values(components.gamemodeAbbreviations).join('|')
	const factions = components.factions.join('|')
	const unitAbbrs = Object.values(components.unitAbbreviations).join('|')

	return new RegExp(
		`^(?<mapPart>${mapAbbrs})-(?<gamemodePart>${gamemodeAbbrs})(?:-(?<versionPart>[A-Z0-9]+))?:(?<faction1>${factions})(?:-(?<unit1Abbr>${unitAbbrs}))?:(?<faction2>${factions})(?:-(?<unit2Abbr>${unitAbbrs}))?$`,
	)
}

let knownLayerIdRegex!: RegExp
function ensureIdRegexInitialized() {
	if (knownLayerIdRegex) return
	knownLayerIdRegex = getKnownLayerIdRegex(StaticLayerComponents)
}

export function isKnownLayer(layer: UnvalidatedLayer | LayerId, components = StaticLayerComponents): layer is KnownLayer {
	const id = typeof layer === 'string' ? layer : layer.id
	ensureIdRegexInitialized()
	return (id !== undefined && !id.startsWith('RAW:') && parseKnownLayerId(id, components).code === 'ok')
}

export function areLayerIdArgsValid(layer: LayerIdArgs, components = StaticLayerComponents) {
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
			layer[unitProp] = lookupDefaultUnit(getLayerString(layer), layer[factionProp])
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
export function getKnownLayer(layer: LayerIdArgs): KnownLayer | null {
	const id = getKnownLayerId(layer)
	if (id === null) return null

	// TODO kind of wasteful, could implement separate routine based directly on `layer`
	const res = parseKnownLayerId(id)
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

export function parseKnownLayerId(id: string, components = StaticLayerComponents) {
	ensureIdRegexInitialized()
	const match = knownLayerIdRegex.exec(id)

	if (!match || !match.groups) {
		return { code: 'err:invalid-layer-id' as const, msg: `Invalid layer ID: ${id}` }
	}

	const { mapPart, gamemodePart, versionPart, faction1, unit1Abbr, faction2, unit2Abbr } = match.groups

	const gamemode = Obj.revLookup(components.gamemodeAbbreviations, gamemodePart)
	const map = Obj.revLookup(components.mapAbbreviations, mapPart)
	const unit1 = Obj.revLookup(components.unitAbbreviations, unit1Abbr)
	const unit2 = Obj.revLookup(components.unitAbbreviations, unit2Abbr)

	const layerVersion = versionPart ? versionPart.toUpperCase() : null
	let layer: string | undefined
	if (gamemode === 'Training') {
		layer = `${map}_${faction1}-${faction2}`
		if (!components.layers.includes(layer)) {
			return {
				code: 'err:unknown-training-layer' as const,
				msg: `Unknown Training layer: ${id}`,
			}
		}
	} else {
		layer = components.layers.find(
			(l) => l.startsWith(`${map}_${gamemode}`) && (!layerVersion || l.endsWith(layerVersion.toLowerCase())),
		)
		if (!layer) {
			return { code: 'err:unknown-layer' as const, msg: `Unknown layer: ${map}_${gamemode}${layerVersion ? `_${layerVersion}` : ''}` }
		}
	}
	const mapLayer = components.mapLayers.find(l => l.Layer === layer)

	return {
		code: 'ok' as const,
		layer: {
			id,
			Map: map,
			Layer: layer,
			Size: mapLayer!.Size,
			Gamemode: gamemode,
			LayerVersion: layerVersion,
			Faction_1: faction1,
			Unit_1: unit1,
			Alliance_1: components.factionToAlliance[faction1],
			Faction_2: faction2,
			Unit_2: unit2,
			Alliance_2: components.factionToAlliance[faction2],
		},
	}
}

export function swapFactionsInId(id: LayerId) {
	const [layer, faction1, faction2] = id.split(':')
	return `${layer}:${faction2}:${faction1}`
}

/**
 * Check if the layers are equal, or at least all parts of the layer partials `toCompare` contains are in targetId
 */
export function areLayersPartialMatch(
	toCompare: LayerId | UnvalidatedLayer,
	target: LayerId | UnvalidatedLayer,
	ignoreFraas: boolean = true,
) {
	if (toCompare === target) return true

	const layerRes = typeof toCompare === 'string' ? toLayer(toCompare) : toCompare
	const targetLayerRes = typeof target === 'string' ? toLayer(target) : target
	if (ignoreFraas) {
		if (layerRes.Layer) layerRes.Layer = layerRes.Layer?.replace('FRAAS', 'RAAS')
		if (targetLayerRes.Layer) targetLayerRes.Layer = targetLayerRes.Layer?.replace('FRAAS', 'RAAS')
		if (layerRes.Gamemode === 'FRAAS') layerRes.Gamemode = 'RAAS'
		if (targetLayerRes.Gamemode === 'FRAAS') targetLayerRes.Gamemode = 'RAAS'
	}

	return Obj.isPartial(layerRes, targetLayerRes, ['id'])
}

export function areLayersCompatible(layer1: LayerId | UnvalidatedLayer, layer2: LayerId | UnvalidatedLayer, ignoreFraas = true) {
	return areLayersPartialMatch(layer1, layer2, ignoreFraas) || areLayersPartialMatch(layer2, layer1, ignoreFraas)
}

export function toLayer(unvalidatedLayerOrId: UnvalidatedLayer | LayerId, components = StaticLayerComponents): UnvalidatedLayer {
	if (typeof unvalidatedLayerOrId === 'string') {
		return fromPossibleRawId(unvalidatedLayerOrId, components)
	}
	return unvalidatedLayerOrId
}

export function fromPossibleRawId(id: string, components = StaticLayerComponents): UnvalidatedLayer {
	if (id.startsWith('RAW:')) {
		return parseRawLayerText(id.slice('RAW:'.length))!
	}
	const res = parseKnownLayerId(id, components)
	if (res.code !== 'ok') throw new Error(res.msg)
	return res.layer
}

export function getAdminSetNextLayerCommand(layerOrId: UnvalidatedLayer | LayerId) {
	if (layerOrId === 'string' && layerOrId.startsWith('RAW')) return layerOrId.slice('RAW:'.length)
	const layer = typeof layerOrId === 'string' ? fromPossibleRawId(layerOrId) : layerOrId
	if (isRawLayer(layer)) return layer.id.slice('RAW:'.length)
	function getFactionModifier(faction: LayerId, subFac: LayerId | null) {
		return `${faction}${subFac ? `+${subFac}` : ''}`
	}
	if (layer.Layer.startsWith('JensensRange')) {
		return `AdminSetNextLayer ${layer.Layer}`
	}

	let cmd = `AdminSetNextLayer ${layer.Layer?.replace('FRAAS', 'RAAS')}`
	if (layer.Faction_1) {
		cmd += ' '
		cmd += getFactionModifier(layer.Faction_1, layer.Unit_1 ?? lookupDefaultUnit(layer.Layer, layer.Faction_1)!)
	}
	if (layer.Faction_1 && layer.Faction_2) {
		cmd += ' '
		cmd += getFactionModifier(layer.Faction_2, layer.Unit_2 ?? lookupDefaultUnit(layer.Layer, layer.Faction_2)!)
	}

	return cmd
}

export function parseRawLayerText(rawLayerText: string): UnvalidatedLayer | null {
	let knownLayerRes = parseKnownLayerId(rawLayerText)
	if (knownLayerRes.code === 'ok') return knownLayerRes.layer
	rawLayerText = rawLayerText.replace(/^AdminSetNextLayer/, '').trim().replace(/\s+/g, ' ')
	const [layerString, faction1String, faction2String] = rawLayerText.split(' ')
	if (!layerString?.trim()) return null
	const parsedLayer = parseLayerStringSegment(layerString)
	let faction1: ParsedFaction | null = null
	let faction2: ParsedFaction | null = null
	if (parsedLayer?.extraFactions) {
		;[faction1, faction2] = parsedLayer.extraFactions.map((f): ParsedFaction => ({ faction: f, unit: 'CombinedArms' }))
	} else {
		;[faction1, faction2] = parseLayerFactions(layerString, faction1String, faction2String)
	}
	if (!parsedLayer || !faction1 || !faction2) {
		return {
			id: 'RAW:' + rawLayerText,
			Map: parsedLayer?.Map,
			Layer: layerString,
			Gamemode: parsedLayer?.Gamemode,
			LayerVersion: parsedLayer?.LayerVersion ?? null,
			Faction_1: faction1?.faction,
			Unit_1: faction1?.unit,
			Faction_2: faction2?.faction,
			Unit_2: faction2?.unit,
		}
	}
	const {
		Map: map,
		Gamemode: gamemode,
		LayerVersion: version,
	} = parsedLayer

	const layerIdArgs: LayerIdArgs = {
		Map: map,
		Gamemode: gamemode,
		LayerVersion: version ?? null,
		Faction_1: faction1.faction,
		Unit_1: faction1.unit,
		Faction_2: faction2.faction,
		Unit_2: faction2.unit,
	}

	const id = getKnownLayerId(layerIdArgs)
	if (id != null) {
		knownLayerRes = parseKnownLayerId(id)
		if (knownLayerRes.code === 'ok') return knownLayerRes.layer
	}
	return {
		id: `RAW:${rawLayerText}`,
		Map: map,
		Layer: layerString,
		Gamemode: gamemode,
		LayerVersion: version ?? null,
		Faction_1: faction1.faction,
		Unit_1: faction1.unit,
		Faction_2: faction2.faction,
		Unit_2: faction2.unit,
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
	unit: string
}

function parseLayerFactions(layer: string, faction1String: string, faction2String: string, components = StaticLayerComponents) {
	const parsedFactions: [ParsedFaction | null, ParsedFaction | null] = [null, null]
	for (let i = 0; i < 2; i++) {
		const factionString = i === 0 ? faction1String : faction2String
		if (!factionString) continue
		const [faction, unit] = factionString.split('+').map(s => s.trim())
		if (!faction) continue
		parsedFactions[i] = {
			faction: faction.trim(),
			unit: unit?.trim()
				?? components.layerFactionAvailability[layer]!.find(l => l.Faction === faction && l.isDefaultUnit)?.Unit,
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
