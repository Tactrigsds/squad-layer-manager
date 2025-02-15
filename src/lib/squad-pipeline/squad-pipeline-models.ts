import { z } from 'zod'

// Enum definitions
export const GameModeSchema = z.enum([
	'AAS',
	'RAAS',
	'Invasion',
	'Destruction',
	'Insurgency',
	'Territory Control',
	'Skirmish',
	'Seed',
	'Track Attack',
	'Training',
	'Tutorial',
	'Tanks',
])
export type GameMode = z.infer<typeof GameModeSchema>

const CapturePointsGraphTypeSchema = z.enum([
	'AAS Graph',
	'RAASLane Graph',
	'Unknown',
	'Invasion Random Graph',
	'RAASGraph',
	'TC Hex Zone',
	'Insurgency',
	'Destruction',
	'Track Attack',
])
export type CapturePointsGraphType = z.infer<typeof CapturePointsGraphTypeSchema>

// TODO probably need a preprocessor step to dedupe these values
const UnitTypeSchema = z.enum([
	'Combined Arms',
	'CombinedArms',
	'AirAssault',
	'Air Assault',
	'Armored',
	'Mechanized',
	'Motorized',
	'Light Infantry',
	'LightInfantry',
	'Support',
	'Special Forces',
	'Amphibious Assault',
])
export type UnitType = z.infer<typeof UnitTypeSchema>

const PointWithCordsSchema = z.object({
	location_x: z.number(),
	location_y: z.number(),
	location_z: z.number(),
})
export type PointWithCords = z.infer<typeof PointWithCordsSchema>

const BorderPointSchema = PointWithCordsSchema.extend({
	point: z.number(),
})
export type BorderPoint = z.infer<typeof BorderPointSchema>

const CacheObjects = PointWithCordsSchema.extend({
	sphereRadius: z.string(),
	boxExtent: z.object({
		location_x: z.number(),
		location_y: z.number(),
		location_z: z.number(),
	}),
})

const CapturePoint = PointWithCordsSchema.extend({
	name: z.string(),
	objectName: z.string(),
	pointPosition: z.number(),
	objects: z.array(CacheObjects),
})
export type CapturePoint = z.infer<typeof CapturePoint>

const VehicleSchema = z.object({
	type: z.string(),
	icon: z.string(),
	count: z.number(),
	delay: z.number(),
	respawnTime: z.number(),
})
export type Vehicle = z.infer<typeof VehicleSchema>

const UnitSchema = z.object({
	unitObjectName: z.string(),
	factionID: z.string(),
	factionName: z.string(),
	shortName: z.string(),
	displayName: z.string(),
	description: z.string(),
	unitBadge: z.string(),
	useCommanderActionNearVehicle: z.boolean(),
	hasBuddyRally: z.boolean(),
	vehicles: z.array(VehicleSchema),
})
export type Unit = z.infer<typeof UnitSchema>

const LinkSchema = z.object({
	name: z.string(),
	nodeA: z.string(),
	nodeB: z.string(),
})
export type Link = z.infer<typeof LinkSchema>

const HexSchema = z.object({
	boxExtent: z.object({
		location_x: z.number(),
		location_y: z.number(),
	}),
	flagName: z.string(),
	hexNum: z.number(),
	initialTeam: z.string(),
	location_x: z.number(),
	location_y: z.number(),
	sphereRadius: z.number(),
})

export type Hex = z.infer<typeof HexSchema>

const PhaseSchema = z.object({
	PhaseNumber: z.number(),
	phaseObjectives: z.array(
		z.object({
			numberOfSpots: z.number(),
			minDistanceBetweenSpots: z.number(),
			numberOfCaches: z.number(),
			splinePoints: z.array(PointWithCordsSchema),
		})
	),
})
export type Phase = z.infer<typeof PhaseSchema>

const TeamSchema = z.object({
	index: z.union([z.literal(1), z.literal(2)]),
	defaultFactionUnit: z.string(),
	tickets: z.number(),
	disabledVeh: z.boolean(),
	playerPercent: z.number(),
	allowedAlliances: z.array(z.string()),
	allowedFactionUnitTypes: z.array(UnitTypeSchema),
	requiredTags: z.array(z.string()),
})
export type Team = z.infer<typeof TeamSchema>

