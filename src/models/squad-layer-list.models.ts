import * as Obj from '@/lib/object'
import { z } from 'zod'

// do not expose these enums, use layer-components.json instead
const FACTION_ID = z.string().transform(fixFactions).pipe(
	z.enum([
		'ADF',
		'PLA',
		'PLANMC',
		'PLAAGF',
		'MEI',
		'RGF',
		'VDV',
		'TLF',
		'GFI',
		'WPMC',
		'BAF',
		'CAF',
		'USA',
		'USMC',
		'IMF',
		'CRF',
		'INS',
		'AFU',
	]),
)

const UNIT_TYPE = z.enum([
	'Mechanized',
	'AirAssault',
	'Armored',
	'LightInfantry',
	'Motorized',
	'Support',
	'CombinedArms',
	'AmphibiousAssault',
])
type UnitType = z.infer<typeof UNIT_TYPE>

const unitIdRegex = /^(FSTemplate_[A-Z]+|[A-Z]+_[A-Z]+_\w+)\d?$/
const UnitId = z.string().regex(unitIdRegex)

export function parseUnitId(unitId: string) {
	// Handle FSTemplate format (e.g., "FSTemplate_USMC")
	if (unitId.startsWith('FSTemplate_')) {
		const factionId = unitId.replace('FSTemplate_', '')
		return { factionId, position: 'S', unit: UNIT_TYPE.parse('CombinedArms') }
	}

	// Handle standard format (e.g., "USMC_LO_CombinedArms")
	const match = unitId.match(/^(?<factionId>[A-Z]+)_(?<position>[A-Z]+)_(?<unit>\w+)\d?$/)
	if (!match || !match.groups) {
		throw new Error(`Invalid unit ID format: ${unitId}`)
	}
	let { unit } = match.groups
	unit = unit.replace(/_Seed$/, '')
	unit = unit.replace(/_Skirmish/, '')
	return { factionId: match.groups.factionId, position: match.groups.position, unit: UNIT_TYPE.parse(unit) }
}

export const AvailableFactionSchema = z.object({
	factionId: FACTION_ID,
	defaultUnit: UnitId,
	availableOnTeams: z.array(z.union([z.literal(1), z.literal(2)])),

	// units
	types: z.array(UNIT_TYPE),
})
export type AvailableFaction = z.infer<typeof AvailableFactionSchema>

export const TeamSchema = z.object({
	defaultFactionUnit: UnitId,
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
	biome: z.string(),
	factions: z.array(AvailableFactionSchema),
	mapSize: z.string(),
	commander: z.boolean(),
	lightingLevel: z.string(),
	persistentLightingType: z.string().nullable(),
	mapId: z.string(),
	teamConfigs: z.object({ team1: TeamSchema.optional(), team2: TeamSchema.optional() }),
})

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

export const UnitSchema = z.object({
	unitObjectName: UnitId,
	factionName: z.string(),
	factionID: FACTION_ID,
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
	characteristics: z.array(z.object({
		key: z.string(),
		description: z.string(),
	})),
}).transform(unit => ({ ...unit, type: parseUnitId(unit.unitObjectName)!.unit }))
export type Unit = z.infer<typeof UnitSchema>

export const RootSchema = z.object({
	Maps: z.array(z.any()).transform(maps => maps.filter(map => !map.levelName.includes('Tutorial'))).pipe(z.array(MapSchema)),
	Units: z.record(z.string(), z.any()).transform((units) =>
		Obj.filterRecord(units, (value, key) => {
			key = key.toLowerCase()
			return !key.includes('tutorial') && !key.includes('test') && !key.startsWith('civ')
		})
	).pipe(z.record(UnitId, UnitSchema)),
})

export type Root = z.infer<typeof RootSchema>

function fixFactions(faction: string) {
	if (faction === 'INS') return 'MEI'
	return faction
}
