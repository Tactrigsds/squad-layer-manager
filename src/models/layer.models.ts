import * as Obj from '@/lib/object-utils'
import * as Str from '@/lib/string-utils'
import { assertNever } from '@/lib/type-guards'
import * as z from '@/lib/zod'
import type * as GLD from '@/models/game-layer-data.models'
import * as LC from '@/models/layer-columns.models'

// fully derived layer data, loaded at startup by layer-data.server/layer-data.client (or built
// directly during preprocessing). models are supposed to be inert, so this state living here is a
// concession to how widely the data is consumed via default parameters.
export type LayerData = {
	components: LC.LayerComponents
	factionUnits: FactionUnitConfigMapping
	// definitions of the extra columns the layer db was built with. authored in layer-db.json, which is a
	// preprocess-time input: at runtime they ride along with the data they describe (see LayerDataFile)
	extraColumns: LC.ColumnDef[]
}

// the on-disk/wire shape of data/layer-data.json. derived parts of LayerComponents come from
// constants in code (LC.buildFullLayerComponents), so only the base components are persisted.
export type LayerDataFile = {
	components: LC.BaseLayerComponents
	factionUnits: FactionUnitConfigMapping
	extraColumns: LC.ColumnDef[]
}

function unloadedLayerDataProxy<T extends object>(name: string): T {
	const fail = (): never => {
		throw new Error(`${name} was accessed before layer data was loaded (setLayerData)`)
	}
	return new Proxy({} as T, { get: fail, has: fail, ownKeys: fail })
}

/** The loaded layer data: maps, gamemodes, factions and units. Every function here defaults to it. */
export let StaticLayerComponents: LC.LayerComponents = unloadedLayerDataProxy('StaticLayerComponents')
export let StaticFactionunitConfigs: FactionUnitConfigMapping = unloadedLayerDataProxy('StaticFactionunitConfigs')
export let StaticExtraColumns: LC.ColumnDef[] = unloadedLayerDataProxy('StaticExtraColumns')

// without factionUnits, StaticFactionunitConfigs stays unloaded (the layer query worker has no use for it)
export function setLayerData(data: LayerData | Omit<LayerData, 'factionUnits'>) {
	// JSON.parse allocates a fresh string per occurrence, and this data is a small vocabulary repeated across many
	// records: 14893 faction/unit entries drawn from 25 distinct values, and the same again in factionUnits.
	Obj.internStrings(data)
	StaticLayerComponents = data.components
	if ('factionUnits' in data) StaticFactionunitConfigs = data.factionUnits
	StaticExtraColumns = data.extraColumns
}

export const ASYMM_GAMEMODES = ['Invasion', 'Destruction', 'Insurgency']

// A world partitioning layer (Yehorivka_AAS_v1_WP) shares Map/Gamemode/Version with its base layer, so the suffix
// is folded into LayerVersion (V1WP) to keep the two apart in ids and filters.
const WORLD_PARTITION_SUFFIX = 'WP'

export function isWorldPartitionVersion(version: string | null) {
	return version?.endsWith(WORLD_PARTITION_SUFFIX) ?? false
}

export function worldPartitionVersion(version: string) {
	return version + WORLD_PARTITION_SUFFIX
}

/** The version without its world partitioning suffix: V1WP -> V1. */
export function baseLayerVersion(version: string) {
	return isWorldPartitionVersion(version) ? version.slice(0, -WORLD_PARTITION_SUFFIX.length) : version
}

/** How a version is spelled in a layer string: V1 -> v1, V1WP -> v1_WP. */
export function layerVersionNameSegment(version: string) {
	const base = baseLayerVersion(version).toLowerCase()
	return isWorldPartitionVersion(version) ? `${base}_${WORLD_PARTITION_SUFFIX}` : base
}

export type KnownLayer = {
	id: LayerId
	Map: string
	Size: string
	Layer: string
	Gamemode: string
	LayerVersion: string | null
	Collection: string
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
	Collection: string
	Faction_1: string
	Unit_1?: string
	Faction_2: string
	Unit_2?: string
}

declare const layerIdBrand: unique symbol

// A layer's id while the app runs. A layer the loaded layer data holds is its dense id (see LC.denseIdLayout); any
// other layer is its canonical text (see formatLayerText). Every id is built by idFromParts or fromLayerText, which
// pick the dense form whenever the layer data holds the layer, so two ids for one layer are always ===.
//
// Dense ids mean something only against the layer data that produced them. Storage, URLs and the plugin boundary's
// persisted data hold canonical text, and LayerIdSchema converts: it decodes either form and encodes to text.
export type LayerId = DenseLayerId | TextLayerId
export type DenseLayerId = number & { readonly [layerIdBrand]: true }
export type TextLayerId = string & { readonly [layerIdBrand]: true }

// a layer the loaded layer data does not hold
export type RawLayer = UnvalidatedLayer & { id: TextLayerId }

export const LayerIdSchema = z.codec(z.union([z.number().int().nonnegative(), z.string().min(1).max(512)]), z.custom<LayerId>(), {
	decode: (value, payload) => {
		let id: LayerId | undefined
		try {
			id = typeof value === 'number' ? checkDenseId(value) : fromStoredLayerText(value)
		} catch (err) {
			// the layer components throw until layer data loads. Stored text still reads, as a text id: a boundary that
			// promises not to throw (a db read, say) must not, and normalize() can resolve the id once data is loaded.
			if (typeof value === 'string') return value as TextLayerId
			throw err
		}
		if (id === undefined) {
			payload.issues.push({ code: 'custom', input: value, message: `${value} is not a layer id` })
			return value as LayerId
		}
		return id
	},
	encode: (id) => toLayerText(id),
})

export type UnvalidatedLayer = Partial<KnownLayer> & {
	Layer: string
	id: LayerId
}

// Canonical text: Layer:Faction+Unit:Faction+Unit, in the game's own names, such as
// Narva_RAAS_v1:RGF+CombinedArms:USA+CombinedArms. A layer known only in part drops what it lacks from the right: a
// unit, or both teams. No layer, faction or unit name holds ':', '+' or whitespace (preprocess enforces it).
const TEXT_NAME = '[^:+\\s]+'
const layerTextRegex = new RegExp(`^(${TEXT_NAME})(?::(${TEXT_NAME})(?:\\+(${TEXT_NAME}))?:(${TEXT_NAME})(?:\\+(${TEXT_NAME}))?)?$`)
export const LAYER_TEXT_NAME_FORBIDDEN = /[:+\s]/

export type LayerTextParts = { Layer: string; Faction_1?: string; Unit_1?: string; Faction_2?: string; Unit_2?: string }

