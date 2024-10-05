import * as C from '@/lib/constants'
import * as M from '@/models'
import { db, setupDatabase } from '@/server/db'
import * as Schema from '@/server/schema'
import { parse } from 'csv-parse/sync'
import { sql } from 'drizzle-orm'
import * as fs from 'fs'
import { z } from 'zod'

setupDatabase()

// Define the schema for raw data

export const RawLayerSchema = z.object({
	Level: z.string(),
	Layer: z.string(),
	Size: z.string(),
	Faction_1: z.string(),
	SubFac_1: z.string(),
	Logistics_1: z.number(),
	Transportation_1: z.number(),
	'Anti-Infantry_1': z.number(),
	Armor_1: z.number(),
	ZERO_Score_1: z.number(),
	Faction_2: z.string(),
	SubFac_2: z.string(),
	Logistics_2: z.number(),
	Transportation_2: z.number(),
	'Anti-Infantry_2': z.number(),
	Armor_2: z.number(),
	ZERO_Score_2: z.number(),
	Balance_Differential: z.number(),
	'Asymmetry Score': z.number(),
})

function processLayer(rawLayer: z.infer<typeof RawLayerSchema>, numRecords: number): M.Layer {
	const { gamemode, version } = M.parseLayerString(rawLayer.Layer)
	const id = M.getLayerId({
		Level: rawLayer.Level,
		Gamemode: gamemode,
		LayerVersion: version,
		Faction_1: rawLayer.Faction_1,
		SubFac_1: rawLayer.SubFac_1,
		Faction_2: rawLayer.Faction_2,
		SubFac_2: rawLayer.SubFac_2,
	})

	return {
		id,
		randomOrdinal: Math.floor(Math.random() * numRecords),
		Level: rawLayer.Level,
		Layer: rawLayer.Layer,
		Size: rawLayer.Size,
		Gamemode: gamemode,
		LayerVersion: version,
		Faction_1: rawLayer.Faction_1,
		SubFac_1: rawLayer.SubFac_1 as C.Subfaction,
		Logistics_1: rawLayer.Logistics_1,
		Transportation_1: rawLayer.Transportation_1,
		'Anti-Infantry_1': rawLayer['Anti-Infantry_1'],
		Armor_1: rawLayer.Armor_1,
		ZERO_Score_1: rawLayer.ZERO_Score_1,
		Faction_2: rawLayer.Faction_2,
		SubFac_2: rawLayer.SubFac_2 as C.Subfaction,
		Logistics_2: rawLayer.Logistics_2,
		Transportation_2: rawLayer.Transportation_2,
		'Anti-Infantry_2': rawLayer['Anti-Infantry_2'],
		Armor_2: rawLayer.Armor_2,
		ZERO_Score_2: rawLayer.ZERO_Score_2,
		Balance_Differential: rawLayer.Balance_Differential,
		'Asymmetry Score': rawLayer['Asymmetry Score'],
		Logistics_Diff: rawLayer.Logistics_1 - rawLayer.Logistics_2,
		Transportation_Diff: rawLayer.Transportation_1 - rawLayer.Transportation_2,
		'Anti-Infantry_Diff': rawLayer['Anti-Infantry_1'] - rawLayer['Anti-Infantry_2'],
		Armor_Diff: rawLayer.Armor_1 - rawLayer.Armor_2,
		ZERO_Score_Diff: rawLayer.ZERO_Score_1 - rawLayer.ZERO_Score_2,
	}
}

async function main() {
	const t0 = performance.now()
	const csvData = fs.readFileSync('layers.csv', 'utf8')
	const records = parse(csvData, { columns: true, skip_empty_lines: true }) as Record<string, string>[]
	const t1 = performance.now()
	const elapsedSecondsParse = (t1 - t0) / 1000

	if (records.length === 0) {
		throw new Error('No records found in CSV file')
	}

	const originalNumericFields = [...M.COLUMN_TYPE_MAPPINGS.float, ...M.COLUMN_TYPE_MAPPINGS.integer].filter((field) => field in records[0])
	const processedLayers = records.map((record, index) => {
		const updatedRecord = { ...record } as { [key: string]: number | string }
		originalNumericFields.forEach((field) => {
			if (!record[field]) {
				throw new Error(`Missing value for field ${field}: rowIndex: ${index + 1} row: ${JSON.stringify(record)}`)
			}
			if (M.COLUMN_KEY_TO_TYPE[field] === 'integer') updatedRecord[field] = parseInt(record[field])
			else updatedRecord[field] = parseFloat(record[field])
			if (isNaN(updatedRecord[field] as number)) {
				throw new Error(`Invalid value for field ${field}: ${record[field]} rowIndex: ${index + 1} row: ${JSON.stringify(record)}`)
			}
		})

		const validatedRawLayer = RawLayerSchema.parse(updatedRecord)
		return processLayer(validatedRawLayer, records.length)
	})
	console.log(`Parsing CSV took ${elapsedSecondsParse} s`)

	const t2 = performance.now()

	// truncate the table
	console.log('Truncating layers table')
	await db.execute(sql`
	TRUNCATE TABLE ${Schema.layers}

	`)
	console.log('layers table truncated')
	console.log('inserting layers')
	// Insert the processed layers
	const chunkSize = 2500
	for (let i = 0; i < processedLayers.length; i += chunkSize) {
		const chunk = processedLayers.slice(i, i + chunkSize)
		await db.insert(Schema.layers).values(chunk)
		console.log(`Inserted ${i + chunk.length} rows`)
	}

	// add jensens range layers
	const extraJensensLayers: M.Layer[] = [
		'JensensRange_ADF-PLA',
		'JensensRange_BAF-IMF',
		'JensensRange_CAF-INS',
		'JensensRange_PLANMC-VDV',
		'JensensRange_USA-RGF',
		'JensensRange_USA-TLF',
		'JensensRange_USMC-MEA',
	].map((layer) => {
		const [level, factions] = layer.split('_')
		const [faction1, faction2] = factions.split('-')
		return {
			id: M.getLayerId({
				Level: level,
				Gamemode: 'Training',
				LayerVersion: null,
				Faction_1: faction1,
				SubFac_1: null,
				Faction_2: faction2,
				SubFac_2: null,
			}),
			randomOrdinal: Math.floor(Math.random() * processedLayers.length),
			Level: level,
			Layer: layer,
			Size: 'Small',
			Gamemode: 'Training',
			LayerVersion: null,
			Faction_1: faction1,
			SubFac_1: null,
			Faction_2: faction2,
			SubFac_2: null,
			Logistics_1: 0,
			Transportation_1: 0,
			'Anti-Infantry_1': 0,
			Armor_1: 0,
			ZERO_Score_1: 0,
			Logistics_2: 0,
			Transportation_2: 0,
			'Anti-Infantry_2': 0,
			Armor_2: 0,
			ZERO_Score_2: 0,
			Balance_Differential: 0,
			'Asymmetry Score': 0,
			Logistics_Diff: 0,
			Transportation_Diff: 0,
			'Anti-Infantry_Diff': 0,
			Armor_Diff: 0,
			ZERO_Score_Diff: 0,
		}
	})

	await db.insert(Schema.layers).values(extraJensensLayers)
	console.log(`Inserted ${extraJensensLayers.length} extra Jensen's Range layers`)

	const t3 = performance.now()
	const elapsedSecondsInsert = (t3 - t2) / 1000
	console.log(`Inserting ${processedLayers.length} rows took ${elapsedSecondsInsert} s`)
}

await main()

process.exit(0)
