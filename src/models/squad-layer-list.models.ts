import { z } from 'zod'

export const AvailableFactionSchema = z.object({
	factionId: z.string(),
	defaultUnit: z.string(),
	availableOnTeams: z.array(z.union([z.literal(1), z.literal(2)])),

	// units
	types: z.array(z.string()),
})
export type AvailableFaction = z.infer<typeof AvailableFactionSchema>

export const TeamSchema = z.object({
	defaultFactionUnit: z.string(),
	index: z.number(),
	playerPercent: z.number(),
	tickets: z.number(),
	disabledVeh: z.boolean(),
	isAttackingTeam: z.boolean(),
	isDefendingTeam: z.boolean(),
	allowedAlliances: z.array(z.string()),
	allowedFactionUnitTypes: z.array(z.string()),
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
	teamConfigs: z.object({ team1: TeamSchema, team2: TeamSchema }),
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
	unitObjectName: z.string(),
	factionName: z.string(),
	factionID: z.string(),
	shortName: z.string(),
	type: z.string(),
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
})
export type Unit = z.infer<typeof UnitSchema>

export const RootSchema = z.object({
	Maps: z.array(MapSchema),
	Units: z.record(z.string(), UnitSchema),
})

export type Root = z.infer<typeof RootSchema>