export function formatLayerText(parts: LayerTextParts): string {
	if (!parts.Faction_1 || !parts.Faction_2) return parts.Layer
	const team = (faction: string, unit: string | undefined) => (unit ? `${faction}+${unit}` : faction)
	return `${parts.Layer}:${team(parts.Faction_1, parts.Unit_1)}:${team(parts.Faction_2, parts.Unit_2)}`
}

export function parseLayerText(text: string): LayerTextParts | undefined {
	const match = layerTextRegex.exec(text)
	if (!match) return undefined
	const [, Layer, Faction_1, Unit_1, Faction_2, Unit_2] = match
	return Obj.trimUndefined({ Layer, Faction_1, Unit_1, Faction_2, Unit_2 })
}

export function isDenseLayerId(id: LayerId): id is DenseLayerId {
	return typeof id === 'number'
}

// the dense id as a LayerId if it names a layer in the loaded layer data
export function checkDenseId(id: number, components = StaticLayerComponents): DenseLayerId | undefined {
	return LC.fromDenseId(id, LC.denseIdLayout(components)) ? (id as DenseLayerId) : undefined
}

// The id for a layer given by its parts: dense when the layer data holds a layer with exactly these parts, canonical
// text otherwise.
export function idFromParts(parts: LayerTextParts, components = StaticLayerComponents): LayerId {
	const { Layer, Faction_1, Unit_1, Faction_2, Unit_2 } = parts
	if (Faction_1 && Unit_1 && Faction_2 && Unit_2) {
		const indexes = [
			LC.enumIndexOf(components.layers, Layer),
			LC.enumIndexOf(components.factions, Faction_1),
			LC.enumIndexOf(components.units, Unit_1),
			LC.enumIndexOf(components.factions, Faction_2),
			LC.enumIndexOf(components.units, Unit_2),
		] as const
		if (!indexes.includes(-1)) {
			const dense = LC.denseId(...indexes, LC.denseIdLayout(components))
			if (dense !== -1) return dense as DenseLayerId
		}
	}
	return formatLayerText(parts) as TextLayerId
}

// The id canonical text names, or undefined when it is not canonical text. Text naming a layer the layer data holds
// comes back dense, and the rest is normalized the way the raw layer parser reads it (default units filled in, a
// Training layer's teams taken from its config).
export function fromLayerText(text: string, components = StaticLayerComponents): LayerId | undefined {
	const parts = parseLayerText(text)
	if (!parts) return undefined
	return layerFromParts(parts, components).id
}

// The id stored text names, whichever format wrote it: canonical text, or an id in the old abbreviated format or its
// RAW: form from before it. An old abbreviated id also fits the canonical grammar (its Map-Gamemode part reads as a
// layer name), so text is only taken as canonical when the layer data holds its layer, and undefined only when no
// format reads it.
export function fromStoredLayerText(text: string, components = StaticLayerComponents): LayerId | undefined {
	const parts = parseLayerText(text)
	if (parts && getLayerConfig(parts.Layer, components)) return layerFromParts(parts, components).id
	if (text.startsWith('RAW:')) return parseRawLayerText(text.slice('RAW:'.length), components)?.id
	const legacy = parseLegacyLayerId(text, components)
	if (legacy.code === 'ok') return legacy.layer.id
	// an abbreviation the layer data no longer has leaves the parts half resolved; keep the text as it was written
	// rather than an id built from guesses
	if (legacy.code === 'err:unknown-layer' && legacy.layer.Map && legacy.layer.Gamemode) return legacy.layer.id
	return parts ? (text as TextLayerId) : undefined
}

// fromStoredLayerText for a plain text column, where a row must always read: text no format reads stays a text id
export function readStoredLayerId(text: string, components = StaticLayerComponents): LayerId {
	try {
		return fromStoredLayerText(text, components) ?? (text as TextLayerId)
	} catch {
		// the layer components throw until layer data loads
		return text as TextLayerId
	}
}

export function toLayerText(id: LayerId, components = StaticLayerComponents): string {
	if (!isDenseLayerId(id)) return id
	const layer = knownLayerOfDenseId(id, components)
	if (!layer) throw new Error(`dense layer id ${id} names no layer in the loaded layer data`)
	return formatLayerText(layer)
}

// the known layer behind a dense id, built once per id and layer data
const knownLayersByDenseId = new WeakMap<LC.LayerComponents, Map<number, KnownLayer>>()
function knownLayerOfDenseId(id: number, components = StaticLayerComponents): KnownLayer | undefined {
	let cache = knownLayersByDenseId.get(components)
	if (!cache) knownLayersByDenseId.set(components, (cache = new Map()))
	const cached = cache.get(id)
	if (cached) return cached
	const indexes = LC.fromDenseId(id, LC.denseIdLayout(components))
	if (!indexes) return undefined
	const [layerIndex, faction1, unit1, faction2, unit2] = indexes
	const config = getLayerConfig(components.layers[layerIndex], components)
	if (!config) return undefined
	const Faction_1 = components.factions[faction1]
	const Faction_2 = components.factions[faction2]
	const layer: KnownLayer = {
		id: id as DenseLayerId,
		Map: config.Map,
		Size: config.Size,
		Layer: config.Layer,
		Gamemode: config.Gamemode,
		LayerVersion: config.LayerVersion,
		Collection: layerConfigCollection(config, components),
		Faction_1,
		Unit_1: components.units[unit1]!,
		Faction_2,
		Unit_2: components.units[unit2]!,
		Alliance_1: components.factionToAlliance[Faction_1],
		Alliance_2: components.factionToAlliance[Faction_2],
	}
	// shared by every caller holding this id
	Object.freeze(layer)
	cache.set(id, layer)
	return layer
}

// The layer canonical text parts name. Reads them the way it reads a raw layer command, so a part the layer data
// lacks still yields a layer with as much as could be resolved.
function layerFromParts(parts: LayerTextParts, components = StaticLayerComponents): UnvalidatedLayer {
	const team = (faction?: string, unit?: string) => (faction ? (unit ? `${faction}+${unit}` : faction) : '')
	const command = [parts.Layer, team(parts.Faction_1, parts.Unit_1), team(parts.Faction_2, parts.Unit_2)].join(' ').trim()
	return parseRawLayerText(command, components) ?? { id: formatLayerText(parts) as TextLayerId, Layer: parts.Layer }
}