const SetupUnitTypesSchema = z.object({
	unitType: UnitTypeSchema,
	unit: z.string(),
})
export type SetupUnitTypes = z.infer<typeof SetupUnitTypesSchema>

const FactionSetupSchema = z.object({
	factionID: z.string(),
	defaultUnit: z.string(),
	types: z.array(SetupUnitTypesSchema),
})
export type FactionSetup = z.infer<typeof FactionSetupSchema>

const FactionsSchema = z.object({
	separatedFactionsList: z.boolean(),
	team1Units: z.array(FactionSetupSchema),
	team2Units: z.array(FactionSetupSchema),
})
export type Factions = z.infer<typeof FactionsSchema>

// Main Map schema
export const MapSchema = z.object({
	Name: z.string(),
	rawName: z.string(),
	levelName: z.string(),
	mapId: z.string(),
	mapName: z.string(),
	gamemode: GameModeSchema,
	layerVersion: z.string(),
	minimapTexture: z.string(),
	heliAltThreshold: z.number(),
	depthMapTexture: z.string(),
	lightingLevel: z.string().optional(),
	lighting: z.string().optional(),
	borderType: z.string(),
	mapSizeType: z.string(),
	border: z.array(BorderPointSchema),
	mapSize: z.string(),
	mapTextureCorners: z.array(BorderPointSchema),
	mapAssets: z.object({
		protectionZones: z.array(
			z.object({
				deployableLockDistance: z.number(),
				displayName: z.string(),
				objects: z.array(
					z.object({
						location_x: z.number(),
						location_y: z.number(),
						location_z: z.number(),
						sphereRadius: z.number(),
					})
				),
			})
		),
		stagingZones: z.array(
			z.object({
				name: z.string(),
				objects: z.array(
					z.object({
						name: z.string(),
						location_x: z.number(),
						location_y: z.number(),
						location_z: z.number(),
						sphereRadius: z.number(),
					})
				),
			})
		),
	}),
	assets: z.object({
		vehicleSpawners: z.array(z.unknown()),
		deployables: z.array(z.unknown()),
		helipads: z.array(z.unknown()),
	}),
	objectives: z.record(
		z.string(),
		z.union([
			z.object({
				location_x: z.number(),
				location_y: z.number(),
				location_z: z.number(),
				name: z.string(),
				objectName: z.string(),
				pointPosition: z.number(),
			}),
			z.object({
				avgLocation: z.object({
					location_x: z.number(),
					location_y: z.number(),
				}),
			}),
		])
	),
	capturePoints: z.object({
		type: CapturePointsGraphTypeSchema,
		lanes: z.unknown(),
		points: z.union([
			z.object({
				pointsOrder: z.array(z.string()),
				numberOfPoints: z.number(),
				objectives: z.array(CapturePoint).optional(),
			}),
			z.object({}),
		]),
		clusters: z.object({
			links: z.array(LinkSchema).optional(),
			numberOfPoints: z.number().optional(),
			listOfMains: z.array(z.string()).optional(),
		}),
		hexs: z.object({
			hexs: z.array(HexSchema).optional(),
		}),
		objectiveSpawnLocations: z.array(PointWithCordsSchema.extend({ name: z.string() })).optional(),
		destructionObject: z.union([
			z.object({
				attackingTeam: z.string(),
				delayBetweenPhases: z.number(),
				objectiveClass: z.string(),
				roundTimerIncrease: z.number(),
				timerIncreasePerPhaseActive: z.boolean(),
				phases: z.array(PhaseSchema),
			}),
			z.object({}),
		]),
	}),
	team1: z.object({
		faction: z.string(),
		shortName: z.string(),
	}),
	team2: z.object({
		faction: z.string(),
		shortName: z.string(),
	}),
	teamConfigs: z
		.object({
			team1: TeamSchema,
			team2: TeamSchema,
			factions: FactionsSchema,
		})
		.optional(),
})

export type Map = z.infer<typeof MapSchema>

// Additional types from the original file
export type Cache = PointWithCords & { name: string }

export const PipelineOutputSchema = z.object({
	Maps: z.array(MapSchema),
	mapsavailable: z.array(z.string()),
})

export type Output = z.infer<typeof PipelineOutputSchema>
