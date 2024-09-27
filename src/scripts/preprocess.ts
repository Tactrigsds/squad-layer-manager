import * as DB from '@/server/db'
import { parse } from 'csv-parse/sync'
import * as fs from 'fs'
import * as z from 'zod'

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

// Function to process a single layer
function processLayer(rawLayer: RawLayer): ProcessedLayer {
	const [_, gamemode, version] = rawLayer.Layer.split('_')

	return {
		...rawLayer,
		Gamemode: gamemode,
		LayerVersion: version,
		Logistics_Diff: rawLayer.Logistics_1 - rawLayer.Logistics_2,
		Transportation_Diff: rawLayer.Transportation_1 - rawLayer.Transportation_2,
		'Anti-Infantry_Diff': rawLayer['Anti-Infantry_1'] - rawLayer['Anti-Infantry_2'],
		Armor_Diff: rawLayer.Armor_1 - rawLayer.Armor_2,
		ZERO_Score_Diff: rawLayer.ZERO_Score_1 - rawLayer.ZERO_Score_2,
	}
}

// Read and parse CSV file
const csvData = fs.readFileSync('layers.csv', 'utf8')
const records = parse(csvData, { columns: true, skip_empty_lines: true })

// Process and validate data
const processedLayers: ProcessedLayer[] = records
	.map((record: any) => {
		// Convert string values to numbers where necessary
		const numericFields = [
			'Logistics_1',
			'Transportation_1',
			'Anti-Infantry_1',
			'Armor_1',
			'ZERO_Score_1',
			'Logistics_2',
			'Transportation_2',
			'Anti-Infantry_2',
			'Armor_2',
			'ZERO_Score_2',
			'Balance_Differential',
		]
		numericFields.forEach((field) => {
			record[field] = parseFloat(record[field])
		})

		// Validate raw data
		const validatedRawLayer = RawLayerSchema.parse(record)

		// Process the layer
		return processLayer(validatedRawLayer)
	})
	.map((layer: any) => ProcessedLayerSchema.parse(layer)) // Validate processed data
const db = await DB.openConnection()

// Delete existing table and create a new one
// Drop the existing table if it exists
await db.run(`DROP TABLE IF EXISTS layers`)

// Create a new table
await db.run(`CREATE TABLE layers (
    Level TEXT,
    Layer TEXT,
    Size TEXT,
    Faction_1 TEXT,
    SubFac_1 TEXT,
    Logistics_1 REAL,
    Transportation_1 REAL,
    Anti_Infantry_1 REAL,
    Armor_1 REAL,
    ZERO_Score_1 REAL,
    Faction_2 TEXT,
    SubFac_2 TEXT,
    Logistics_2 REAL,
    Transportation_2 REAL,
    Anti_Infantry_2 REAL,
    Armor_2 REAL,
    ZERO_Score_2 REAL,
    Balance_Differential REAL,
    Gamemode TEXT,
    LayerVersion TEXT,
    Logistics_Diff REAL,
    Transportation_Diff REAL,
    Anti_Infantry_Diff REAL,
    Armor_Diff REAL,
    ZERO_Score_Diff REAL
  )`)

// Prepare insert statement
const stmt = await db.prepare(`INSERT INTO layers VALUES (
    ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
  )`)

// Insert processed layers
for (const layer of processedLayers) {
	await stmt.run(
		layer.Level,
		layer.Layer,
		layer.Size,
		layer.Faction_1,
		layer.SubFac_1,
		layer.Logistics_1,
		layer.Transportation_1,
		layer['Anti-Infantry_1'],
		layer.Armor_1,
		layer.ZERO_Score_1,
		layer.Faction_2,
		layer.SubFac_2,
		layer.Logistics_2,
		layer.Transportation_2,
		layer['Anti-Infantry_2'],
		layer.Armor_2,
		layer.ZERO_Score_2,
		layer.Balance_Differential,
		layer.Gamemode,
		layer.LayerVersion,
		layer.Logistics_Diff,
		layer.Transportation_Diff,
		layer['Anti-Infantry_Diff'],
		layer.Armor_Diff,
		layer.ZERO_Score_Diff
	)
}

await stmt.finalize()

db.close()