// factions admit digits and underscores because mod faction ids do (SU_ADF, FAF10); '-' and ':' stay reserved as
// the id's own separators
const knownLayerIdRegex =
	/^(?<mapPart>[A-Za-z]+)-(?<gamemodePart>[A-Za-z]+)(?:-(?<versionOrCollectionPart1>[A-Za-z0-9]+))?(?:-(?<versionOrCollectionPart2>[A-Za-z0-9]+))?:(?<faction1>[A-Za-z0-9_]+)(?:-(?<unit1Abbr>[A-Za-z]+))?:(?<faction2>[A-Za-z0-9_]+)(?:-(?<unit2Abbr>[A-Za-z]+))?$/

// hand-rolled shape checks rather than zod schemas: these run once per layer in bulk paths
// (preprocess, id packing) where zod parsing showed up hot
function isStr(v: unknown): v is string {
	return typeof v === 'string'
}

function hasLayerIdArgsShape(layer: Partial<LayerIdArgs>) {
	return (
		isStr(layer.Map) &&
		isStr(layer.Gamemode) &&
		(layer.LayerVersion === null || isStr(layer.LayerVersion)) &&
		isStr(layer.Faction_1) &&
		isStr(layer.Faction_2) &&
		isStr(layer.Unit_1) &&
		isStr(layer.Unit_2) &&
		isStr(layer.Collection)
	)
}

function hasKnownLayerShape(layer: Partial<KnownLayer>) {
	return (
		(isStr(layer.id) || typeof layer.id === 'number') && hasLayerIdArgsShape(layer) && isStr(layer.Alliance_1) && isStr(layer.Alliance_2)
	)
}

/** Type guard for a layer the loaded layer data recognizes. Expects backwards-compat mappings to be applied already. */
export function isKnownLayer(layer: UnvalidatedLayer | LayerId, components = StaticLayerComponents): layer is KnownLayer {
	layer = toLayer(layer, components)
	if (!hasKnownLayerShape(layer)) return false
	if (
		!LC.enumIncludes(components.maps, layer.Map) ||
		!LC.enumIncludes(components.size, layer.Size) ||
		!LC.enumIncludes(components.layers, layer.Layer) ||
		!LC.enumIncludes(components.gamemodes, layer.Gamemode) ||
		!LC.enumIncludes(components.versions, layer.LayerVersion) ||
		!LC.enumIncludes(components.collections, layer.Collection) ||
		!LC.enumIncludes(components.factions, layer.Faction_1) ||
		!LC.enumIncludes(components.factions, layer.Faction_2) ||
		!LC.enumIncludes(components.units, layer.Unit_1) ||
		!LC.enumIncludes(components.units, layer.Unit_2) ||
		!LC.enumIncludes(components.alliances, layer.Alliance_1) ||
		!LC.enumIncludes(components.alliances, layer.Alliance_2)
	) {
		return false
	}

	const knownLayer = layer as KnownLayer

	const avail = components.layerFactionAvailability[knownLayer.Layer]

	const t1 = avail.find((f) => f.Faction === knownLayer.Faction_1 && f.Unit === knownLayer.Unit_1 && f.allowedTeams.includes(1))
	const t2 = avail.find((f) => f.Faction === knownLayer.Faction_2 && f.Unit === knownLayer.Unit_2 && f.allowedTeams.includes(2))
	if (!t1 || !t2) {
		return false
	}

	return true
}

export function areLayerIdArgsValid(layer: LayerIdArgs, components = StaticLayerComponents) {
	if (!hasLayerIdArgsShape(layer)) {
		return false
	}
	if (!components.mapAbbreviations[layer.Map] && Obj.revLookupCached(components.mapAbbreviations, layer.Map) === undefined) {
		return false
	}

	if (
		!components.gamemodeAbbreviations[layer.Gamemode] &&
		Obj.revLookupCached(components.gamemodeAbbreviations, layer.Gamemode) === undefined
	) {
		return false
	}

	if (!LC.enumIncludes(components.factions, layer.Faction_1)) {
		return false
	}
	if (!LC.enumIncludes(components.factions, layer.Faction_2)) {
		return false
	}

	if (!LC.enumIncludes(components.collections, layer.Collection)) {
		return false
	}

	return true
}

// Layer strings are canonical: they come from the source export and mod naming follows no convention worth parsing,
// so resolution is a catalog lookup, not string (re)construction. The caches key on the components object, which is
// replaced wholesale when layer data loads.
const layerConfigByLayerCache = new WeakMap<LC.LayerComponents, Map<string, LayerConfig>>()
const layerConfigsByDetailsCache = new WeakMap<LC.LayerComponents, Map<string, LayerConfig[]>>()

export function getLayerConfig(layer: string, components = StaticLayerComponents): LayerConfig | undefined {
	let index = layerConfigByLayerCache.get(components)
	if (!index) {
		index = new Map(components.mapLayers.map((config) => [config.Layer, config]))
		layerConfigByLayerCache.set(components, index)
	}
	return index.get(layer)
}

export function layerConfigCollection(config: LayerConfig, components = StaticLayerComponents) {
	return config.Collection ?? getDefaultCollection(components)
}

// several layers can share a details tuple (every training layer of a map has the same map/gamemode/version); the
// factions disambiguate via the layer's availability
export function findLayerConfigs(
	details: Pick<KnownLayer, 'Map' | 'Gamemode' | 'LayerVersion' | 'Collection'> & Partial<Pick<KnownLayer, 'Faction_1' | 'Faction_2'>>,
	components = StaticLayerComponents,
): LayerConfig[] {
	let index = layerConfigsByDetailsCache.get(components)
	if (!index) {
		index = new Map()
		for (const config of components.mapLayers) {
			const key = `${config.Map}|${config.Gamemode}|${config.LayerVersion}|${layerConfigCollection(config, components)}`
			let list = index.get(key)
			if (!list) index.set(key, (list = []))
			list.push(config)
		}
		layerConfigsByDetailsCache.set(components, index)
	}
	const candidates = index.get(`${details.Map}|${details.Gamemode}|${details.LayerVersion}|${details.Collection}`) ?? []
	if (candidates.length <= 1 || !details.Faction_1 || !details.Faction_2) return candidates
	const byFactions = candidates.filter((config) => {
		const avail = components.layerFactionAvailability[config.Layer]
		return (
			avail?.some((e) => e.Faction === details.Faction_1 && e.allowedTeams.includes(1)) &&
			avail?.some((e) => e.Faction === details.Faction_2 && e.allowedTeams.includes(2))
		)
	})
	return byFactions.length > 0 ? byFactions : candidates
}

