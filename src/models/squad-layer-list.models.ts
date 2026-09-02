import * as Obj from '@/lib/object-utils'
import { z } from '@/lib/zod'

// Unit types every source understands, whatever its own availability lists mention. These are the name-segment
// vocabulary ("CombinedArms"), not the Units[].type field ("COMBINED_ARMS"): the two disagree in the game data
// (AmphibiousAssault-named units are typed MECHANIZED_AMPHIBIOUS), and availability `types` arrays speak the former.
export const CORE_UNIT_TYPES = [
	'AirAssault',
	'Armored',
	'CombinedArms',
	'LightInfantry',
	'Mechanized',
	'Motorized',
	'Support',
	'AmphibiousAssault',
] as const

// A layer source is one SquadLayerList export plus the vocabulary the export itself cannot carry: how its layers
// join the id scheme (abbreviations), and fixes for broken names in the mod's data. data/sources/<name>/ holds the
// pair (source.json + layers.json).
export const SourceManifestSchema = z.object({
	name: z.string().regex(/^[a-z0-9-]+$/),
	// every layer of the source lands in this collection; the id segment comes from the abbreviation. Exactly one
	// source (vanilla) has abbreviation null, which makes it the default collection with no id segment.
	collection: z.object({
		name: z.string().min(1),
		abbreviation: z
			.string()
			.regex(/^[A-Za-z]+$/)
			.nullable(),
	}),
	// 'parsed' derives Map/Gamemode/Version by parsing levelName (vanilla's convention). 'structured' trusts the
	// export's mapId/gamemode fields instead, which is the only thing that works for mod naming.
	layerNames: z.enum(['parsed', 'structured']),
	// synthesize a FRAAS twin for every RAAS layer (the fog-removal convention of vanilla community servers)
	fraasVariants: z.boolean().default(false),
	// required for every Map value the source produces that the core table doesn't cover
	mapAbbreviations: z.record(z.string(), z.string()).default({}),
	gamemodeAbbreviations: z.record(z.string(), z.string()).default({}),
	// structured exports can spell a gamemode differently than layer names do ("TerritoryControl" vs "TC"); renames
	// keep one vocabulary across sources
	gamemodeRenames: z.record(z.string(), z.string()).default({}),
	// unit types beyond CORE_UNIT_TYPES that appear in this source's unit names
	extraUnitTypes: z.record(z.string(), z.object({ abbreviation: z.string(), shortName: z.string() })).default({}),
	// unit object name -> unit type, for names no parse can rescue (supermod ships a unit named "Mechanizedd")
	unitTypeOverrides: z.record(z.string(), z.string()).default({}),
	// levelName -> field overrides, for layers whose structured fields are lossy or wrong: distinct layers sharing a
	// mapId, or a gamemode field that contradicts the name. Preprocess fails on the resulting duplicate ids, naming
	// the layers to override here.
	layerOverrides: z
		.record(
			z.string(),
			z.object({
				Map: z.string().optional(),
				Gamemode: z.string().optional(),
				LayerVersion: z.string().nullable().optional(),
			}),
		)
		.default({}),
})
export type SourceManifest = z.infer<typeof SourceManifestSchema>

const POSITION_SEGMENTS = new Set(['LO', 'LD', 'MO', 'MD', 'S'])

export type ParsedUnitName = {
	// LO/LD/MO/MD/S, encoding the layer tier the unit belongs to and its attack/defend role
	position: string | null
	unit: string | null
	variants: { boats: boolean; noHeli: boolean }
}

// Unit object names are convention soup across sources ("BAF_LO_CombinedArms", "SU_CAF_MO_CombinedArms",
// "FRA20_LO_Support_503TR_Boats", "USA70_FSTemplate"), so nothing is positional: each segment is checked against the
// small closed sets it could belong to, and the unit type against the vocabulary the source's availability lists
// and manifest declare.
export function parseUnitName(name: string, vocab: ReadonlySet<string>, overrides: Record<string, string> = {}): ParsedUnitName {
	const segments = name.split(/[_-]/)
	const variants = { boats: segments.includes('Boats'), noHeli: segments.includes('NoHeli') }
	if (segments.includes('FSTemplate')) {
		return { position: 'S', unit: 'CombinedArms', variants }
	}
	let position: string | null = null
	let unit: string | null = overrides[name] ?? null
	for (const segment of segments) {
		if (position === null && POSITION_SEGMENTS.has(segment)) position = segment
		if (unit === null && vocab.has(segment)) unit = segment
	}
	// some sources put Seed where the position goes ("SAA_Seed_CombinedArms"); seed units are S-tier
	if (position === null && segments.includes('Seed')) position = 'S'
	return { position, unit, variants }
}

