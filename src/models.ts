import * as z from 'zod'

export const getLayerKey = (layer: ProcessedLayer) =>
	`${layer.Level}-${layer.Layer}-${layer.Faction_1}-${layer.SubFac_1}-${layer.Faction_2}-${layer.SubFac_2}`

// Define enums for SubFac
export const SubFacEnum = z.enum(['CombinedArms', 'Armored', 'LightInfantry', 'Mechanized', 'Motorized', 'Support', 'AirAssault'])

// Define the schema for raw data
export const RawLayerSchema = z.object({
	Level: z.string(),
	Layer: z.string(),
	Size: z.string(),
	Faction_1: z.string(),
	SubFac_1: SubFacEnum,
	Logistics_1: z.number(),
	Transportation_1: z.number(),
	'Anti-Infantry_1': z.number(),
	Armor_1: z.number(),
	ZERO_Score_1: z.number(),
	Faction_2: z.string(),
	SubFac_2: SubFacEnum,
	Logistics_2: z.number(),
	Transportation_2: z.number(),
	'Anti-Infantry_2': z.number(),
	Armor_2: z.number(),
	ZERO_Score_2: z.number(),
	Balance_Differential: z.number(),
})

export type RawLayer = z.infer<typeof RawLayerSchema>

// Define the schema for processed data
export const ProcessedLayerSchema = RawLayerSchema.extend({
	Gamemode: z.string(),
	LayerVersion: z.string(),
	Logistics_Diff: z.number(),
	Transportation_Diff: z.number(),
	'Anti-Infantry_Diff': z.number(),
	Armor_Diff: z.number(),
	ZERO_Score_Diff: z.number(),
})

export type ProcessedLayer = z.infer<typeof ProcessedLayerSchema>