export function getLayerString(
	details: Pick<KnownLayer, 'Map' | 'Gamemode' | 'LayerVersion' | 'Faction_1' | 'Faction_2' | 'Collection'>,
	components = StaticLayerComponents,
) {
	const configs = findLayerConfigs(details, components)
	if (configs.length > 0) return configs[0].Layer

	// vanilla reconstruction, for layers that are not in the catalog (raw layers, outdated persisted ids)
	if (details.Gamemode === 'Training') {
		return `${details.Map}_${details.Faction_1}-${details.Faction_2}`
	}
	let layer = `${details.Map}_${details.Gamemode}`
	if (details.LayerVersion) layer += `_${layerVersionNameSegment(details.LayerVersion)}`
	if (details.Collection) {
		const abbrev = components.collectionAbbreviations[details.Collection]
		if (typeof abbrev === 'string') {
			layer += `_${abbrev}`
		} else if (abbrev != null) {
			throw new Error(`unknown collection type "${details.Collection}"`)
		}
	}
	return layer
}

export function lookupDefaultUnit(layer: string, faction: string, components = StaticLayerComponents) {
	if (!components.layerFactionAvailability[layer]) {
		throw new Error(`Layer '${layer}' is missing in layerFactionAvailability`)
	}
	return components.layerFactionAvailability[layer]!.find((l) => {
		return l.isDefaultUnit && l.Faction === faction
	})?.Unit
}

export function getDefaultCollection(components = StaticLayerComponents) {
	const defaultCollection = components.collections.find((c) => components.collectionAbbreviations[c] === null)
	if (!defaultCollection) throw new Error('no default collection found')
	return defaultCollection
}

export function getLayerIdTeamString(faction: string, unit: string, components = StaticLayerComponents) {
	const unitAbbr = components.unitAbbreviations[unit]
	return `${faction}-${unitAbbr}`
}

/** The dense id of the known layer these parts name, or null. Missing units take the layer's default unit. */
export function getKnownLayerId(layer: LayerIdArgs, components = StaticLayerComponents): DenseLayerId | null {
	if (!areLayerIdArgsValid(layer, components)) return null
	const config = findLayerConfigs(layer, components).at(0)
	if (!config) return null
	const Unit_1 = layer.Unit_1 ?? lookupDefaultUnit(config.Layer, layer.Faction_1, components)
	const Unit_2 = layer.Unit_2 ?? lookupDefaultUnit(config.Layer, layer.Faction_2, components)
	if (!Unit_1 || !Unit_2) return null
	const id = idFromParts({ Layer: config.Layer, Faction_1: layer.Faction_1, Unit_1, Faction_2: layer.Faction_2, Unit_2 }, components)
	return isDenseLayerId(id) ? id : null
}

/** The known layer matching these parts, or null. isKnownLayer is the type guard for one you already hold. */
export function getKnownLayer(layer: LayerIdArgs, components = StaticLayerComponents): KnownLayer | null {
	const id = getKnownLayerId(layer, components)
	return id === null ? null : (knownLayerOfDenseId(id, components) ?? null)
}

export function isRawLayer(layer: UnvalidatedLayer | LayerId): layer is RawLayer {
	return !isDenseLayerId(typeof layer === 'object' ? layer.id : layer)
}

/**
 * Parses a layer id in the abbreviated format SLM used before canonical text (e.g. "GD-RAAS-V1:USA-CA:RGF-CA"), for
 * stored data and links written before it. Returns a result union: 'ok' with the known layer, or one of
 * 'err:invalid-layer-id', 'err:unknown-training-layer', or 'err:unknown-layer', the last of which still carries the
 * parsed parts. The layer's id is the current one.
 */
export function parseLegacyLayerId(id: string, components = StaticLayerComponents) {
	const match = knownLayerIdRegex.exec(id)

	if (!match || !match.groups) {
		return {
			code: 'err:invalid-layer-id' as const,
			msg: `Invalid layer ID: ${id}`,
		}
	}

	const { mapPart, gamemodePart, versionOrCollectionPart1, versionOrCollectionPart2, unit1Abbr, unit2Abbr } = match.groups
	let { faction1, faction2 } = match.groups
	const converted = applyBackwardsCompatMappings({ Faction_1: faction1, Faction_2: faction2 }, components)
	faction1 = converted.Faction_1
	faction2 = converted.Faction_2
	let versionPart: string | null = null
	let collectionPart: string | null = null
	for (const part of [versionOrCollectionPart1, versionOrCollectionPart2]) {
		if (!part) continue
		if (/^V\d+(?:WP)?$/.test(part)) {
			if (versionPart) {
				return {
					code: 'err:invalid-layer-id' as const,
					msg: `Found two versions in layer ID: ${id}`,
				}
			}
			versionPart = part
		} else {
			if (collectionPart) {
				return {
					code: 'err:invalid-layer-id' as const,
					msg: `Found two collections in layer ID: ${id}`,
				}
			}
			collectionPart = part
		}
	}

	const gamemode = Obj.revLookupCached(components.gamemodeAbbreviations, gamemodePart) as string | undefined
	const map = Obj.revLookupCached(components.mapAbbreviations, mapPart) as string | undefined
	const unit1 = (Obj.revLookupCached(components.unitAbbreviations, unit1Abbr) ??
		components.backwardsCompat.unitAbbreviations[unit1Abbr]) as string | undefined
	const unit2 = (Obj.revLookupCached(components.unitAbbreviations, unit2Abbr) ??
		components.backwardsCompat.unitAbbreviations[unit2Abbr]) as string | undefined
	const foldedCollection = collectionPart === null ? undefined : components.backwardsCompat.collectionAbbreviations[collectionPart]
	const collection = Obj.revLookupCached(components.collectionAbbreviations, collectionPart) ?? foldedCollection

	const layerVersion = versionPart ? versionPart.toUpperCase() : null
	const mapLayer = findLayerConfigs(
		{
			Map: map!,
			Gamemode: gamemode!,
			LayerVersion: layerVersion,
			Collection: (collection as string | undefined) ?? getDefaultCollection(components),
			Faction_1: faction1,
			Faction_2: faction2,
		},
		components,
	).at(0)
	let layerString: string | undefined = mapLayer?.Layer
	if (layerString === undefined) {
		if (gamemode === 'Training') {
			return {
				code: 'err:unknown-training-layer' as const,
				msg: `Unknown Training layer: ${id}`,
			}
		}
		layerString = `${map}_${gamemode}${layerVersion ? `_${layerVersionNameSegment(layerVersion)}` : ''}${collectionPart ? `_${collectionPart}` : ''}`
	}

	const layer = {
		id: idFromParts({ Layer: layerString, Faction_1: faction1, Unit_1: unit1, Faction_2: faction2, Unit_2: unit2 }, components),
		Map: map,
		Layer: layerString,
		Size: mapLayer?.Size,
		Gamemode: gamemode,
		LayerVersion: layerVersion,
		Collection: collection,
		Faction_1: faction1,
		Unit_1: unit1,
		Alliance_1: components.factionToAlliance[faction1],
		Faction_2: faction2,
		Unit_2: unit2,
		Alliance_2: components.factionToAlliance[faction2],
	}

	if (!isKnownLayer(layer, components)) {
		return { code: 'err:unknown-layer' as const, layer }
	}

	return {
		code: 'ok' as const,
		layer,
	}
}
export function swapFactions(_layer: UnvalidatedLayer | LayerId, components = StaticLayerComponents) {
	const layer = toLayer(_layer, components)
	if (!isKnownLayer(layer, components)) return null
	const swapped = toLayer(swapFactionsInId(layer.id, components), components)
	return isKnownLayer(swapped, components) ? swapped : null
}