export function collectUnitTypeVocabulary(rawRoot: unknown, manifest: SourceManifest): Set<string> {
	const vocab = new Set<string>(CORE_UNIT_TYPES)
	for (const type of Object.keys(manifest.extraUnitTypes)) vocab.add(type)
	const maps = (rawRoot as { Maps?: { factions?: { types?: unknown[] }[] }[] }).Maps ?? []
	for (const map of maps) {
		for (const faction of map.factions ?? []) {
			for (const type of faction.types ?? []) {
				// "None" is how some exports spell an empty slot
				if (typeof type === 'string' && type && type !== 'None') vocab.add(type)
			}
		}
	}
	return vocab
}

const FactionId = z.string().min(1).transform(fixFactions)

const UnitId = z.string().min(1)

export const AvailableFactionSchema = z.object({
	factionId: FactionId,
	// null on half-configured test layers; preprocess skips the faction
	defaultUnit: UnitId.nullable(),
	availableOnTeams: z.array(z.union([z.literal(1), z.literal(2)])),

	// units
	types: z.array(z.string()),
})
export type AvailableFaction = z.infer<typeof AvailableFactionSchema>

export const TeamSchema = z.object({
	// mod exports ship half-configured test layers without one; preprocess skips those layers
	defaultFactionUnit: UnitId.optional(),
	index: z.number(),
	playerPercent: z.number(),
	tickets: z.number(),
	disabledVeh: z.boolean(),
	isAttackingTeam: z.boolean(),
	isDefendingTeam: z.boolean(),
	allowedAlliances: z.array(z.string()),
})
export type Team = z.infer<typeof TeamSchema>

export const MapSchema = z.object({
	levelName: z.string(),
	gamemode: z.string(),
	biome: z.string(),
	factions: z.array(AvailableFactionSchema),
	mapSize: z.string(),
	commander: z.boolean(),
	lightingLevel: z.string(),
	persistentLightingType: z.string().nullable(),
	mapId: z.string(),
	teamConfigs: z.object({ team1: TeamSchema.optional(), team2: TeamSchema.optional() }),
})
export type Map = z.infer<typeof MapSchema>

export const VehicleSchema = z.object({
	name: z.string(),
	rowName: z.string(),
	type: z.string(),
	count: z.number(),
	delay: z.number(),
	respawnTime: z.number(),
	vehType: z.string(),
	spawnerSize: z.string(),
	icon: z.string(),
	classNames: z.array(z.string()),
	tags: z.array(z.string()),
	spawnCommands: z.array(z.string()),
})
export type Vehicle = z.infer<typeof VehicleSchema>

const UnitSchemaBase = z.object({
	unitObjectName: UnitId,
	factionName: z.string(),
	factionID: FactionId,
	shortName: z.string(),
	displayName: z.string(),
	description: z.string(),
	unitBadge: z.string(),
	alliance: z.string(),
	actions: z.number(),
	intelOnEnemy: z.number(),
	useCommanderActionNearVehicle: z.boolean(),
	hasBuddyRally: z.boolean(),
	roles: z.array(z.string()),
	vehicles: z.array(VehicleSchema),
	characteristics: z.array(
		z.object({
			key: z.string(),
			description: z.string(),
		}),
	),
})
export type Unit = z.infer<typeof UnitSchemaBase> & { type: string | null }

export function createRootSchema(vocab: ReadonlySet<string>, overrides: Record<string, string> = {}) {
	const UnitSchema = UnitSchemaBase.transform((unit): Unit => ({
		...unit,
		type: parseUnitName(unit.unitObjectName, vocab, overrides).unit,
	}))
	return z.object({
		Maps: z
			.array(z.any())
			.transform((maps) => maps.filter((map) => !['Tutorial', 'Lobby', 'Fireteam'].includes(map.gamemode)))
			.pipe(z.array(MapSchema)),
		Units: z
			.record(z.string(), z.any())
			.transform((units) =>
				Obj.filterRecord(units, (value, key) => {
					key = key.toLowerCase()
					return !key.includes('tutorial') && !key.includes('test') && !key.startsWith('civ') && !key.includes('lobby')
				}),
			)
			.pipe(z.record(UnitId, UnitSchema)),
	})
}

export type Root = { Maps: Map[]; Units: Record<string, Unit> }

function fixFactions(faction: string) {
	if (faction === 'INS') return 'MEI'
	return faction
}