export function swapFactionsInId(id: LayerId, components = StaticLayerComponents): LayerId {
	const layer = toLayer(id, components)
	return idFromParts(
		{ Layer: layer.Layer, Faction_1: layer.Faction_2, Unit_1: layer.Unit_2, Faction_2: layer.Faction_1, Unit_2: layer.Unit_1 },
		components,
	)
}

/** Every column matches. For "one of these is a partial of the other", see areLayersCompatible. */
export function layersEqual(a: LayerId | UnvalidatedLayer, b: LayerId | UnvalidatedLayer) {
	if (a === b) return true
	if (typeof a !== 'object') a = toLayer(a)
	if (typeof b !== 'object') b = toLayer(b)
	for (const def of Object.values(LC.BASE_COLUMN_DEFS)) {
		if (def.name === 'id') continue
		if (a[def.name] !== b[def.name]) return false
	}
	return true
}

// The world a layer loads is named after the layer, except that these layer prefixes load worlds with a different
// prefix. Jensens Range layers are named JensensRange_WPMC-TLF but load the world Jensens_Range_WPMC-TLF.
const WORLD_PREFIX_BY_LAYER_PREFIX: readonly (readonly [layerPrefix: string, worldPrefix: string])[] = [['JensensRange_', 'Jensens_Range_']]

/** Whether `classname`, the world named in the server log when a layer loads, is the world of this layer. */
export function layerMatchesIngameLayerClassname(_layer: LayerId | UnvalidatedLayer, classname: string) {
	const layer = toLayer(_layer)
	const normalizedLayerName = layer.Layer.replace('FRAAS', 'RAAS')
	if (normalizedLayerName === classname) return true
	for (const [layerPrefix, worldPrefix] of WORLD_PREFIX_BY_LAYER_PREFIX) {
		if (
			normalizedLayerName.startsWith(layerPrefix) &&
			classname.startsWith(worldPrefix) &&
			normalizedLayerName.slice(layerPrefix.length) === classname.slice(worldPrefix.length)
		) {
			return true
		}
	}
	return false
}

/**
 * Resolves a raw layer to the known layer it matches, where there is one, such as one added by newer layer data.
 * Returns the input unchanged otherwise.
 */
export function normalize<Original extends LayerId | UnvalidatedLayer>(original: Original, components = StaticLayerComponents): Original {
	const layer = toLayer(original, components)
	if (!isRawLayer(layer)) return original
	const id = idFromParts(layer, components)
	if (!isDenseLayerId(id)) return original
	return typeof original === 'object' ? (knownLayerOfDenseId(id, components) as Original) : (id as Original)
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

	const layerRes = typeof toCompare === 'object' ? toCompare : toLayer(toCompare, components)
	const targetLayerRes = typeof target === 'object' ? target : toLayer(target, components)
	if (coalesceFraas) return Obj.isPartial(coalesceFraasLayer(layerRes), coalesceFraasLayer(targetLayerRes), ['id'])
	return Obj.isPartial(layerRes, targetLayerRes, ['id'])
}

// a copy reading FRAAS as RAAS, or the layer itself when it names no FRAAS
function coalesceFraasLayer(layer: UnvalidatedLayer): UnvalidatedLayer {
	if (layer.Gamemode !== 'FRAAS' && !layer.Layer?.includes('FRAAS')) return layer
	const coalesced = { ...layer, Layer: layer.Layer.replace('FRAAS', 'RAAS') }
	if (coalesced.Gamemode === 'FRAAS') coalesced.Gamemode = 'RAAS'
	return coalesced
}

/** areLayersPartialMatch in either direction, so neither argument has to be the more specific one. */
export function areLayersCompatible(
	layer1: LayerId | UnvalidatedLayer,
	layer2: LayerId | UnvalidatedLayer,
	coalesceFraas = true,
	components = StaticLayerComponents,
) {
	return (
		areLayersPartialMatch(layer1, layer2, coalesceFraas, components) || areLayersPartialMatch(layer2, layer1, coalesceFraas, components)
	)
}

export const SEEDING_OR_TRAINING_GAMEMODES = ['Seed', 'Training'] as const

export function isSeedingOrTrainingLayer(layerOrId: UnvalidatedLayer | LayerId, components = StaticLayerComponents) {
	const layer = toLayer(layerOrId, components)
	return layer.Gamemode === 'Seed' || layer.Gamemode === 'Training'
}

/** Accepts an id or a layer and gives back a layer. Coercion only: it validates nothing. */
export function toLayer(unvalidatedLayerOrId: UnvalidatedLayer | LayerId, components = StaticLayerComponents): UnvalidatedLayer {
	if (typeof unvalidatedLayerOrId === 'object') return unvalidatedLayerOrId
	if (isDenseLayerId(unvalidatedLayerOrId)) {
		const layer = knownLayerOfDenseId(unvalidatedLayerOrId, components)
		if (!layer) throw new Error(`dense layer id ${unvalidatedLayerOrId} names no layer in the loaded layer data`)
		return layer
	}
	return rawLayerOfText(unvalidatedLayerOrId, components)
}

// the layer behind a text id, parsed once per id and layer data
const MAX_CACHED_TEXT_LAYERS = 4096
const rawLayersByText = new WeakMap<LC.LayerComponents, Map<string, UnvalidatedLayer>>()
function rawLayerOfText(id: TextLayerId, components = StaticLayerComponents): UnvalidatedLayer {
	let cache = rawLayersByText.get(components)
	if (!cache) rawLayersByText.set(components, (cache = new Map()))
	const cached = cache.get(id)
	if (cached) return cached
	// text ids can come from anywhere (links, RCON, stored rows), so the cache is dropped rather than left to grow
	if (cache.size >= MAX_CACHED_TEXT_LAYERS) cache.clear()
	const parts = parseLayerText(id)
	const parsed = parts ? layerFromParts(parts, components) : { Layer: id }
	// keep the id the caller holds: a text id normalizes to a dense one only where the caller asks (see normalize)
	const layer = Object.freeze({ ...parsed, id })
	cache.set(id, layer)
	return layer
}

export function getLayerCommand(
	layerOrId: UnvalidatedLayer | LayerId,
	cmdType: 'set-next' | 'change-layer' | 'none',
	components = StaticLayerComponents,
) {
	const layer = toLayer(layerOrId, components)
	function getFactionModifier(faction: string, subFac: string | undefined) {
		return `${faction}${subFac ? `+${subFac}` : ''}`
	}
	// a layer the layer data does not hold has no default units to look up; the game picks its own
	const raw = isRawLayer(layer)
	const unitFor = (unit: string | undefined, faction: string) =>
		unit ?? (raw ? undefined : lookupDefaultUnit(layer.Layer, faction, components))
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
	// a training layer's teams are fixed by its config, and the game ignores faction arguments on one
	const bareTrainingLayer = layer.Gamemode === 'Training'
	if (bareTrainingLayer) {
		commandArgs = layer.Layer
	} else {
		commandArgs = layer.Layer
		if (layer.Faction_1) {
			commandArgs += ' '
			commandArgs += getFactionModifier(layer.Faction_1, unitFor(layer.Unit_1, layer.Faction_1))
		}
		if (layer.Faction_2) {
			commandArgs += ' '
			commandArgs += getFactionModifier(layer.Faction_2, unitFor(layer.Unit_2, layer.Faction_2))
		}
	}
	return `${cmd} ${commandArgs.replace('FRAAS', 'RAAS')}`.trim().replace(/\s+/g, ' ')
}

// undefined when the layer is too partial to locate on a map, which is what makes the caller disable its squadcalc entry
export function getSquadcalcUrl(baseUrl: string, layerOrId: UnvalidatedLayer | LayerId, components = StaticLayerComponents) {
	const layer = toLayer(layerOrId, components)
	if (!layer.Gamemode || !layer.Map) return undefined
	const params = new URLSearchParams()
	params.set('map', layer.Map)
	// squadcalc has no world partitioning layers; the base layer's version stands in
	params.set(
		'layer',
		layer.Gamemode.replace('FRAAS', 'RAAS') + (layer.LayerVersion ? baseLayerVersion(layer.LayerVersion).toLowerCase() : ''),
	)
	return baseUrl + '?' + params.toString()
}

export function parseRawLayerText(rawLayerText: string, components = StaticLayerComponents): UnvalidatedLayer | null {
	// an admin may still paste an id in the old abbreviated format
	const legacy = parseLegacyLayerId(rawLayerText, components)
	if (legacy.code === 'ok') return legacy.layer
	rawLayerText = rawLayerText
		.replace(/^(AdminSetNextLayer|AdminChangeLayer)/, '')
		.trim()
		.replace(/\s+/g, ' ')
	const [layerString, faction1String, faction2String] = rawLayerText.split(' ')
	if (!layerString?.trim()) return null
	const config = getLayerConfig(layerString, components)
	const parsedLayer: ParseLayerStringSegmentResult | null = parseLayerStringSegment(layerString, components)
	let faction1: ParsedFaction | null = null
	let faction2: ParsedFaction | null = null
	if (!config && parsedLayer && parsedLayer.layerType === 'training') {
		;[faction1, faction2] = parsedLayer.extraFactions.map((f): ParsedFaction => ({ faction: f, unit: 'CombinedArms' }))
	} else if (config && !faction1String && !faction2String && config.Gamemode === 'Training') {
		// training commands carry no faction arguments; the config's default factions are the factions
		;[faction1, faction2] = config.teams.map((team): ParsedFaction => ({
			faction: team.defaultFaction,
			unit: lookupDefaultUnit(layerString, team.defaultFaction, components) ?? 'CombinedArms',
		}))
	} else {
		;[faction1, faction2] = parseLayerFactions(layerString, faction1String, faction2String, components)
	}
	const rawLayer = (fields: Omit<UnvalidatedLayer, 'id'>): UnvalidatedLayer => {
		const mapped = applyBackwardsCompatMappings(fields, components)
		return { ...mapped, id: idFromParts(mapped, components) }
	}
	if (!parsedLayer || !faction1 || !faction2) {
		return rawLayer({
			Map: parsedLayer?.Map,
			Layer: layerString,
			Gamemode: parsedLayer?.Gamemode,
			LayerVersion: parsedLayer?.LayerVersion ?? null,
			Collection: parsedLayer?.Collection ?? getDefaultCollection(components),
			Faction_1: faction1?.faction,
			Unit_1: faction1?.unit ?? undefined,
			Faction_2: faction2?.faction,
			Unit_2: faction2?.unit ?? undefined,
		})
	}
	const { Map: map, Gamemode: gamemode, LayerVersion: version, Collection: collection } = parsedLayer

	const layerIdArgs: LayerIdArgs = applyBackwardsCompatMappings(
		{
			Map: map,
			Gamemode: gamemode,
			LayerVersion: version ?? null,
			Collection: collection,
			Faction_1: faction1.faction,
			Unit_1: faction1.unit ?? undefined,
			Faction_2: faction2.faction,
			Unit_2: faction2.unit ?? undefined,
		},
		components,
	)

	const known = getKnownLayer(layerIdArgs, components)
	if (known) return known
	return rawLayer({
		Map: map,
		Layer: layerString,
		Gamemode: gamemode,
		LayerVersion: version ?? null,
		Collection: collection,
		Faction_1: faction1.faction,
		Unit_1: faction1.unit ?? undefined,
		Faction_2: faction2.faction,
		Unit_2: faction2.unit ?? undefined,
	})
}

// What is wrong with one part of a pasted line. `suggestion` is the closest name the catalog has, for a typo.
export type RawLayerProblem =
	| { code: 'unknown-layer'; value: string; suggestion: string | null }
	| { code: 'unknown-faction'; team: 1 | 2; value: string; suggestion: string | null }
	| { code: 'unknown-unit'; team: 1 | 2; value: string; suggestion: string | null }
	| { code: 'missing-faction'; team: 1 | 2 }
	| { code: 'unavailable-faction'; team: 1 | 2; faction: string; unit: string | null }
	| { code: 'mirror-matchup'; faction: string }

// One pasted line, and what is wrong with it. The line number is 1-based over the pasted text with blank lines
// counted, so it addresses what the user is looking at rather than the parsed subset.
// 'err:unparsable' is a line with a layer, faction or unit the catalog does not have, or a faction left out.
// 'err:unknown-layer' is a line whose parts are all in the catalog but do not combine into a playable layer. Its
// problems are empty when only the layer database can say why. Both still carry the raw layer, for a caller that
// queues it anyway.
export type RawLayerLine = { lineNumber: number; text: string } & (
	| { code: 'ok'; layer: UnvalidatedLayer }
	| { code: 'err:unparsable'; layer: UnvalidatedLayer | null; problems: RawLayerProblem[] }
	| { code: 'err:unknown-layer'; layer: UnvalidatedLayer; problems: RawLayerProblem[] }
	| { code: 'err:mod-not-installed'; layer: UnvalidatedLayer; collection: string }
)

// Parses pasted layer text a line at a time, reporting each line's own outcome rather than dropping what fails.
// `installedMods` is the server's collections; omit it where there is no server to answer for. The collection is
// checked first, because the server refuses a layer from a missing mod whether or not it is known.
export function parseRawLayerLines(
	text: string,
	opts?: { installedMods?: readonly string[] },
	components = StaticLayerComponents,
): RawLayerLine[] {
	const lines: RawLayerLine[] = []
	text.split('\n').forEach((raw, index) => {
		const trimmed = raw.trim()
		if (trimmed.length === 0) return
		const lineNumber = index + 1
		const layer = parseRawLayerText(trimmed, components)
		if (!layer) {
			lines.push({ code: 'err:unparsable', lineNumber, text: trimmed, layer: null, problems: [] })
			return
		}
		const collection = layer.Collection ?? getDefaultCollection(components)
		if (opts?.installedMods && !opts.installedMods.includes(collection)) {
			lines.push({ code: 'err:mod-not-installed', lineNumber, text: trimmed, layer, collection })
			return
		}
		if (!isKnownLayer(layer, components)) {
			const problems = diagnoseRawLayer(layer, components)
			const unparsable = problems.some((p) => p.code !== 'unavailable-faction' && p.code !== 'mirror-matchup')
			lines.push({ code: unparsable ? 'err:unparsable' : 'err:unknown-layer', lineNumber, text: trimmed, layer, problems })
			return
		}
		// the layer database leaves these out; flagged here so the line names its reason
		if (layer.Faction_1 === layer.Faction_2 && layer.Gamemode !== 'Training') {
			const problems: RawLayerProblem[] = [{ code: 'mirror-matchup', faction: layer.Faction_1 }]
			lines.push({ code: 'err:unknown-layer', lineNumber, text: trimmed, layer, problems })
			return
		}
		lines.push({ code: 'ok', lineNumber, text: trimmed, layer })
	})
	return lines
}

function diagnoseRawLayer(layer: UnvalidatedLayer, components: typeof StaticLayerComponents): RawLayerProblem[] {
	const problems: RawLayerProblem[] = []
	const config = layer.Layer ? getLayerConfig(layer.Layer, components) : undefined
	if (!config) {
		const value = layer.Layer ?? ''
		problems.push({ code: 'unknown-layer', value, suggestion: suggestName(value, layerNames(components)) })
	}
	const avail = config ? (components.layerFactionAvailability[config.Layer] ?? []) : []
	for (const team of [1, 2] as const) {
		const faction = team === 1 ? layer.Faction_1 : layer.Faction_2
		const unit = team === 1 ? layer.Unit_1 : layer.Unit_2
		if (!faction) {
			if (config) problems.push({ code: 'missing-faction', team })
			continue
		}
		const teamAvail = avail.filter((entry) => entry.allowedTeams.includes(team))
		if (!LC.enumIncludes(components.factions, faction)) {
			const candidates = config ? Array.from(new Set(teamAvail.map((entry) => entry.Faction))) : components.factions
			problems.push({
				code: 'unknown-faction',
				team,
				value: faction,
				suggestion: suggestName(faction, candidates),
			})
			continue
		}
		if (unit !== undefined && !LC.enumIncludes(components.units, unit)) {
			const factionUnits = teamAvail.filter((entry) => entry.Faction === faction).map((entry) => entry.Unit)
			const candidates = factionUnits.length > 0 ? factionUnits : components.units
			problems.push({
				code: 'unknown-unit',
				team,
				value: unit,
				suggestion: suggestName(unit, candidates),
			})
			continue
		}
		if (config && !teamAvail.some((entry) => entry.Faction === faction && (unit === undefined || entry.Unit === unit))) {
			problems.push({ code: 'unavailable-faction', team, faction, unit: unit ?? null })
		}
	}
	// the layer data leaves these out, so a line naming one is otherwise only "unknown"
	if (config && layer.Faction_1 && layer.Faction_1 === layer.Faction_2 && config.Gamemode !== 'Training') {
		problems.push({ code: 'mirror-matchup', faction: layer.Faction_1 })
	}
	return problems
}

const layerNamesCache = new WeakMap<typeof StaticLayerComponents, string[]>()
function layerNames(components: typeof StaticLayerComponents) {
	let names = layerNamesCache.get(components)
	if (!names) {
		names = components.mapLayers.map((config) => config.Layer)
		layerNamesCache.set(components, names)
	}
	return names
}

function suggestName(typed: string, candidates: readonly string[]) {
	if (typed === '') return null
	return Str.nearestWithinEdits(typed, candidates, Math.max(1, Math.floor(typed.length / 4)))
}

export const LAYER_STRING_PROPERTIES = ['Map', 'Gamemode', 'LayerVersion', 'Collection'] as const satisfies (keyof KnownLayer)[]
export type ParseLayerStringSegmentResult<Collection extends string | null = string> = {
	Map: string
	Gamemode: string
	LayerVersion: string | null
	Collection: Collection
} & (
	| {
			layerType: 'training'
			extraFactions: [string, string]
	  }
	| {
			layerType: 'normal'
	  }
)

export function parseLayerStringSegment<C extends typeof StaticLayerComponents | null = typeof StaticLayerComponents>(
	layer: string,
	components: C = StaticLayerComponents as C,
): ParseLayerStringSegmentResult<C extends null ? null : string> | null {
	// the catalog is the authority. The regex below only reads back OWI's Map_Gamemode_vN convention, which no mod
	// source follows: every Supermod/Resurgence/GC map name contains an underscore, so parsing one yields the wrong
	// Map and drops the gamemode entirely. componentsTemp during preprocess has no mapLayers yet, hence the guard
	const config = components?.mapLayers ? getLayerConfig(layer, components) : undefined
	if (config) {
		return {
			layerType: 'normal' as const,
			Map: config.Map,
			Gamemode: config.Gamemode,
			LayerVersion: config.LayerVersion,
			// @ts-expect-error typescript bad and/or skill-issue
			Collection: layerConfigCollection(config, components),
		}
	}

	const groups = layer.match(/^([A-Za-z0-9]+)_([A-Za-z0-9]+)?(_v\d+)?(_WP)?(_\w+)?$/)
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

					// @ts-expect-error typescript bad and/or skill-issue
					Collection: !components ? null : getDefaultCollection(components),
				}
			}
		}
		return null
	}
	const [map, gamemode, versionRaw, worldPartitionRaw, collectionRaw] = groups.slice(1)
	let version = versionRaw?.slice(1).toUpperCase()
	if (version && worldPartitionRaw) version = worldPartitionVersion(version)
	const collection = !components
		? null
		: (Obj.revLookupCached(components.collectionAbbreviations, collectionRaw?.slice(1) ?? null) ?? getDefaultCollection(components))
	return {
		layerType: 'normal' as const,
		Map: map,
		Gamemode: gamemode,
		LayerVersion: version ?? null,
		// @ts-expect-error typescript bad and/or skill-issue
		Collection: collection,
	}
}

export function parseTeamString(
	team: string,
	components: typeof StaticLayerComponents = StaticLayerComponents,
): { faction: string; subfac: string | null } {
	const [faction, subfac] = team.split('-')
	return {
		faction,
		subfac: subfac ? Obj.revLookupCached(components.unitAbbreviations, subfac) : null,
	}
}

export function getFactionIdForFactionNameInexact(name: string, factionUnitConfigs = StaticFactionunitConfigs) {
	const normedName = normalize(name)
	for (const fac of Object.values(factionUnitConfigs)) {
		if (normalize(fac.factionName) === normedName) {
			return fac.factionID
		}
	}
	return

	function normalize(name: string) {
		return name.toLowerCase().replace(/\s+/g, '')
	}
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
		let [faction, unit] = factionString.split('+').map((s) => s.trim())
		// 1/2 doesn't matter with this function application
		const converted = applyBackwardsCompatMappings({ Faction_1: faction, Unit_1: unit }, components)
		faction = converted.Faction_1
		unit = converted.Unit_1
		if (!faction) continue
		parsedFactions[i] = {
			faction: faction.trim(),
			unit:
				unit?.trim() ?? components.layerFactionAvailability[layer]?.find((l) => l.Faction === faction && l.isDefaultUnit)?.Unit ?? null,
		}
	}
	return parsedFactions
}

export const DEFAULT_LAYER_TEXT = 'Gorodok_RAAS_v1:USA+CombinedArms:RGF+CombinedArms'

export function defaultLayerId(components = StaticLayerComponents): LayerId {
	return fromLayerText(DEFAULT_LAYER_TEXT, components)!
}

export type LayerFactionAvailabilityEntry = {
	Faction: string
	Unit: string
	allowedTeams: (1 | 2)[]
	isDefaultUnit: boolean
	variants?: {
		boats: boolean
		noHeli: boolean
	}
	// the exact Units record backing this entry per team, resolved at preprocess. Absent in artifacts that predate
	// it, and for entries preprocess could not resolve; resolveLayerDetails then falls back to reconstructing a
	// vanilla-convention name.
	unitObjectNames?: { 1?: string; 2?: string }
}

export type FactionUnitConfig = GLD.Unit
export type FactionUnitConfigMapping = Record<string, FactionUnitConfig>
export type LayerDetails = {
	layer: KnownLayer
	layerConfig: LayerConfig
	team1: FactionUnitConfig
	team2: FactionUnitConfig
}

export function resolveLayerDetails(layer: KnownLayer, factionUnitConfigs = StaticFactionunitConfigs, components = StaticLayerComponents) {
	const layerConfig = getLayerConfig(layer.Layer, components)!
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
		const entry = components.layerFactionAvailability[layer.Layer].find((e) => e.Faction === faction && e.Unit === unit)
		if (!entry) return null
		if (entry.unitObjectNames?.[team]) return entry.unitObjectNames[team]
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
	// absent in artifacts written before mod sources existed; read it via layerConfigCollection
	Collection?: string
	hasCommander: boolean
	persistentLightingType: string | null
	teams: MapConfigTeam[]
}

export type MapConfigTeam = {
	defaultFaction: string
	tickets: number
	role?: 'attack' | 'defend'
}

export type BackwardsCompatMappings = Record<'factions' | 'units' | 'gamemodes' | 'maps', Record<string, string>> &
	Record<'collections', Record<string, string | null>> &
	// a collection or unit folded into another leaves its abbreviation in every layer id already persisted or pasted into chat
	Record<'collectionAbbreviations' | 'unitAbbreviations', Record<string, string>>

export function applyBackwardsCompatMappings<T extends Partial<KnownLayer>>(layer: T, components = StaticLayerComponents) {
	const updated: Partial<KnownLayer> = { ...layer }
	const mapping = {
		Faction_1: components.backwardsCompat.factions,
		Faction_2: components.backwardsCompat.factions,
		Gamemode: components.backwardsCompat.gamemodes,
		Map: components.backwardsCompat.maps,
		Unit_1: components.backwardsCompat.units,
		Unit_2: components.backwardsCompat.units,
		Collection: components.backwardsCompat.collections,
	}
	for (const key of Object.keys(mapping) as (keyof typeof mapping)[]) {
		const value = updated[key]
		if (value == null) continue
		updated[key] = mapping[key][value] ?? value
	}
	return updated as T
}

export function applyBackwardsCompatMapping(
	field: 'factions' | 'units' | 'gamemodes' | 'maps' | 'collections',
	value: string,
	components = StaticLayerComponents,
) {
	return components.backwardsCompat[field][value] ?? value
}

// Splits parsed lines into what is added and what blocks the add. With validation on, a line that parsed to a known
// layer is also checked against the layer database, the authority on what can be queued, and is pending until that
// check answers. With validation off, only a missing mod blocks, since the server refuses it.
export function resolveRawLayerLines(lines: RawLayerLine[], validate: boolean, existence: { id: LayerId; exists: boolean }[] | undefined) {
	const exists = new Map(existence?.map((res) => [res.id, res.exists]))
	const errors: RawLayerLine[] = []
	const layers: UnvalidatedLayer[] = []
	let pending = false
	for (const line of lines) {
		switch (line.code) {
			case 'ok': {
				if (!validate) {
					layers.push(line.layer)
					break
				}
				const found = exists.get(line.layer.id)
				if (found === undefined) pending = true
				else if (found) layers.push(line.layer)
				else errors.push({ ...line, code: 'err:unknown-layer', problems: [] })
				break
			}
			case 'err:unparsable':
			case 'err:unknown-layer':
				if (validate) errors.push(line)
				else if (line.layer) layers.push(line.layer)
				break
			case 'err:mod-not-installed':
				errors.push(line)
				break
			default:
				assertNever(line)
		}
	}
	return { errors, layers, pending }
}
